import { prepareAppServerLaunch, appServerConfig, validateConfigRead, extractSkillPaths, validateInstructionSources, APP_SERVER_BASE_INSTRUCTIONS, APP_SERVER_ASK_INSTRUCTIONS, AppServerIsolationFailure, type AppServerLaunch } from "./codex-app-server-isolation"
import {
  APP_SERVER_ARGS,
  EFFORTS,
  PROTOCOL_LINE_MAX_BYTES,
  ProviderFailure,
  TURN_TIMEOUT_MS,
  UUID,
  appServerTurnText,
  assertEffectivePolicy,
  routineNotificationMatches,
  safeSetting,
  stagePointer,
} from "./codex-app-server-provider"
import { sanitizeContext, type AskPreviewEvent, type SessionIntent } from "./workbench"
import { realpathSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute } from "node:path"

type Json = Record<string, any>
type Phase = "initializing" | "threading" | "idle" | "turning" | "sealing" | "broken" | "disposed"

export type AppServerIdentity = {
  workdir: string
  model: string
  effort: string
  threadId?: string | null
  sessionFile?: string
}

type Pending = {
  errorCode: number
  reject: (error: ProviderFailure) => void
  resolve: (result: Json) => void
  timer: Timer
}

type ActiveItem =
  | { type: "agentMessage"; phase: "commentary" | "final_answer" | null }
  | { type: "commandExecution" }

type TurnState = {
  id: string
  threadId: string
  cwd: string
  mode: SessionIntent
  items: Map<string, ActiveItem>
  ignored: Map<string, string>
  activeAgent: string
  finalText: string
  sawFinal: boolean
  configuredToolsNoted: boolean
  pendingAnswer: string
  pendingCost: number
  sentAnswer: boolean
  flushTimer?: Timer
  onPreview: (event: AskPreviewEvent, costBytes: number) => void
  resolve: (answer: string) => void
  reject: (error: ProviderFailure) => void
}

const IGNORED_ITEM_TYPES = new Set([
  "userMessage",
  "reasoning",
  "plan",
  "contextCompaction",
])
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const EARLY_TURN_MAX_BYTES = 256 * 1024
const EARLY_TURN_MAX_MESSAGES = 128
const OUTSTANDING_ITEM_MAX = 128

function fail(code: number): never {
  throw new ProviderFailure(code)
}

function validateIdentity(identity: AppServerIdentity): void {
  try {
    if (
      !isAbsolute(identity.workdir) ||
      !statSync(identity.workdir).isDirectory() ||
      !safeSetting(identity.model) ||
      !EFFORTS.has(identity.effort) ||
      (identity.threadId !== undefined && identity.threadId !== null && !UUID.test(identity.threadId)) ||
      (identity.sessionFile !== undefined && !isAbsolute(identity.sessionFile))
    ) {
      fail(64)
    }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error
    throw new ProviderFailure(64)
  }
}

export function validateAppServerSessionTurn(
  identity: AppServerIdentity,
  request: unknown,
  candidateFile: string | undefined,
  pointerStaged = false,
): string {
  validateIdentity(identity)
  const needsCandidate = identity.threadId === null && !pointerStaged && Boolean(identity.sessionFile)
  if (Boolean(candidateFile) !== needsCandidate) fail(64)
  if (
    candidateFile &&
    (!identity.sessionFile ||
      !isAbsolute(candidateFile) ||
      dirname(candidateFile) !== dirname(identity.sessionFile) ||
      !candidateFile.startsWith(`${identity.sessionFile}.pending-`))
  ) {
    fail(64)
  }
  return appServerTurnText(request)
}

