#!/usr/bin/env bun

import { isAbsolute, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  answerIsValid,
  parseProviderResponses,
  readBounded,
} from "./workbench"
import { appServerTurnText } from "./codex-app-server-provider"
import { StructuredPreviewProjector } from "./structured-preview"

const PROTOCOL_MAX_BYTES = 8 * 1024 * 1024
const PROTOCOL_LINE_MAX_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"])
export const normalizeClaudeModel = (model: string) => ({
  fable: "claude-fable-5",
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
}[model] ?? model)
const SAFE_SETTING = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
type CandidateCount = 1 | 2 | 3 | 4 | 5

type Json = Record<string, any>

class ProviderFailure extends Error {
  constructor(readonly code: number) {
    super(`provider failed (${code})`)
  }
}

const fail = (code: number): never => {
  throw new ProviderFailure(code)
}

export function claudeArgs(
  workdir: string,
  model: string,
  effort: string,
  prompt: string,
  resumeId?: string,
): string[] {
  model = normalizeClaudeModel(model)
  const settings = JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: [workdir] },
    },
  })
  return [
    "claude",
    "-p",
    "--safe-mode",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    "manual",
    "--disable-slash-commands",
    "--no-chrome",
    "--tools",
    "Read,Glob,Grep",
    "--disallowedTools",
    "Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch,Agent",
    "--settings",
    settings,
    "--system-prompt",
    "You are ShellQ's read-only repository assistant. Answer directly and use only the provided read-only tools when useful.",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(resumeId ? ["--resume", resumeId] : []),
    prompt,
  ]
}

export function claudeSandboxAvailable(): boolean {
  if (process.platform !== "darwin") return false
  return Bun.spawnSync(
    [
      "/usr/bin/sandbox-exec",
      "-p",
      "(version 1)(allow default)",
      "/usr/bin/true",
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  ).exitCode === 0
}

const joinBytes = (left: Uint8Array, right: Uint8Array) => {
  const joined = new Uint8Array(left.byteLength + right.byteLength)
  joined.set(left)
  joined.set(right, left.byteLength)
  return joined
}

export async function readClaudeStream(
  stream: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  expected: { cwd: string; model: string },
  onSessionId?: (sessionId: string) => void,
  mode: "ask" | "generate" | "correct" = "ask",
  expectedSessionId?: string,
  candidateCount: CandidateCount = 1,
): Promise<string> {
  const reader = stream.getReader()
  let pending = new Uint8Array()
  let total = 0
  let sessionId = ""
  let result: string | null = null
  const textBlocks = new Set<number>()

  const accept = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(66)
    const event = value as Json
    if (event.type === "system" && event.subtype === "init") {
      if (
        sessionId ||
        typeof event.session_id !== "string" ||
        (expectedSessionId !== undefined && event.session_id !== expectedSessionId) ||
        event.cwd !== expected.cwd ||
        event.model !== expected.model ||
        !Array.isArray(event.tools) ||
        event.tools.slice().sort().join(",") !== "Glob,Grep,Read" ||
        !Array.isArray(event.mcp_servers) ||
        event.mcp_servers.length !== 0 ||
        !Array.isArray(event.slash_commands) ||
        event.slash_commands.length !== 0 ||
        !Array.isArray(event.skills) ||
        event.skills.length !== 0
      ) {
        fail(65)
      }
      sessionId = event.session_id
      onSessionId?.(sessionId)
      return
    }
    if (!sessionId || event.session_id !== sessionId) fail(66)
    if (
      event.type === "system" ||
      event.type === "assistant" ||
      event.type === "user" ||
      event.type === "rate_limit_event"
    ) {
      return
    }
    if (event.type === "stream_event") {
      if (event.parent_tool_use_id !== null) fail(66)
      const streamEvent = event.event
      if (!streamEvent || typeof streamEvent !== "object") fail(66)
      if (streamEvent.type === "message_start") {
        textBlocks.clear()
        return
      }
      if (streamEvent.type === "content_block_start") {
        if (!Number.isInteger(streamEvent.index)) fail(66)
        if (streamEvent.content_block?.type === "text") {
          textBlocks.add(streamEvent.index)
        }
        return
      }
      if (streamEvent.type === "content_block_delta") {
        if (streamEvent.delta?.type === "text_delta") {
          if (
            !textBlocks.has(streamEvent.index) ||
            typeof streamEvent.delta.text !== "string"
          ) {
            fail(66)
          }
          onDelta(streamEvent.delta.text)
        }
        return
      }
      if (streamEvent.type === "content_block_stop") {
        textBlocks.delete(streamEvent.index)
        return
      }
      if (streamEvent.type === "message_delta") return
      if (streamEvent.type === "message_stop") {
        textBlocks.clear()
        return
      }
      fail(66)
    }
    if (event.type === "result") {
      if (
        result !== null ||
        event.is_error !== false ||
        event.subtype !== "success" ||
        (mode === "ask"
          ? !answerIsValid(event.result)
          : parseProviderResponses(String(event.result), mode === "generate", candidateCount) === null)
      ) {
        fail(67)
      }
      result = event.result
      return
    }
    fail(66)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > PROTOCOL_MAX_BYTES) fail(66)
      pending = joinBytes(pending, value)
      while (true) {
        const newline = pending.indexOf(10)
        if (newline < 0) break
        if (newline > PROTOCOL_LINE_MAX_BYTES) fail(66)
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (!line.byteLength) continue
        try {
          accept(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
          )
        } catch (error) {
          if (error instanceof ProviderFailure) throw error
          fail(66)
        }
      }
      if (pending.byteLength > PROTOCOL_LINE_MAX_BYTES) fail(66)
    }
    if (pending.byteLength) fail(66)
    if (result === null) fail(67)
    return result!
  } finally {
    reader.releaseLock()
  }
}