function lineReader(
  stream: ReadableStream<Uint8Array>,
  onLine: (message: Json, costBytes: number) => void,
  onFailure: (code: number) => void,
) {
  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let pending = new Uint8Array()
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) {
          if (pending.byteLength) fail(66)
          onFailure(66)
          return
        }
        const joined = new Uint8Array(pending.byteLength + result.value.byteLength)
        joined.set(pending)
        joined.set(result.value, pending.byteLength)
        pending = joined
        while (true) {
          const newline = pending.indexOf(10)
          if (newline < 0) break
          if (newline > PROTOCOL_LINE_MAX_BYTES) fail(66)
          const raw = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!raw.byteLength) continue
          const message = JSON.parse(decoder.decode(raw))
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            fail(66)
          }
          onLine(message, raw.byteLength + 1)
        }
        if (pending.byteLength > PROTOCOL_LINE_MAX_BYTES) fail(66)
      }
    } catch {
      onFailure(66)
    } finally {
      reader.releaseLock()
    }
  })()
}

export class AppServerSession {
  readonly startedNewThread: boolean
  threadId = ""

  get pid(): number {
    return this.child.pid
  }

  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">
  private readonly identity: AppServerIdentity
  private readonly launch: AppServerLaunch
  private readonly ephemeralCwd: string
  private phase: Phase = "initializing"
  private nextId = 1
  private pending = new Map<number, Pending>()
  private turn: TurnState | null = null
  private earlyTurnMessages: Array<{ message: Json; costBytes: number }> = []
  private earlyTurnBytes = 0
  private pendingMcpThreadId = ""
  private pendingThreadId = ""
  private recentEphemeralThreadIds: string[] = []
  private disposePromise: Promise<void> | null = null
  private termNotBefore = 0
  private pointerStaged = false
  private pointerCandidateFile = ""
  private askPreparationFailureCode = 0

  constructor(identity: AppServerIdentity) {
    validateIdentity(identity)
    this.identity = identity
    this.startedNewThread = identity.threadId === null
    try { this.launch = prepareAppServerLaunch() } catch (error) {
      throw new ProviderFailure(error instanceof AppServerIsolationFailure ? error.code : 66)
    }
    this.ephemeralCwd = this.launch.ephemeralCwd
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">
    try {
      child = Bun.spawn([...APP_SERVER_ARGS], {
        cwd: identity.workdir,
        env: this.launch.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch {
      throw new ProviderFailure(64)
    }
    this.child = child
    lineReader(
      this.child.stdout,
      (message, costBytes) => this.receive(message, costBytes),
      (code) => this.failSession(code),
    )
    void (async () => {
      const reader = child.stderr.getReader()
      try {
        while (!(await reader.read()).done) {}
      } catch {
        this.failSession(66)
      } finally {
        reader.releaseLock()
      }
    })()
    void this.child.exited.then(() => {
      if (this.phase !== "disposed") this.failSession(66)
    })
  }

  matches(identity: AppServerIdentity): boolean {
    return (
      this.isLiveIdle() &&
      (identity.threadId === undefined
        ? this.identity.threadId === undefined && !this.threadId
        : this.threadId === identity.threadId ||
          (identity.threadId === this.identity.threadId &&
            this.askPreparationFailureCode === 69 &&
            !this.threadId) ||
          (identity.threadId === null && this.startedNewThread && !this.pointerStaged)) &&
      this.identity.workdir === identity.workdir &&
      this.identity.model === identity.model &&
      this.identity.effort === identity.effort &&
      this.identity.sessionFile === identity.sessionFile
    )
  }

  async ready(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.failSession(130)
      throw new ProviderFailure(130)
    }
    const stop = this.watchAbort(signal)
    try {
      await this.request(
        "initialize",
        {
          clientInfo: { name: "shellq", title: "shellq", version: "0.0.0" },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: [
              "item/reasoning/textDelta",
              "item/reasoning/summaryTextDelta",
              "item/reasoning/summaryPartAdded",
              "thread/tokenUsage/updated",
              "turn/plan/updated",
              "item/plan/delta",
            ],
          },
        },
        10_000,
        64,
      )
      this.send({ method: "initialized", params: {} })
      validateConfigRead(await this.request("config/read", { cwd: this.identity.workdir, includeLayers: true }, 10_000, 66), this.identity.workdir, this.launch.config)
      this.phase = "idle"
      if (this.identity.threadId !== undefined) {
        try {
          await this.prepareAskThread()
        } catch (error) {
          if (
            this.identity.threadId &&
            error instanceof ProviderFailure &&
            error.code === 69
          ) {
            this.askPreparationFailureCode = 69
            this.phase = "idle"
          } else {
            throw error
          }
        }
      }
    } catch (error) {
      const failure =
        error instanceof ProviderFailure ? error : new ProviderFailure(error instanceof AppServerIsolationFailure ? error.code : 66)
      this.failSession(failure.code)
      throw failure
    } finally {
      stop()
    }
  }

  async listModels(signal: AbortSignal): Promise<unknown[]> {
    if (this.phase !== "idle" || this.identity.threadId !== undefined) fail(66)
    const stop = this.watchAbort(signal)
    const models: unknown[] = []
    const cursors = new Set<string>()
    const deadline = Date.now() + 5_000
    let cursor: string | null = null
    try {
      for (let page = 0; page < 10; page += 1) {
        const params = {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        }
        const result = await this.request(
          "model/list",
          params,
          Math.max(1, deadline - Date.now()),
          68,
        )
        if (!result || typeof result !== "object" || Array.isArray(result)) fail(66)
        const data = (result as Record<string, unknown>).data
        const nextCursor = (result as Record<string, unknown>).nextCursor
        if (
          !Array.isArray(data) ||
          data.length > 100 ||
          (nextCursor !== null &&
            (typeof nextCursor !== "string" ||
              new TextEncoder().encode(nextCursor).byteLength > 4_096 ||
              cursors.has(nextCursor)))
        ) fail(66)
        models.push(...data)
        if (models.length > 1_000) fail(66)
        if (nextCursor === null) return models
        cursors.add(nextCursor)
        cursor = nextCursor
      }
      fail(66)
    } finally {
      stop()
    }
  }

  private async prepareAskThread(): Promise<void> {
    const result = await this.startThread({
      cwd: this.identity.workdir,
      ephemeral: false,
      resumeId: this.identity.threadId ?? undefined,
      developerInstructions:
        APP_SERVER_ASK_INSTRUCTIONS,
    })
    if (this.phase !== "threading") fail(66)
    this.threadId = result
    this.pendingMcpThreadId = ""
    this.pendingThreadId = ""
    this.phase = "idle"
  }

  private startEphemeralThread(): Promise<string> {
    return this.startThread({
      cwd: this.ephemeralCwd,
      ephemeral: true,
      developerInstructions:
        "Return only the requested JSON. Do not use tools, inspect files, execute commands, access the network, or call configured external tools.",
    }).then((threadId) => {
      if (this.phase !== "threading") fail(66)
      if (
        threadId === this.threadId ||
        this.recentEphemeralThreadIds.includes(threadId)
      ) fail(66)
      return threadId
    })
  }

  private async startThread(options: {
    cwd: string
    ephemeral: boolean
    resumeId?: string
    developerInstructions: string
  }): Promise<string> {
    this.phase = "threading"
    this.pendingMcpThreadId = ""
    this.pendingThreadId = ""
    validateConfigRead(await this.request("config/read", { cwd: options.cwd, includeLayers: true }, 10_000, 66), options.cwd, this.launch.config)
    const skills = extractSkillPaths(await this.request("skills/list", { cwds: [options.cwd], forceReload: true }, 10_000, 66), options.cwd)
    const params = {
      baseInstructions: APP_SERVER_BASE_INSTRUCTIONS,
      model: this.identity.model,
      cwd: options.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: appServerConfig(options.ephemeral ? "command" : "ask", this.identity.effort, skills),
      developerInstructions: options.developerInstructions,
    }
    const result = await this.request(
      options.resumeId ? "thread/resume" : "thread/start",
      options.resumeId
        ? { threadId: options.resumeId, ...params }
        : { ...params, ephemeral: options.ephemeral },
      20_000,
      options.resumeId ? 69 : 64,
    )
    const threadId = assertEffectivePolicy(
      result,
      options.cwd,
      this.identity.model,
      this.identity.effort,
      options.resumeId,
      options.ephemeral,
    )
    if (this.pendingMcpThreadId && this.pendingMcpThreadId !== threadId) fail(66)
    if (this.pendingThreadId && this.pendingThreadId !== threadId) fail(66)
    // Keep startup in threading until the caller publishes the validated identity.
    this.pendingMcpThreadId = threadId
    this.pendingThreadId = threadId
    return threadId
  }

  async runTurn(
    request: unknown,
    options: {
      candidateFile?: string
      mode?: SessionIntent
      onPreview: (event: AskPreviewEvent, costBytes: number) => void
      signal: AbortSignal
    },
  ): Promise<{ answer: string }> {
    if (this.phase !== "idle") fail(66)
    if (options.signal.aborted) {
      this.failSession(130)
      throw new ProviderFailure(130)
    }
    const mode = options.mode ?? "ask"
    const text = mode === "ask"
      ? validateAppServerSessionTurn(
          this.identity,
          request,
          options.candidateFile,
          this.pointerStaged,
        )
      : appServerTurnText(request)
    const stop = this.watchAbort(options.signal)
    try {
      let threadId = this.threadId
      let cwd = this.identity.workdir
      if (mode === "ask") {
        if (!threadId) fail(this.askPreparationFailureCode || 64)
      } else {
        threadId = await this.startEphemeralThread()
        if ((this.phase as Phase) !== "threading") fail(66)
        cwd = this.ephemeralCwd
      }
      this.phase = "turning"
      const done = new Promise<string>((resolve, reject) => {
        this.turn = {
          id: "",
          threadId,
          cwd,
          mode,
          items: new Map(),
          ignored: new Map(),
          activeAgent: "",
          finalText: "",
          sawFinal: false,
          configuredToolsNoted: false,
          pendingAnswer: "",
          pendingCost: 0,
          sentAnswer: false,
          onPreview: options.onPreview,
          resolve,
          reject,
        }
      })
      void done.catch(() => {})
      const result = await this.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          cwd,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          model: this.identity.model,
          effort: this.identity.effort,
        },
        20_000,
        66,
      )
      const turnId = result?.turn?.id
      if (typeof turnId !== "string" || !UUID.test(turnId) || !this.turn) fail(66)
      this.turn.id = turnId
      this.pendingMcpThreadId = ""
      this.pendingThreadId = ""
      const early = this.earlyTurnMessages
      this.earlyTurnMessages = []
      this.earlyTurnBytes = 0
      for (const entry of early) this.receiveNotification(entry.message, entry.costBytes)
      const answer = await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new ProviderFailure(68)), TURN_TIMEOUT_MS)
          void done.then(
            () => clearTimeout(timer),
            () => clearTimeout(timer),
          )
        }),
      ])
      // Give an EOF queued with the seal response one event-loop turn to retire the child.
      await Bun.sleep(5)
      if (!this.isLiveIdle()) fail(66)
      if (mode === "ask" && this.startedNewThread && options.candidateFile) {
        stagePointer(options.candidateFile, this.identity.workdir, this.threadId)
        this.pointerStaged = true
        this.pointerCandidateFile = options.candidateFile
      }
      return { answer }
    } catch (error) {
      const failure =
        error instanceof ProviderFailure ? error : new ProviderFailure(error instanceof AppServerIsolationFailure ? error.code : 66)
      this.failSession(failure.code)
      throw failure
    } finally {
      stop()
    }
  }

  discardStagedPointer(candidateFile: string): void {
    if (this.startedNewThread && this.pointerCandidateFile === candidateFile) {
      this.pointerStaged = false
      this.pointerCandidateFile = ""
    }
  }

  disposeSync(): void {
    if (this.phase === "disposed") return
    this.phase = "disposed"
    const error = new ProviderFailure(130)
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    this.rejectTurn(error)
    try {
      this.child.stdin.end()
    } catch {}
    try {
      this.child.kill("SIGTERM")
    } catch {}
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = (async () => {
      const delay = Math.max(0, this.termNotBefore - Date.now())
      if (delay) await Bun.sleep(delay)
      this.disposeSync()
      const exited = await Promise.race([
        this.child.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ])
      if (!exited) {
        try {
          this.child.kill("SIGKILL")
        } catch {}
        await this.child.exited
      }
    })()
    return this.disposePromise
  }

  private watchAbort(signal: AbortSignal): () => void {
    const abort = () => this.failSession(130)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    return () => signal.removeEventListener("abort", abort)
  }

  private isLiveIdle(): boolean {
    return this.phase === "idle" && this.child.exitCode === null
  }

  private send(message: unknown): void {
    if (this.phase === "broken" || this.phase === "disposed") fail(66)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
    this.child.stdin.flush()
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    errorCode: number,
  ): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ProviderFailure(68))
      }, timeoutMs)
      this.pending.set(id, { errorCode, reject, resolve, timer })
      try {
        this.send({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof ProviderFailure ? error : new ProviderFailure(errorCode))
      }
    })
  }

  private receive(message: Json, costBytes: number): void {
    try {
      if (message.id !== undefined) {
        if (message.method !== undefined) {
          try {
            this.send({
              id: message.id,
              error: { code: -32601, message: "shellq refuses server requests" },
            })
          } catch {}
          fail(66)
        }
        const pending = this.pending.get(message.id)
        if (!pending) fail(66)
        clearTimeout(pending.timer)
        this.pending.delete(message.id)
        if (message.error || message.result === undefined) {
          pending.reject(new ProviderFailure(pending.errorCode))
        } else {
          pending.resolve(message.result)
        }
        return
      }
      if (typeof message.method !== "string") fail(66)
      this.receiveNotification(message, costBytes)
    } catch (error) {
      this.failSession(error instanceof ProviderFailure ? error.code : 66)
    }
  }

  private receiveNotification(message: Json, costBytes: number): void {
    if (message.method === "mcpServer/startupStatus/updated") fail(66)
    if (this.phase === "initializing") {
      if (
        message.method === "remoteControl/status/changed" ||
        message.method === "account/rateLimits/updated" ||
        message.method === "account/updated"
      ) {
        if (!routineNotificationMatches(message, "", "")) fail(66)
        return
      }
      if (["warning", "configWarning", "deprecationNotice"].includes(message.method)) {
        if (!routineNotificationMatches(message, "", "")) fail(66)
        return
      }
      fail(66)
    }
    if (this.phase === "threading") {
      if (message.method === "mcpServer/startupStatus/updated") {
        const id = message.params?.threadId
        if (typeof id !== "string" || !UUID.test(id)) fail(66)
        if (
          (id === this.threadId || this.recentEphemeralThreadIds.includes(id)) &&
          routineNotificationMatches(message, id, "")
        ) return
        if (this.pendingMcpThreadId && this.pendingMcpThreadId !== id) fail(66)
        if (!routineNotificationMatches(message, id, "")) fail(66)
        this.pendingMcpThreadId = id
        return
      }
      if (
        message.method === "remoteControl/status/changed" ||
        message.method === "account/rateLimits/updated" ||
        message.method === "account/updated"
      ) {
        if (!routineNotificationMatches(message, "", "")) fail(66)
        return
      }
      if (message.method === "thread/started") {
        const id = message.params?.thread?.id
        if (typeof id !== "string" || !UUID.test(id)) fail(66)
        if (this.pendingThreadId && this.pendingThreadId !== id) fail(66)
        this.pendingThreadId = id
        return
      }
      if (message.method === "thread/status/changed") {
        const id = message.params?.threadId
        if (typeof id !== "string" || !UUID.test(id)) fail(66)
        if (id === this.threadId && routineNotificationMatches(message, id, "")) return
        if (this.pendingThreadId && this.pendingThreadId !== id) fail(66)
        this.pendingThreadId = id
        return
      }
      if (["warning", "configWarning", "deprecationNotice"].includes(message.method)) {
        if (!routineNotificationMatches(message, "", "")) fail(66)
        return
      }
      fail(66)
    }
    if (this.phase === "idle") {
      if (message.method === "thread/settings/updated") fail(66)
      const id = message.params?.threadId
      if (
        message.method === "mcpServer/startupStatus/updated" &&
        typeof id === "string" &&
        this.recentEphemeralThreadIds.includes(id) &&
        routineNotificationMatches(message, id, "")
      ) {
        return
      }
      if (!routineNotificationMatches(message, this.threadId, "")) fail(66)
      return
    }
    if (this.phase !== "turning" && this.phase !== "sealing") fail(66)
    if (!this.turn) fail(66)
    if (!this.turn.id) {
      this.earlyTurnBytes += costBytes
      if (
        this.earlyTurnMessages.length >= EARLY_TURN_MAX_MESSAGES ||
        this.earlyTurnBytes > EARLY_TURN_MAX_BYTES
      ) {
        fail(66)
      }
      this.earlyTurnMessages.push({ message, costBytes })
      return
    }
    const turn = this.turn
    if (message.method === "thread/settings/updated") fail(66)
    const backgroundThreadId = message.params?.threadId
    if (
      message.method === "mcpServer/startupStatus/updated" &&
      typeof backgroundThreadId === "string" &&
      backgroundThreadId !== turn.threadId &&
      (backgroundThreadId === this.threadId ||
        this.recentEphemeralThreadIds.includes(backgroundThreadId)) &&
      routineNotificationMatches(message, backgroundThreadId, "")
    ) {
      return
    }
    if (routineNotificationMatches(message, turn.threadId, turn.id)) {
      if (message.method === "mcpServer/startupStatus/updated" && !turn.configuredToolsNoted) {
        turn.configuredToolsNoted = true
        turn.onPreview({ t: "note", text: "Starting configured tools" }, costBytes)
      }
      return
    }
    if (this.phase === "sealing") fail(66)
    const params = message.params
    if (
      !params ||
      params.threadId !== turn.threadId ||
      (message.method !== "turn/completed" && params.turnId !== turn.id)
    ) {
      fail(66)
    }
    if (message.method === "item/started") {
      const id = params.item?.id
      const type = params.item?.type
      if (
        typeof id !== "string" ||
        id.length > 256 ||
        turn.items.size + turn.ignored.size >= OUTSTANDING_ITEM_MAX ||
        turn.items.has(id) ||
        turn.ignored.has(id)
      ) {
        fail(66)
      }
      if (IGNORED_ITEM_TYPES.has(type)) {
        turn.ignored.set(id, type)
        return
      }
      if (type === "agentMessage") {
        const phase = params.item.phase ?? null
        if (phase !== null && phase !== "commentary" && phase !== "final_answer") fail(66)
        if (turn.activeAgent) fail(66)
        turn.items.set(id, { type, phase })
        turn.activeAgent = id
        if (phase === "commentary") {
          turn.onPreview({ t: "note", text: "Drafting the answer" }, costBytes)
        }
        return
      }
      if (type !== "commandExecution" || turn.mode !== "ask") fail(66)
      turn.items.set(id, { type })
      turn.onPreview({ t: "note", text: "Running a read-only command" }, costBytes)
      return
    }
    if (message.method === "item/agentMessage/delta") {
      const item = turn.items.get(params.itemId)
      if (
        item?.type !== "agentMessage" ||
        params.itemId !== turn.activeAgent ||
        typeof params.delta !== "string"
      ) {
        fail(66)
      }
      if (item.phase === "final_answer") {
        this.queueAnswer(sanitizeContext(params.delta), costBytes)
      }
      return
    }
    if (message.method === "item/commandExecution/outputDelta") {
      const item = turn.items.get(params.itemId)
      if (item?.type !== "commandExecution" || typeof params.delta !== "string") fail(66)
      return
    }
    if (message.method === "item/completed") {
      const id = params.item?.id
      const type = params.item?.type
      if (typeof id !== "string") fail(66)
      if (turn.ignored.get(id) === type) {
        turn.ignored.delete(id)
        return
      }
      const item = turn.items.get(id)
      if (type === "agentMessage" && item?.type === "agentMessage") {
        const phase = params.item.phase ?? item.phase
        if (
          typeof params.item.text !== "string" ||
          (phase !== null && phase !== "commentary" && phase !== "final_answer") ||
          (item.phase !== null && params.item.phase != null && params.item.phase !== item.phase)
        ) {
          fail(66)
        }
        if (phase !== "commentary") {
          turn.finalText = params.item.text
          turn.sawFinal = true
        }
        if (turn.activeAgent === id) turn.activeAgent = ""
        turn.items.delete(id)
        return
      }
      if (type === "commandExecution" && item?.type === "commandExecution") {
        turn.items.delete(id)
        return
      }
      fail(66)
    }
    if (message.method === "turn/failed") fail(66)
    if (message.method === "turn/completed") {
      if (params.turn?.id !== turn.id || params.turn?.status !== "completed" || turn.activeAgent) {
        fail(66)
      }
      this.phase = "sealing"
      void this.sealTurn()
      return
    }
    fail(66)
  }

  private async sealTurn(): Promise<void> {
    try {
      const result = await this.request(
        "thread/read",
        { threadId: this.turn?.threadId, includeTurns: false },
        5_000,
        68,
      )
      const turn = this.turn
      if (
        !turn ||
        result?.thread?.id !== turn.threadId ||
        result.thread?.cwd !== turn.cwd ||
        result.thread?.status?.type !== "idle" ||
        !turn.sawFinal ||
        this.child.exitCode !== null
      ) {
        fail(66)
      }
      this.flushAnswer()
      if (turn.mode !== "ask") {
        this.recentEphemeralThreadIds.push(turn.threadId)
        if (this.recentEphemeralThreadIds.length > 16) {
          this.recentEphemeralThreadIds.shift()
        }
      }
      this.turn = null
      this.phase = "idle"
      turn.resolve(turn.finalText)
    } catch (error) {
      this.failSession(error instanceof ProviderFailure ? error.code : 66)
    }
  }

  private queueAnswer(text: string, costBytes: number): void {
    const turn = this.turn
    if (!turn) return
    turn.pendingAnswer += text
    turn.pendingCost += costBytes
    if (!turn.sentAnswer || bytes(turn.pendingAnswer) > 1_300) this.flushAnswer()
    if (!turn.flushTimer) {
      turn.flushTimer = setTimeout(() => {
        turn.flushTimer = undefined
        if (this.turn === turn) this.flushAnswer()
      }, 50)
    }
  }

  private flushAnswer(): void {
    const turn = this.turn
    if (!turn || !turn.pendingAnswer) return
    if (turn.flushTimer) clearTimeout(turn.flushTimer)
    turn.flushTimer = undefined
    turn.onPreview({ t: "answer", text: turn.pendingAnswer }, turn.pendingCost)
    turn.pendingAnswer = ""
    turn.pendingCost = 0
    turn.sentAnswer = true
  }

  private rejectTurn(error: ProviderFailure): void {
    const turn = this.turn
    this.turn = null
    this.earlyTurnMessages = []
    this.earlyTurnBytes = 0
    if (!turn) return
    if (turn.flushTimer) clearTimeout(turn.flushTimer)
    turn.reject(error)
  }

  private failSession(code: number): void {
    if (this.phase === "broken" || this.phase === "disposed") return
    if (code === 130 && this.turn?.id && this.turn.threadId) {
      try {
        this.child.stdin.write(`${JSON.stringify({
          method: "turn/interrupt",
          id: this.nextId++,
          params: { threadId: this.turn.threadId, turnId: this.turn.id },
        })}\n`)
        this.child.stdin.flush()
        this.termNotBefore = Date.now() + 1_000
      } catch {}
    }
    this.phase = "broken"
    const error = new ProviderFailure(code)
    for (const item of this.pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    this.pending.clear()
    this.rejectTurn(error)
    try {
      this.child.stdin.end()
    } catch {}
    void this.dispose()
  }
}