const waitForExit = async (
  child: Bun.Subprocess,
  milliseconds: number,
): Promise<number | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), milliseconds)
    void child.exited.then((code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })

async function main(): Promise<void> {
  const request = JSON.parse(await Bun.stdin.text()) as Json
  const mode = request.mode
  if (mode !== "ask" && mode !== "generate" && mode !== "correct") fail(64)
  const candidateCount = Number.isInteger(request.candidate_count) && request.candidate_count >= 1 && request.candidate_count <= 5
    ? request.candidate_count as CandidateCount
    : request.candidate_count === undefined
      ? 1
      : fail(64)
  if (mode === "ask" && candidateCount > 1) fail(64)
  const ask = mode === "ask"
  const workdir = ask ? process.env.SHELLQ_CLAUDE_WORKDIR ?? "" : realpathSync(tmpdir())
  const model = normalizeClaudeModel(process.env.SHELLQ_CLAUDE_MODEL ?? "claude-sonnet-5")
  const effort = process.env.SHELLQ_CLAUDE_REASONING ?? "low"
  const previewValue = process.env.SHELLQ_STREAM_PREVIEW
  const previewEnabled = previewValue === "1"
  const sessionFile = ask ? process.env.SHELLQ_CLAUDE_SESSION_FILE ?? "" : ""
  const pendingFile = ask ? process.env.SHELLQ_ASK_PENDING_FILE ?? "" : ""
  const newSession = ask && process.env.SHELLQ_CLAUDE_NEW_SESSION === "1"
  const suppliedResumeId = ask ? process.env.SHELLQ_CLAUDE_SESSION_ID ?? "" : ""
  const timeoutValue = Number(process.env.SHELLQ_CLAUDE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null
  let cancelledCode = 0
  let turnTimer: Timer | undefined
  const projector = ask ? null : new StructuredPreviewProjector(mode, candidateCount)

  const cancel = (code: number) => {
    if (cancelledCode) return
    cancelledCode = code
    child?.kill("SIGTERM")
  }
  process.once("SIGINT", () => cancel(130))
  process.once("SIGTERM", () => cancel(143))

  try {
    if (
      !isAbsolute(workdir) ||
      !statSync(workdir).isDirectory() ||
      !SAFE_SETTING.test(model) ||
      !EFFORTS.has(effort) ||
      (ask && previewValue !== undefined && previewValue !== "1") ||
      !Number.isFinite(timeoutValue) ||
      timeoutValue < 100 ||
      timeoutValue > 300_000
    ) {
      fail(64)
    }
    if (!claudeSandboxAvailable()) fail(66)
    const prompt = appServerTurnText(request)
    if (
      !ask &&
      (process.env.SHELLQ_CLAUDE_SESSION_FILE ||
        process.env.SHELLQ_CLAUDE_SESSION_ID ||
        process.env.SHELLQ_CLAUDE_NEW_SESSION ||
        process.env.SHELLQ_ASK_PENDING_FILE)
    ) fail(64)
    if (sessionFile) {
      if (newSession === Boolean(suppliedResumeId) ||
        (suppliedResumeId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(suppliedResumeId))) {
        fail(64)
      }
      if (newSession ? !pendingFile : Boolean(pendingFile)) fail(64)
    } else if (suppliedResumeId || newSession || pendingFile) {
      fail(64)
    }
    let resumeId = suppliedResumeId
    child = Bun.spawn(claudeArgs(workdir, model, effort, prompt, resumeId || undefined), {
      cwd: workdir,
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    turnTimer = setTimeout(() => {
      if (!cancelledCode) cancelledCode = 68
      child?.kill("SIGTERM")
    }, timeoutValue)
    const [answer, , exitCode] = await Promise.all([
      readClaudeStream(
        child.stdout,
        (text) => {
          if (previewEnabled && !cancelledCode) {
            if (projector) {
              for (const event of projector.push(text)) process.stdout.write(`${JSON.stringify(event)}\n`)
            } else {
              process.stdout.write(`${JSON.stringify({ t: "delta", text })}\n`)
            }
          }
        },
        { cwd: workdir, model },
        (id) => {
          if (!resumeId) resumeId = id
        },
        mode,
        suppliedResumeId || undefined,
        candidateCount,
      ),
      readBounded(child.stderr, 4_096).catch(() => ""),
      child.exited,
    ])
    clearTimeout(turnTimer)
    turnTimer = undefined
    if (cancelledCode) fail(cancelledCode)
    if (exitCode !== 0) fail(66)
    if (sessionFile && pendingFile && !resumeId) fail(67)
    if (sessionFile && pendingFile && newSession) {
      const dir = dirname(sessionFile)
      if (!isAbsolute(sessionFile)) fail(64)
      try {
        if (!lstatSync(dir).isDirectory()) fail(64)
      } catch {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
      if (!lstatSync(dir).isDirectory()) fail(64)
      const temp = `${pendingFile}.${randomUUID()}.tmp`
      writeFileSync(
        temp,
        JSON.stringify({ provider: "claude", session_id: resumeId, cwd: workdir }),
        { mode: 0o600 },
      )
      chmodSync(temp, 0o600)
      renameSync(temp, pendingFile)
    }
    if (ask) {
      process.stdout.write(JSON.stringify({ answer }))
    } else {
      const responses = parseProviderResponses(answer, mode === "generate", candidateCount)
      if (!responses) return fail(67)
      process.stdout.write(JSON.stringify(candidateCount > 1 ? { candidates: responses } : responses[0]))
    }
  } catch (error) {
    if (turnTimer) clearTimeout(turnTimer)
    const code =
      cancelledCode || (error instanceof ProviderFailure ? error.code : 66)
    if (child && (await waitForExit(child, 250)) === null) {
      child.kill("SIGTERM")
      if ((await waitForExit(child, 750)) === null) child.kill("SIGKILL")
    }
    process.exitCode = code
  }
}

if (import.meta.main) await main()
