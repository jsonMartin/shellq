import { parseLocalEndpoint } from "./local-endpoint"
import { dlopen } from "bun:ffi"
import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  chmodSync,
  closeSync,
  linkSync,
  openSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

export const RESPONSE_MAX_BYTES = 65_536
export const ASK_ANSWER_MAX_BYTES = 8_192
export const ASK_QUERY_MAX_BYTES = 4_096
export const ASK_TURN_LIMIT = 50
export const ASK_PREVIEW_LINE_MAX_BYTES = 8_192
export const ASK_PREVIEW_INPUT_MAX_BYTES = 262_144
const CONTEXT_MAX_BYTES = 16_384
export const CANDIDATE_LIMIT = 5
export type ProviderId = "codex" | "claude" | "local-openai"
export type ProviderTransport = "cli" | "managed"
export type HistoryClass = "native" | "owned" | "none"
export type ProviderSource = "default" | "configured"

export const CODEX_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const
export type CodexEffort = (typeof CODEX_EFFORTS)[number]

export type ModelCapability = {
  id: string
  model: string
  displayName: string
  description: string
  efforts: string[]
  defaultEffort: string
  isDefault: boolean
}

export type ProviderCapabilityCatalog = {
  providerId: ProviderId | "configured"
  source: "codex-model-list" | "explicit"
  models: ModelCapability[]
  stale?: boolean
}

export type CodexDiscoveryState = "loading" | "dynamic" | "fallback"

export const SAFE_MODEL = /^[A-Za-z0-9._:/-]{1,128}$/u
const CONTROL_OR_BIDI = /[\p{Cc}\p{Cf}]/u
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

export const codexInferenceTupleIsTransportSafe = (model: string, effort: string) =>
  SAFE_MODEL.test(model) && (CODEX_EFFORTS as readonly string[]).includes(effort)

export function codexModelFallback(
  models: string[],
  efforts: string[],
): ProviderCapabilityCatalog {
  const safeEfforts = [...new Set(efforts)].filter((effort) =>
    (CODEX_EFFORTS as readonly string[]).includes(effort),
  )
  const normalizedEfforts = safeEfforts.length ? safeEfforts : ["low"]
  return {
    providerId: "codex",
    source: "explicit",
    models: models.filter((model) => SAFE_MODEL.test(model)).map((model, index) => ({
      id: model,
      model,
      displayName: modelLabel(model),
      description: "Explicit Codex fallback",
      efforts: normalizedEfforts,
      defaultEffort: normalizedEfforts[0],
      isDefault: index === 0,
    })),
  }
}

export function explicitModelCatalog(
  providerId: ProviderId | "configured",
  models: string[],
  efforts: string[],
): ProviderCapabilityCatalog {
  const normalizedEfforts = [...new Set(efforts)].filter(Boolean)
  return {
    providerId,
    source: "explicit",
    models: models.map((model, index) => ({
      id: model,
      model,
      displayName: modelLabel(model),
      description: "Explicit provider model",
      efforts: normalizedEfforts,
      defaultEffort: normalizedEfforts[0] ?? "low",
      isDefault: index === 0,
    })),
  }
}

export const LOCAL_CATALOG_MAX_ENTRIES = 512
export const LOCAL_DISCOVERY_MAX_BYTES = 131_072
export const LOCAL_SCAN_MAX_ENDPOINTS = 8
// One scan may carry up to LOCAL_SCAN_MAX_ENDPOINTS full catalogs, so its
// read ceiling scales with the single-catalog bound; a healthy endpoint's
// catalog is never dropped to fit.
export const LOCAL_SCAN_MAX_BYTES = LOCAL_DISCOVERY_MAX_BYTES * LOCAL_SCAN_MAX_ENDPOINTS

// Re-validates what the local adapter already admitted. The adapter drops a
// non-conforming entry and rejects duplicates; this parser refuses the whole
// catalog for anything it did not expect, so a compromised or wrong process on
// stdout cannot widen the model set. Server order and exact IDs are preserved
// because the palette activates the raw catalog value.
export function parseLocalCatalog(
  raw: string,
  efforts: string[],
): ProviderCapabilityCatalog | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.object !== "list" || !Array.isArray(record.data)) return null
  if (record.data.length > LOCAL_CATALOG_MAX_ENTRIES) return null
  const models: string[] = []
  const seen = new Set<string>()
  for (const entry of record.data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const id = (entry as Record<string, unknown>).id
    if (typeof id !== "string" || !SAFE_MODEL.test(id) || seen.has(id)) return null
    seen.add(id)
    models.push(id)
  }
  return explicitModelCatalog(LOCAL_PROVIDER_ID, models, efforts)
}

// Re-validates the scan adapter's whole output against the endpoints the
// parent itself requested: an unknown, duplicated, or malformed entry can
// never widen the probed set or the model list, and every catalog must
// satisfy the same strict grammar as a single-endpoint discovery. Returns
// endpoint -> admitted IDs for the endpoints that answered; an endpoint that
// failed quietly is simply absent.
export function parseLocalScan(
  raw: string,
  requestedEndpoints: readonly string[],
): Map<string, string[]> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.object !== "scan" || !Array.isArray(record.data)) return null
  const allowed = new Set(requestedEndpoints)
  const catalogs = new Map<string, string[]>()
  for (const entry of record.data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null
    const item = entry as Record<string, unknown>
    if (typeof item.endpoint !== "string" || !allowed.has(item.endpoint) || catalogs.has(item.endpoint)) return null
    // One authoritative per-endpoint grammar: the strict single-endpoint
    // catalog parser validates each entry's envelope and model list.
    const catalog = parseLocalCatalog(JSON.stringify(item), [])
    if (!catalog) return null
    catalogs.set(item.endpoint, catalog.models.map((model) => model.model))
  }
  return catalogs
}

// A trust boundary, not tidiness: the adapter is the only ShellQ component
// that speaks HTTP, so it is handed a freshly constructed environment instead
// of the parent's. PATH is required to exec the shim and the `bun` it replaces
// itself with; the SHELLQ_LOCAL_OPENAI_* keys are the adapter's whole
// contract. No proxy, credential, session, or workdir variable is copied even
// when the parent defines one.
export function localAdapterEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  endpoint: string,
  options: { model?: string; mode?: typeof LOCAL_DISCOVER_MODE | typeof LOCAL_SCAN_MODE; thinking?: boolean; preview?: boolean; scanEndpoints?: string[] } = {},
): Record<string, string> {
  const env: Record<string, string> = { PATH: parent.PATH ?? "/usr/bin:/bin" }
  const validated = parseLocalEndpoint(endpoint)
  if (!validated) throw new Error("local endpoint unavailable; configure local endpoint")
  env[LOCAL_ENDPOINT_ENV] = validated.raw
  if (options.mode) env[LOCAL_MODE_ENV] = options.mode
  if (options.scanEndpoints) env[LOCAL_SCAN_ENDPOINTS_ENV] = options.scanEndpoints.join(" ")
  if (typeof options.model === "string") {
    env.SHELLQ_LOCAL_OPENAI_MODEL = options.model
  }
  if (options.thinking !== undefined) env.SHELLQ_LOCAL_OPENAI_THINKING = options.thinking ? "on" : "off"
  if (options.preview) env.SHELLQ_STREAM_PREVIEW = "1"
  return env
}

export function validateCodexModelPages(pages: unknown[]): ModelCapability[] {
  const models: ModelCapability[] = []
  const ids = new Set<string>()
  const requests = new Set<string>()
  for (const page of pages) {
    if (!page || typeof page !== "object" || Array.isArray(page)) {
      throw new Error("invalid Codex model page")
    }
    const item = page as Record<string, unknown>
    const id = item.id
    const model = item.model
    if (item.hidden === true) continue
    if (
      typeof id !== "string" ||
      typeof model !== "string" ||
      !SAFE_MODEL.test(id) ||
      !SAFE_MODEL.test(model) ||
      ids.has(id) ||
      requests.has(model) ||
      typeof item.displayName !== "string" ||
      !item.displayName.trim() ||
      CONTROL_OR_BIDI.test(item.displayName) ||
      byteLength(item.displayName) > 128 ||
      typeof item.description !== "string" ||
      CONTROL_OR_BIDI.test(item.description) ||
      byteLength(item.description) > 512 ||
      !Array.isArray(item.supportedReasoningEfforts) ||
      !item.supportedReasoningEfforts.length ||
      !item.supportedReasoningEfforts.every((effort) =>
        typeof effort === "string" &&
        (CODEX_EFFORTS as readonly string[]).includes(effort),
      ) ||
      typeof item.defaultReasoningEffort !== "string" ||
      !item.supportedReasoningEfforts.includes(item.defaultReasoningEffort)
    ) {
      throw new Error("invalid Codex model")
    }
    const efforts = [...new Set(item.supportedReasoningEfforts)] as string[]
    ids.add(id)
    requests.add(model)
    models.push({
      id,
      model,
      displayName: item.displayName,
      description: item.description,
      efforts,
      defaultEffort: item.defaultReasoningEffort,
      isDefault: item.isDefault === true,
    })
  }
  return models
}

export type ProviderDescriptor = {
  id: ProviderId
  transport: ProviderTransport
  bin: string
  adapter: string
  storeRoot: string
  modes: { ask: boolean; command: boolean; fix: boolean }
  history: HistoryClass
  models: string[]
  reasoningLevels: string[]
  modelEnv: string
  reasoningEnv: string
  workdirEnv: string
  sessionFileEnv: string
  newSessionEnv: string
  modelsEnv: string
}

export const LOCAL_PROVIDER_ID = "local-openai" as const

// Fixed, redacted refusal for a submission without an unblocked exact local
// model preference. Nothing is spawned in that case, so the message must not
// imply a request was tried.
export const LOCAL_NO_ACTIVE_MODEL_DETAIL =
  "no local model is active · check models first"

// Exit codes are the local adapter's closed public failure boundary. Never
// use its stderr (or an unexpected exception) as user-facing detail.
export function localFailureMessage(code: number): string {
  const messages: Record<number, string> = {
    64: "local request is invalid",
    65: "local endpoint is invalid",
    66: "endpoint unreachable · ^X S, type endpoint",
    67: "local authentication is unsupported",
    68: "local protocol mismatch",
    69: "local catalog is malformed",
    70: "local model is gone · check models again",
    71: "local model rejected request · check models again",
    72: "local rate limit · retry manually",
    73: "local server failed · retry manually",
    78: "thinking control unsupported · ^X R selects endpoint default",
    74: "local completion is malformed · check models again",
    75: "local response is too large",
    76: "local request timed out · retry manually",
    77: "local connection lost · retry manually",
    130: "local request cancelled",
    129: "local request cancelled",
    143: "local request cancelled",
  }
  return messages[code] ?? "local request failed"
}

// The workbench resolves the endpoint; the adapter requires that explicit value.
export const LOCAL_ENDPOINT_ENV = "SHELLQ_LOCAL_OPENAI_ENDPOINT"
export const LOCAL_MODE_ENV = "SHELLQ_LOCAL_OPENAI_MODE"
export const LOCAL_DISCOVER_MODE = "discover"
export const LOCAL_SCAN_MODE = "scan"
export const LOCAL_SCAN_ENDPOINTS_ENV = "SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS"

// Automatic palette/Setup discovery probes the effective endpoint plus these
// common literal IPv4 loopback ports — a bounded fixed list, never a port
// scan. TEST-ONLY `SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS` pins the list so
// focused tests never touch the real fixed ports or a live local server.
export const LOCAL_SCAN_PORTS = [1234, 8000, 8080, 8081, 11434]

const scanPorts = (): number[] => {
  const override = process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS
  if (!override) return LOCAL_SCAN_PORTS
  const ports = override
    .split(",")
    .map((port) => Number(port))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
  return ports.length ? ports.slice(0, LOCAL_SCAN_MAX_ENDPOINTS) : LOCAL_SCAN_PORTS
}

// The bounded validated probe list for one automatic discovery round: the
// effective endpoint first, then each fixed common loopback base, deduped.
// Returns null when probing must not happen at all — an invalid/empty
// environment override or unresolved (malformed/unsafe) settings. A valid
// override restricts the list to that endpoint alone.
export function localScanEndpoints(resolution: LocalEndpointResolution): string[] | null {
  if (resolution.endpoint === null) return null
  if (resolution.source === "environment override") return [resolution.endpoint]
  const endpoints: string[] = [resolution.endpoint]
  for (const port of scanPorts()) {
    const candidate = parseLocalEndpoint(`http://127.0.0.1:${port}/v1`)
    if (candidate && !endpoints.includes(candidate.raw)) endpoints.push(candidate.raw)
  }
  return endpoints.slice(0, LOCAL_SCAN_MAX_ENDPOINTS)
}

// A cancelled or torn-down adapter gets a graceful signal first; an adapter
// blocked on a socket read may never see it, so the parent escalates after
// this window and then awaits the real exit (design.md, "Cancellation must be
// confirmed rather than merely requested").
export const LOCAL_TERMINATION_GRACE_MS = 2_000

export const BUNDLED_DEFAULT_PROVIDER: ProviderId = "codex"
export const BUNDLED_CODEX_PROVIDER = join(import.meta.dir, "codex-provider.zsh")
export const BUNDLED_CLAUDE_PROVIDER = join(import.meta.dir, "claude-provider.zsh")
export const BUNDLED_CODEX_APP_SERVER_PROVIDER = join(
  import.meta.dir,
  "codex-app-server-provider.ts",
)

const homeForEnv = (env: Readonly<Record<string, string | undefined>>) =>
  env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()

const unique = (values: string[]) => [...new Set(values.filter(Boolean))]

export function providerRegistry(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderDescriptor[] {
  const home = homeForEnv(env)
  const reasoning = ["low", "medium", "high"]
  const claudeReasoning = ["low", "medium", "high", "xhigh", "max"]
  return [
    {
      id: "codex",
      transport: "cli",
      bin: "codex",
      adapter: "codex-provider.zsh",
      storeRoot: env.SHELLQ_CODEX_ASK_ENGINE === "exec" ? join(home, ".codex") : join(resolveStateRoot(env), "codex-home"),
      modes: { ask: true, command: true, fix: true },
      history: "native",
      models: unique([
        env.SHELLQ_CODEX_MODEL ?? "gpt-5.6-luna",
        ...(env.SHELLQ_WORKBENCH_MODELS?.split(/[,:]/u) ?? [
          "gpt-5.3-codex-spark",
          "gpt-5.6-luna",
        ]),
      ]),
      reasoningLevels: unique([
        env.SHELLQ_CODEX_REASONING ?? reasoning[0],
        ...(env.SHELLQ_WORKBENCH_REASONING_LEVELS?.split(/[,:]/u) ?? reasoning),
      ]),
      modelEnv: "SHELLQ_CODEX_MODEL",
      reasoningEnv: "SHELLQ_CODEX_REASONING",
      workdirEnv: "SHELLQ_CODEX_WORKDIR",
      sessionFileEnv: "SHELLQ_CODEX_SESSION_FILE",
      newSessionEnv: "SHELLQ_CODEX_NEW_SESSION",
      modelsEnv: "SHELLQ_WORKBENCH_MODELS",
    },
    {
      id: "claude",
      transport: "cli",
      bin: "claude",
      adapter: "claude-provider.zsh",
      storeRoot: join(home, ".claude"),
      modes: { ask: true, command: true, fix: true },
      history: "native",
      models: unique([
        normalizeClaudeModel(env.SHELLQ_CLAUDE_MODEL ?? "claude-sonnet-5"),
        ...(env.SHELLQ_CLAUDE_MODELS?.split(/[,:]/u).map(normalizeClaudeModel) ?? [
          "claude-fable-5",
          "claude-opus-5",
          "claude-sonnet-5",
        ]),
      ]),
      reasoningLevels: unique([
        claudeReasoning.includes(env.SHELLQ_CLAUDE_REASONING ?? "")
          ? env.SHELLQ_CLAUDE_REASONING!
          : claudeReasoning[0],
        ...claudeReasoning,
      ]),
      modelEnv: "SHELLQ_CLAUDE_MODEL",
      reasoningEnv: "SHELLQ_CLAUDE_REASONING",
      workdirEnv: "SHELLQ_CLAUDE_WORKDIR",
      sessionFileEnv: "SHELLQ_CLAUDE_SESSION_FILE",
      newSessionEnv: "SHELLQ_CLAUDE_NEW_SESSION",
      modelsEnv: "SHELLQ_CLAUDE_MODELS",
    },
    {
      // Managed loopback HTTP has no CLI binary or native session store.
      id: "local-openai",
      transport: "managed",
      bin: "",
      adapter: "local-openai-provider.zsh",
      storeRoot: join(home, ".local-openai"),
      modes: { ask: true, command: true, fix: true },
      history: "none",
      models: [],
      reasoningLevels: ["endpoint default"],
      modelEnv: "SHELLQ_LOCAL_OPENAI_MODEL",
      reasoningEnv: "SHELLQ_LOCAL_OPENAI_REASONING",
      workdirEnv: "SHELLQ_LOCAL_OPENAI_WORKDIR",
      sessionFileEnv: "SHELLQ_LOCAL_OPENAI_SESSION_FILE",
      newSessionEnv: "SHELLQ_LOCAL_OPENAI_NEW_SESSION",
      modelsEnv: "SHELLQ_LOCAL_OPENAI_MODELS",
    },
  ]
}

export function normalizeClaudeModel(model: string): string {
  return {
    fable: "claude-fable-5",
    opus: "claude-opus-5",
    sonnet: "claude-sonnet-5",
  }[model] ?? model
}

export function adapterPath(descriptor: ProviderDescriptor): string {
  return join(import.meta.dir, descriptor.adapter)
}

export function adapterIsExecutable(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export function resolveProviderId(argv: string[]): ProviderId | null {
  if (argv.length !== 1) return null
  return (
    providerRegistry().find((descriptor) => adapterPath(descriptor) === argv[0])
      ?.id ?? null
  )
}

export function descriptorForProvider(
  id: ProviderId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderDescriptor {
  return providerRegistry(env).find((descriptor) => descriptor.id === id)!
}

function executableOnPath(bin: string, pathValue = process.env.PATH): boolean {
  if (!pathValue) return false
  for (const entry of pathValue.split(":")) {
    if (!entry || !isAbsolute(entry)) return false
    try {
      const stat = statSync(join(entry, bin))
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return true
    } catch {}
  }
  return false
}

export function providerAvailability(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Array<ProviderDescriptor & { selectable: boolean; historyAvailable: boolean }> {
  const pathValue = env.PATH
  return providerRegistry(env).map((descriptor) => {
    let historyAvailable = false
    try {
      const root = lstatSync(descriptor.storeRoot)
      historyAvailable = root.isDirectory() && !root.isSymbolicLink()
    } catch {}
    return {
      ...descriptor,
      selectable: descriptor.transport === "managed"
        ? adapterIsExecutable(adapterPath(descriptor))
        : executableOnPath(descriptor.bin, pathValue),
      historyAvailable,
    }
  })
}

export function selectableProviderIds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderId[] {
  return providerAvailability(env)
    .filter((descriptor) => descriptor.selectable)
    .map((descriptor) => descriptor.id)
}

export type ProviderResponse = {
  tldr: string
  corrected_command: string | null
  confidence: number
  risk: string
}

export type AskResponse = {
  answer: string
}

export type AskTurn = {
  question: string
  answer: string
}

export type AskConversation = {
  turns: AskTurn[]
  dropped: boolean
}

export type ResponseMetrics = { outputTokens?: number; tokensPerSecond?: number }

export function parseResponseMetrics(value: unknown): ResponseMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Object.keys(record).length || Object.keys(record).some(key => key !== "outputTokens" && key !== "tokensPerSecond")) return null
  if (record.outputTokens !== undefined && (!Number.isSafeInteger(record.outputTokens) || (record.outputTokens as number) < 0)) return null
  if (record.tokensPerSecond !== undefined && (typeof record.tokensPerSecond !== "number" || !Number.isFinite(record.tokensPerSecond) || record.tokensPerSecond <= 0)) return null
  return record as ResponseMetrics
}

export function responseSummary(elapsedMs: number, metrics: ResponseMetrics = {}, expanded = false): string {
  return [
    `${(elapsedMs / 1000).toFixed(1)}s`,
    ...(expanded && metrics.outputTokens !== undefined ? [`${metrics.outputTokens} tokens`] : []),
    ...(expanded && metrics.tokensPerSecond !== undefined ? [`${metrics.tokensPerSecond.toFixed(1)} tok/s`] : []),
  ].join(" · ")
}

export type AskPreviewEvent = {
  t: "answer" | "delta" | "note" | "thinking"
  text: string
}

export type AskPreviewState = {
  note: string
  text: string
  // Model-provided reasoning, kept separate from the answer text and never
  // persisted: it exists only while a streamed Ask is in flight.
  thinking: string
}

export type SessionIntent = "ask" | "generate" | "correct"
export type CodexAskEngine = "app-server" | "exec"
export type AskChatState = "new" | "saved" | "one-shot"
export type CtrlXAction =
  | "context"
  | "doctor"
  | "engine"
  | "include"
  | "settings"
  | "provider"
  | "model"
  | "reasoning"
  | "details"
  | "edit"
  | "new-chat"
  | "another"
  | "save"

export type LastCommand = {
  command: string
  cwd: string
  exit_status: number
  pipeline_statuses: number[]
}

export type WorkbenchSession = {
  localEndpoint?: LocalEndpointResolution
  initial_intent: SessionIntent
  requests: {
    ask: Record<string, any>
    generate: Record<string, any>
    correct: Record<string, any> | null
  }
  provider: string[]
  provider_id?: ProviderId | null
  provider_source?: ProviderSource
  codex_ask_engine: CodexAskEngine | null
  model: string
  reasoning: string
  models: string[]
  reasoning_levels: string[]
  context: {
    text: string
    source: "herdr" | "tmux" | "none"
    label: "matched command" | "recent pane only" | "unavailable"
    correlated: boolean
    included: boolean
  }
  actionable_failure: boolean
  last_command: LastCommand | null
}

const codePointLength = (value: string) => Array.from(value).length
const hasControl = (value: string) => /[\x00-\x1f\x7f-\x9f]/u.test(value)
const hasBidiControl = (value: string) => /\p{Bidi_Control}/u.test(value)

export function commandIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    codePointLength(value) > 0 &&
    codePointLength(value) <= 8192 &&
    !hasBidiControl(value) &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!
      return (
        code === 9 ||
        code === 10 ||
        (code >= 32 && (code < 127 || code > 159))
      )
    })
  )
}

// Terminals disagree on pasted newline encoding; normalize it without
// flattening the user's deliberate prompt structure.
export const composerText = (value: string) => value.replace(/\r\n?/gu, "\n")

export function queryIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    new TextEncoder().encode(value).byteLength > 0 &&
    new TextEncoder().encode(value).byteLength <= ASK_QUERY_MAX_BYTES &&
    commandIsValid(value)
  )
}

export function answerIsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength > 0 &&
    new TextEncoder().encode(value).byteLength <= ASK_ANSWER_MAX_BYTES &&
    !hasBidiControl(value) &&
    Array.from(value).every((character) => {
      const code = character.codePointAt(0)!
      return (
        code === 9 ||
        code === 10 ||
        (code >= 32 && (code < 127 || code > 159))
      )
    })
  )
}

export function responseIsValid(
  value: unknown,
  requireCommand = true,
): value is ProviderResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const command = response.corrected_command

  return (
    typeof response.tldr === "string" &&
    codePointLength(response.tldr) > 0 &&
    codePointLength(response.tldr) <= 500 &&
    !hasControl(response.tldr) &&
    !hasBidiControl(response.tldr) &&
    (command === null || commandIsValid(command)) &&
    (!requireCommand || commandIsValid(command)) &&
    typeof response.confidence === "number" &&
    response.confidence >= 0 &&
    response.confidence <= 1 &&
    typeof response.risk === "string" &&
    codePointLength(response.risk) > 0 &&
    codePointLength(response.risk) <= 80 &&
    !hasControl(response.risk) &&
    !hasBidiControl(response.risk)
  )
}

export function parseProviderResponse(
  raw: string,
  requireCommand = true,
): ProviderResponse | null {
  try {
    const response = JSON.parse(raw)
    return responseIsValid(response, requireCommand) ? response : null
  } catch {
    return null
  }
}

export function parseProviderResponses(
  raw: string,
  requireCommand = true,
  candidateCount: 1 | 2 | 3 | 4 | 5 = 1,
): ProviderResponse[] | null {
  if (candidateCount === 1) {
    const response = parseProviderResponse(raw, requireCommand)
    return response ? [response] : null
  }
  try {
    const response = JSON.parse(raw)
    if (!response || typeof response !== "object" || Array.isArray(response) ||
      Object.keys(response).length !== 1 || !Array.isArray(response.candidates)) return null
    const candidates: unknown[] = response.candidates
    if (candidates.length < 1 || candidates.length > candidateCount) return null
    const commands = new Set<string | null>()
    for (const candidate of candidates) {
      if (!responseIsValid(candidate, requireCommand) || Object.keys(candidate).length !== 4 ||
        (candidate.corrected_command === null && candidates.length !== 1) ||
        commands.has(candidate.corrected_command)) return null
      commands.add(candidate.corrected_command)
    }
    return candidates as ProviderResponse[]
  } catch {
    return null
  }
}

export function parseAskResponse(raw: string): AskResponse | null {
  try {
    const response = JSON.parse(raw) as Record<string, unknown>
    return (
      response &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      Object.keys(response).length === 1 &&
      answerIsValid(response.answer)
    )
      ? { answer: response.answer }
      : null
  } catch {
    return null
  }
}

export function tailUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maxBytes) return value

  const characters = Array.from(value)
  let bytes = 0
  let index = characters.length
  while (index > 0) {
    const size = encoder.encode(characters[index - 1]).byteLength
    if (bytes + size > maxBytes) break
    bytes += size
    index -= 1
  }
  return characters.slice(index).join("")
}

export function sanitizeContext(value: string): string {
  return tailUtf8(
    value
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
      .replace(/\x1b\][^\n]*/gu, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/\x1b[@-_]/gu, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu, "")
      .replace(
        /\p{Bidi_Control}/gu,
        (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
      ),
    CONTEXT_MAX_BYTES,
  )
}

export function appendCandidate(
  candidates: ProviderResponse[],
  candidate: ProviderResponse,
): ProviderResponse[] {
  if (
    candidates.length >= CANDIDATE_LIMIT ||
    !commandIsValid(candidate.corrected_command) ||
    candidates.some(
      (existing) => existing.corrected_command === candidate.corrected_command,
    )
  ) {
    return candidates
  }
  return [...candidates, candidate].sort((left, right) => right.confidence - left.confidence)
}

export function buildProviderRequest(
  session: WorkbenchSession,
  intent: "generate" | "correct",
  query: string,
  context: string,
  includeContext: boolean,
  candidates: ProviderResponse[],
  candidateCount: 1 | 2 | 3 | 4 | 5 = 1,
): Record<string, any> {
  const template = session.requests[intent]
  if (!template || !commandIsValid(query)) {
    throw new Error(
      intent === "correct"
        ? "no actionable failure is available"
        : "enter a valid command request",
    )
  }
  const request = structuredClone(template)
  const cleanContext = sanitizeContext(context)
  const input = request.input as Record<string, any>

  input.command = query
  input.captured_output = includeContext ? cleanContext : ""
  input.captured_output_correlated_to_command =
    includeContext &&
    intent === "correct" &&
    session.context.correlated &&
    cleanContext === session.context.text

  if (includeContext && session.last_command) {
    input.previous_command = session.last_command
  } else {
    delete input.previous_command
  }

  if (candidates.length) {
    input.avoid_commands = candidates.map(
      (candidate) => candidate.corrected_command,
    )
    request.instructions +=
      " Return a materially different safe command from input.avoid_commands."
  } else {
    delete input.avoid_commands
  }

  if (candidateCount > 1) {
    request.candidate_count = candidateCount
    request.response_schema = { candidates: [request.response_schema] }
    request.instructions +=
      ` Return exactly one object with a candidates array of up to ${candidateCount} distinct useful approaches, each matching the candidate schema.` +
      " Return fewer only when there are fewer safe, meaningfully different approaches; never pad with trivial variants." +
      " Every candidate must satisfy every stated constraint; omit an approach rather than relaxing a constraint." +
      " For Fix with no safe correction, return exactly one candidate with corrected_command null; never mix null with commands." +
      " Each tldr starts with the outcome and scope in plain language, then explains important flags and when to choose that approach, within 500 characters. State consequential limitations; avoid vague claims such as more robust." +
      " Confidence is your estimate of suitability, not a measured probability of success."
  }

  return request
}

export function buildAskRequest(
  session: WorkbenchSession,
  query: string,
  context: string,
  includeContext: boolean,
): Record<string, any> {
  if (!queryIsValid(query)) throw new Error("enter a valid question")

  const request = structuredClone(session.requests.ask)
  const input = request.input as Record<string, any>
  input.query = query
  input.captured_output = includeContext ? sanitizeContext(context) : ""
  input.captured_output_is_untrusted = true
  if (session.last_command) {
    input.previous_command = session.last_command
  } else {
    delete input.previous_command
  }
  return request
}

export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new Error("provider response exceeded the size limit")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const joined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

const ASK_PREVIEW_NOTES = new Set([
  "Calling a tool",
  "Drafting the answer",
  "Running a read-only command",
  "Searching the web",
  "Starting configured tools",
])

export function previewTextIsJsonLike(value: string): boolean {
  return (
    /^(?:\s)*(?:\{|\[|```)/u.test(value) ||
    /["'][^"'\r\n]+["']\s*:/u.test(value)
  )
}

export function retainedPreviewOffset(previous: string[], next: string[], offset: number): number {
  if (previous.slice(0, offset + 1).every((line, i) => next[i] === line)) return offset
  // Match the retained sequence, not a single repeated line. The last row
  // may still be growing, so it cannot establish the reader's anchor.
  const retained = previous.slice(offset, -1)
  if (!retained.length) return 0
  const needle = "\n" + retained.join("\n") + "\n"
  const haystack = "\n" + next.join("\n") + "\n"
  const start = haystack.indexOf(needle)
  if (start < 0 || start !== haystack.lastIndexOf(needle)) return 0
  return haystack.slice(0, start).split("\n").length - 1
}

export function appendAskPreview(
  current: AskPreviewState,
  event: AskPreviewEvent,
): AskPreviewState {
  const note = event.t === "note" ? event.text : current.note
  // Thinking never folds into the answer text; it has its own field below.
  const text =
    event.t === "note" || event.t === "thinking" ? current.text : current.text + event.text
  // Preserve the answer first when the shared provisional budget fills.
  const thinking = event.t === "thinking" ? current.thinking + event.text : current.thinking
  const noteBytes = new TextEncoder().encode(note).byteLength
  const separatorBytes = note && text ? 1 : 0
  return {
    note,
    text: tailUtf8(
      text,
      Math.max(0, ASK_ANSWER_MAX_BYTES - noteBytes - separatorBytes),
    ),
    thinking: tailUtf8(thinking, Math.max(0, ASK_ANSWER_MAX_BYTES - noteBytes - separatorBytes - new TextEncoder().encode(text).byteLength - (thinking && (text || note) ? 1 : 0))),
  }
}

function parseAskPreviewLine(
  line: Uint8Array,
  trustedAnswerDeltas: boolean,
  trustedThinking = false,
): AskPreviewEvent | null {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line))
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (
    keys.length !== 2 ||
    keys[0] !== "t" ||
    keys[1] !== "text" ||
    (record.t !== "delta" && record.t !== "note" && record.t !== "answer" && record.t !== "thinking") ||
    typeof record.text !== "string"
  ) {
    return null
  }
  if (record.t === "answer" && !trustedAnswerDeltas) return null
  // Thinking records require an explicit trusted transport; unoffered
  // records remain final bytes rather than gaining preview authority.
  if (record.t === "thinking" && !trustedThinking) return null
  if (record.t === "note" && !ASK_PREVIEW_NOTES.has(record.text)) return null
  if (record.t === "delta" && previewTextIsJsonLike(record.text)) {
    return { t: "note", text: "Drafting the answer" }
  }
  return {
    t: record.t,
    text:
      record.t === "delta" || record.t === "answer" || record.t === "thinking"
        ? tailUtf8(sanitizeContext(record.text), ASK_ANSWER_MAX_BYTES)
        : record.text,
  }
}

const joinBytes = (left: Uint8Array, right: Uint8Array) => {
  const joined = new Uint8Array(left.byteLength + right.byteLength)
  joined.set(left)
  joined.set(right, left.byteLength)
  return joined
}

export async function readAskStream(
  stream: ReadableStream<Uint8Array>,
  onPreview: (event: AskPreviewEvent) => void,
  trustedAnswerDeltas = false,
  trustedThinking = false,
  onMetrics?: (metrics: ResponseMetrics) => void,
): Promise<string> {
  const reader = stream.getReader()
  const finalChunks: Uint8Array[] = []
  let pending = new Uint8Array()
  let classifying = true
  let previewBytes = 0
  let finalBytes = 0

  const appendFinal = async (bytes: Uint8Array) => {
    finalBytes += bytes.byteLength
    if (finalBytes > RESPONSE_MAX_BYTES) {
      await reader.cancel()
      throw new Error("provider response exceeded the size limit")
    }
    finalChunks.push(bytes)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!classifying) {
        await appendFinal(value)
        continue
      }

      const bytes = joinBytes(pending, value)
      pending = new Uint8Array()
      let offset = 0
      while (offset < bytes.byteLength) {
        const newline = bytes.indexOf(10, offset)
        if (newline === -1) {
          const remainder = bytes.slice(offset)
          if (remainder.byteLength > ASK_PREVIEW_LINE_MAX_BYTES) {
            classifying = false
            await appendFinal(remainder)
          } else {
            pending = remainder
          }
          break
        }

        const line = bytes.slice(offset, newline)
        if (onMetrics && line.byteLength <= ASK_PREVIEW_LINE_MAX_BYTES) {
          let record: unknown
          try { record = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(line)) } catch {}
          if (record && typeof record === "object" && !Array.isArray(record) &&
            Object.keys(record).sort().join(",") === "metrics,t" && "t" in record && record.t === "metrics" && "metrics" in record) {
            const metrics = parseResponseMetrics(record.metrics)
            if (metrics) {
              previewBytes += line.byteLength + 1
              if (previewBytes <= ASK_PREVIEW_INPUT_MAX_BYTES) onMetrics(metrics)
              offset = newline + 1
              continue
            }
          }
        }
        const event =
          line.byteLength <= ASK_PREVIEW_LINE_MAX_BYTES
            ? parseAskPreviewLine(line, trustedAnswerDeltas, trustedThinking)
            : null
        if (!event) {
          classifying = false
          await appendFinal(bytes.slice(offset))
          break
        }

        previewBytes += line.byteLength + 1
        if (previewBytes <= ASK_PREVIEW_INPUT_MAX_BYTES) onPreview(event)
        offset = newline + 1
      }
    }
    if (classifying && pending.byteLength) await appendFinal(pending)
  } finally {
    reader.releaseLock()
  }

  const final = new Uint8Array(finalBytes)
  let offset = 0
  for (const chunk of finalChunks) {
    final.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(final)
}

export const oneLine = (value: string, limit = 140) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit)

export const emptyAskConversation = (): AskConversation => ({
  turns: [],
  dropped: false,
})

export function appendAskTurn(
  conversation: AskConversation,
  turn: AskTurn,
): AskConversation {
  const turns = [turn, ...conversation.turns]
  return {
    turns: turns.slice(0, ASK_TURN_LIMIT),
    dropped: conversation.dropped || turns.length > ASK_TURN_LIMIT,
  }
}

export type AskReaderRow = { kind: "question" | "answer" | "thinking" | "separator"; text: string }

export function askConversationRows(conversation: AskConversation, width: number): AskReaderRow[] {
  const rows: AskReaderRow[] = conversation.dropped
    ? [{ kind: "separator", text: "Earlier exchanges cleared" }]
    : []
  for (const turn of [...conversation.turns].reverse()) {
    if (rows.length) rows.push({ kind: "separator", text: "" })
    rows.push(...wrappedTextLines(`You: ${oneLine(turn.question, ASK_QUERY_MAX_BYTES)}`, width, "word")
      .map(text => ({ kind: "question" as const, text })))
    rows.push(...wrappedTextLines(turn.answer, width, "word")
      .map(text => ({ kind: "answer" as const, text })))
  }
  return rows
}

export const terminalLiteral = (value: string) =>
  JSON.stringify(value).replace(
    /[\x7f-\x9f]|\p{Bidi_Control}/gu,
    (character) => {
      return `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
    },
  )

export const modelLabel = (model: string) => {
  if (model === "gpt-5.3-codex-spark") return "Spark"
  if (model === "gpt-5.6-luna") return "Luna"
  return model
}

const CTRL_X_ACTIONS: Record<string, CtrlXAction> = {
  a: "another",
  c: "context",
  d: "doctor",
  e: "edit",
  g: "engine",
  h: "details",
  i: "include",
  p: "provider",
  m: "model",
  n: "new-chat",
  r: "reasoning",
  s: "settings",
  w: "save",
}

export const ctrlXAction = (key: string): CtrlXAction | null =>
  CTRL_X_ACTIONS[key.toLowerCase()] ?? null

export function isBundledCodexProvider(provider: string[]): boolean {
  return resolveProviderId(provider) === "codex"
}

export function resolveStateRoot(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env.SHELLQ_STATE_DIR
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) {
      throw new Error("invalid shellq state directory")
    }
    return override
  }
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) {
    return join(env.XDG_STATE_HOME, "shellq")
  }
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
  if (!isAbsolute(home)) throw new Error("invalid shellq state directory")
  return join(home, ".local", "state", "shellq")
}

export function codexSessionFile(
  workdir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  engine: CodexAskEngine = "exec",
): string {
  return providerSessionFile(
    engine === "app-server" ? "codex-app-server" : "codex",
    workdir,
    env,
  )
}

export function providerSessionFile(
  provider: ProviderId | "codex-app-server",
  workdir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const trustedWorkdir = validateTrustedWorkdir(workdir)
  const digest = createHash("sha256").update(trustedWorkdir).digest("hex")
  return join(resolveStateRoot(env), "ask", `${provider === "codex-app-server" ? "codex-app-server-isolated" : provider}-${digest}.json`)
}

export const INFERENCE_SETTINGS_MAX_BYTES = 4_096
export const INFERENCE_SETTINGS_VERSION = 2
export const INFERENCE_SETTINGS_LOCK = ".settings.lock"

export type PersistedInferenceSettings = {
  model: string
  reasoning: string
}

export type LocalThinkingPreference = { endpoint: string; model: string; enabled: boolean }

export type PersistedInferenceDocument = {
  version: 2
  provider: ProviderId
  providers: Record<string, PersistedInferenceSettings>
  localEndpoint?: string
  localThinking?: LocalThinkingPreference[]
  initialChoices?: 1 | 2 | 3 | 4 | 5
  metricsExpanded?: boolean
}

const validSelection = (value: unknown): value is PersistedInferenceSettings =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).model === "string" &&
  typeof (value as Record<string, unknown>).reasoning === "string" &&
  Object.keys(value).sort().join(",") === "model,reasoning"

function parseInferenceDocument(value: unknown): PersistedInferenceDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    record.version === 1 &&
    Object.keys(record).sort().join(",") === "model,reasoning,version" &&
    typeof record.model === "string" &&
    typeof record.reasoning === "string"
  ) {
    return {
      version: 2,
      provider: BUNDLED_DEFAULT_PROVIDER,
      providers: {
        [BUNDLED_DEFAULT_PROVIDER]: {
          model: record.model,
          reasoning: record.reasoning,
        },
      },
    }
  }
  if (
    record.version !== 2 ||
    (record.provider !== "codex" && record.provider !== "claude" && record.provider !== "local-openai") ||
    !record.providers ||
    typeof record.providers !== "object" ||
    Array.isArray(record.providers) ||
    Object.keys(record).some(key => !["version", "provider", "providers", "localEndpoint", "localThinking", "metricsExpanded", "initialChoices"].includes(key))
  ) return null
  const providers: Record<string, PersistedInferenceSettings> = {}
  for (const [id, selection] of Object.entries(record.providers)) {
    if (id !== "codex" && id !== "claude" && id !== "local-openai" && id !== "configured") return null
    if (!validSelection(selection)) return null
    providers[id] = selection
  }
  const endpoint = "localEndpoint" in record ? parseLocalEndpoint(record.localEndpoint) : null
  if ("localEndpoint" in record && !endpoint) return null
  if ("metricsExpanded" in record && typeof record.metricsExpanded !== "boolean") return null
  if ("initialChoices" in record && ![1, 2, 3, 4, 5].includes(record.initialChoices as number)) return null
  const localThinking = record.localThinking
  if ("localThinking" in record && (!Array.isArray(localThinking) || localThinking.some(entry =>
    !entry || typeof entry !== "object" || Array.isArray(entry) ||
    Object.keys(entry).sort().join(",") !== "enabled,endpoint,model" ||
    !parseLocalEndpoint(entry.endpoint) || typeof entry.model !== "string" || !SAFE_MODEL.test(entry.model) ||
    typeof entry.enabled !== "boolean"
  ))) return null
  return { version: 2, provider: record.provider, providers, ...(endpoint ? { localEndpoint: endpoint.raw } : {}),
    ...(Array.isArray(localThinking) ? { localThinking } : {}),
    ...(typeof record.metricsExpanded === "boolean" ? {metricsExpanded:record.metricsExpanded} : {}),
    ...("initialChoices" in record ? {initialChoices: record.initialChoices as 1 | 2 | 3 | 4 | 5} : {}) }

}

// Private configuration lives beside Ask pointers, never in request artifacts.
export function inferenceSettingsFile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return join(resolveStateRoot(env), "settings.json")
}

export type PersistedInferenceDocumentState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "operational-error"; error: unknown }
  | { kind: "valid"; document: PersistedInferenceDocument; sourceVersion: number }

export function readPersistedInferenceDocumentState(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PersistedInferenceDocumentState {
  let path: string
  try {
    path = inferenceSettingsFile(env)
  } catch (error) {
    return { kind: "operational-error", error }
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    if (lstatSync(dirname(path)).isSymbolicLink()) return { kind: "invalid" }
    stat = lstatSync(path)
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "operational-error", error }
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > INFERENCE_SETTINGS_MAX_BYTES) {
    return { kind: "invalid" }
  }
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    return { kind: "operational-error", error }
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const document = parseInferenceDocument(value)
    return document
      ? { kind: "valid", document, sourceVersion: value.version as number }
      : { kind: "invalid" }
  } catch {
    return { kind: "invalid" }
  }
}

export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8000/v1"
export type LocalEndpointResolution = {
  endpoint: string | null
  source: "default" | "saved" | "environment override" | "not saved" | "unresolved"
  readOnly: boolean
}

export function resolveLocalEndpoint(
  settings: PersistedInferenceDocumentState,
  env: Readonly<Record<string, string | undefined>>,
): LocalEndpointResolution {
  if (Object.prototype.hasOwnProperty.call(env, LOCAL_ENDPOINT_ENV)) {
    return { endpoint: parseLocalEndpoint(env[LOCAL_ENDPOINT_ENV])?.raw ?? null, source: "environment override", readOnly: true }
  }
  if (settings.kind === "invalid" || settings.kind === "operational-error") {
    return { endpoint: null, source: "unresolved", readOnly: false }
  }
  const saved = settings.kind === "valid" ? settings.document.localEndpoint : undefined
  return { endpoint: saved ?? DEFAULT_LOCAL_ENDPOINT, source: saved ? "saved" : "default", readOnly: false }
}

export const localEndpointUnavailableMessage = (endpoint: LocalEndpointResolution) =>
  endpoint.readOnly
    ? "invalid endpoint override; remove it before configuring local endpoint"
    : "local endpoint unavailable; configure local endpoint"

export class EndpointSettingsWriteError extends Error {
  constructor(public reason: "confirmation" | "safe-path") {
    super(reason === "confirmation"
      ? "unreadable saved selections cannot be preserved; confirm replacement"
      : "could not repair settings safely; correct the settings path or access")
  }
}

export function readPersistedInferenceSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerId: ProviderId | "configured" = BUNDLED_DEFAULT_PROVIDER,
): PersistedInferenceSettings | null {
  const state = readPersistedInferenceDocumentState(env)
  return state.kind === "valid" ? state.document.providers[providerId] ?? null : null
}

export function readPersistedInferenceDocument(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PersistedInferenceDocument | null {
  const state = readPersistedInferenceDocumentState(env)
  if (state.kind === "operational-error") throw state.error
  return state.kind === "valid" ? state.document : null
}

// Applies a saved value only where the session's own `models`/
// `reasoning_levels` list still offers it — that list reflects what this
// invocation can actually request, so a value missing from it is stale (an
// uninstalled model, a retired reasoning level) rather than untrusted.
// Mutates `session` in place, matching `run()`'s existing convention for
// `session.requests.ask.input.environment.cwd`. Returns one combined notice
// for the bottom rail's message slot when either field was dropped, or
// `null` when nothing was.
export function applyPersistedInferenceSettings(
  session: WorkbenchSession,
  persisted: PersistedInferenceSettings | null,
): string | null {
  if (!persisted) return null
  const notices: string[] = []
  // A syntactically valid saved local exact model and supported effort are
  // restored as immediate preference.
  const provisionalCodexModel =
    (session.provider_id === "codex" || session.provider_id === LOCAL_PROVIDER_ID) &&
    SAFE_MODEL.test(persisted.model)
  const provisionalCodexEffort =
    (session.provider_id === "codex" &&
      (CODEX_EFFORTS as readonly string[]).includes(persisted.reasoning)) ||
    (session.provider_id === LOCAL_PROVIDER_ID &&
      session.reasoning_levels.includes(persisted.reasoning))
  if (session.models.includes(persisted.model) || provisionalCodexModel) {
    session.model = persisted.model
  } else {
    notices.push(`saved model unavailable · using ${modelLabel(session.model)}`)
  }
  if (session.reasoning_levels.includes(persisted.reasoning) || provisionalCodexEffort) {
    session.reasoning = persisted.reasoning
  } else {
    notices.push(`saved effort unavailable · using ${session.reasoning}`)
  }
  return notices.length ? notices.join(" · ") : null
}

// Same directory discipline as the Ask pointer's shell-side write: create
// the parent with `0700` only if missing, refuse a symlinked parent, write
// through a same-directory temp file at `0600`, then rename over the target
// so a reader never observes a partial write. Throws on failure — the caller
// decides how to surface that without crashing the workbench.
export function writePersistedInferenceSettings(
  model: string,
  reasoning: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  providerId: ProviderId | "configured" = BUNDLED_DEFAULT_PROVIDER,
): void {
  updatePersistedInferenceDocument(env, (state) => {
    if (state.kind === "invalid" || state.kind === "operational-error") {
      throw new Error("could not save choice; settings need repair")
    }
    const current: PersistedInferenceDocument = state.kind === "valid" ? state.document : {
      version: 2, provider: BUNDLED_DEFAULT_PROVIDER, providers: {},
    }
    if (providerId !== "configured") current.provider = providerId
    current.providers[providerId] = { model, reasoning }
    return current
  })
}

export function writePersistedInitialChoices(
  count: 1 | 2 | 3 | 4 | 5,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (![1, 2, 3, 4, 5].includes(count)) throw new Error("invalid initial choices")
  updatePersistedInferenceDocument(env, state => {
    if (state.kind === "invalid" || state.kind === "operational-error") throw new Error("settings need repair")
    const current: PersistedInferenceDocument = state.kind === "valid" ? state.document : {
      version: 2, provider: BUNDLED_DEFAULT_PROVIDER, providers: {},
    }
    return {...current, initialChoices: count}
  })
}

export function writePersistedMetricsExpanded(
  expanded: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  updatePersistedInferenceDocument(env, state => {
    if (state.kind === "invalid" || state.kind === "operational-error") throw new Error("settings need repair")
    const current: PersistedInferenceDocument = state.kind === "valid" ? state.document : {
      version: 2, provider: BUNDLED_DEFAULT_PROVIDER, providers: {},
    }
    return {...current, metricsExpanded:expanded}
  })
}

export function writePersistedLocalThinking(
  endpoint: string, model: string, enabled: boolean | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalThinkingPreference[] {
  if (!parseLocalEndpoint(endpoint) || !SAFE_MODEL.test(model)) throw new Error("invalid thinking preference")
  let preferences: LocalThinkingPreference[] = []
  updatePersistedInferenceDocument(env, state => {
    if (state.kind === "invalid" || state.kind === "operational-error") throw new Error("settings need repair")
    const current: PersistedInferenceDocument = state.kind === "valid" ? state.document : {
      version: 2, provider: BUNDLED_DEFAULT_PROVIDER, providers: {},
    }
    preferences = (current.localThinking ?? []).filter(item => item.endpoint !== endpoint || item.model !== model)
    if (enabled !== undefined) preferences.push({ endpoint, model, enabled })
    if (preferences.length) current.localThinking = preferences
    else delete current.localThinking
    return current
  })
  return preferences
}

// One atomic settings update for a chosen endpoint/model/effort triple: the
// provider entry, the root provider, and the saved endpoint change together
// or not at all, so a reader never observes a pair split across documents.
export function writePersistedLocalSelection(
  endpoint: string,
  model: string,
  reasoning: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const validated = parseLocalEndpoint(endpoint)
  if (!validated || !SAFE_MODEL.test(model)) throw new Error("invalid local selection")
  updatePersistedInferenceDocument(env, (state) => {
    if (state.kind === "invalid" || state.kind === "operational-error") {
      throw new Error("could not save choice; settings need repair")
    }
    const current: PersistedInferenceDocument = state.kind === "valid" ? state.document : {
      version: 2, provider: LOCAL_PROVIDER_ID, providers: {},
    }
    current.provider = LOCAL_PROVIDER_ID
    current.providers[LOCAL_PROVIDER_ID] = { model, reasoning }
    current.localEndpoint = validated.raw
    return current
  })
}

export function writePersistedLocalEndpoint(
  endpoint: string | null,
  providerId: ProviderId | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
  confirmReplacement = false,
): void {
  const validated = endpoint === null ? null : parseLocalEndpoint(endpoint)
  if (endpoint !== null && !validated) throw new Error("invalid local endpoint")
  updatePersistedInferenceDocument(env, (state) => {
    if (state.kind === "operational-error") throw new EndpointSettingsWriteError("safe-path")
    if (state.kind === "invalid") {
      const target = lstatSync(inferenceSettingsFile(env))
      if (!target.isFile() || target.isSymbolicLink()) throw new EndpointSettingsWriteError("safe-path")
      if (!confirmReplacement) throw new EndpointSettingsWriteError("confirmation")
    }
    const current: PersistedInferenceDocument = state.kind === "valid" ? state.document : {
      version: 2, provider: providerId ?? BUNDLED_DEFAULT_PROVIDER, providers: {},
    }
    if (validated) current.localEndpoint = validated.raw
    else delete current.localEndpoint
    return current
  })
}

function updatePersistedInferenceDocument(
  env: Readonly<Record<string, string | undefined>>,
  update: (state: PersistedInferenceDocumentState) => PersistedInferenceDocument,
): void {
  const path = inferenceSettingsFile(env)
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!lstatSync(dir).isDirectory()) {
    throw new EndpointSettingsWriteError("safe-path")
  }
  if ((lstatSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  const lock = join(dir, INFERENCE_SETTINGS_LOCK)
  let lockOwned = false
  const lockNonce = randomUUID()
  let tmp = ""
  let ownerTmp = ""
  let lockInode: number | null = null

  const lockSnapshot = (target: string = lock) => {
    try {
      const stat = lstatSync(target)
      const value = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>
      return typeof value.pid === "number" && Number.isInteger(value.pid) &&
        typeof value.nonce === "string" && typeof value.created_at === "number"
        ? { inode: stat.ino, owner: value }
        : null
    } catch {
      return null
    }
  }
  const ownerIsAlive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error instanceof Error && "code" in error && error.code === "EPERM"
    }
  }
  const reclaimLock = () => {
    const before = lockSnapshot()
    if (!before || ownerIsAlive(before.owner.pid as number)) return false
    const claim = `${lock}.reclaim`
    let claimInode: number | null = null
    const claimTmp = join(dir, `.settings-reclaim-${randomUUID()}.tmp`)
    try {
      writeFileSync(claimTmp, JSON.stringify({ pid: process.pid, nonce: lockNonce, created_at: Date.now() }), { mode: 0o600 })
      try {
        linkSync(claimTmp, claim)
      } catch {
        let stat: ReturnType<typeof lstatSync>
        try {
          stat = lstatSync(claim)
        } catch {
          return false
        }
        const owner = lockSnapshot(claim)
        const stale = owner !== null
          ? !ownerIsAlive(owner.owner.pid as number)
          : Date.now() - stat.mtimeMs > 5_000
        if (!stale) return false
        let recheck: ReturnType<typeof lstatSync>
        try {
          recheck = lstatSync(claim)
        } catch {
          return false
        }
        if (recheck.ino !== stat.ino) return false
        unlinkSync(claim)
        linkSync(claimTmp, claim)
      }
      claimInode = lstatSync(claimTmp).ino
      const after = lockSnapshot()
      if (
        !after ||
        after.inode !== before.inode ||
        after.owner.nonce !== before.owner.nonce
      ) return false
      unlinkSync(lock)
      return true
    } catch {
      return false
    } finally {
      try { unlinkSync(claimTmp) } catch {}
      const current = lockSnapshot(claim)
      if (current?.inode === claimInode && current.owner.nonce === lockNonce) {
        try { unlinkSync(claim) } catch {}
      }
    }
  }
  const releaseLock = () => {
    if (!lockOwned) return
    try {
      const current = lockSnapshot()
      if (current && current.inode === lockInode && current.owner.nonce === lockNonce) {
        unlinkSync(lock)
      }
    } catch {}
    lockOwned = false
    lockInode = null
  }

  // Rechecks cannot make check/unlink atomic. The directory inode is never
  // replaced by a writer; its kernel lock covers reclamation through commit
  // and is released on process death, including a kill immediately before unlink.
  const symbols = { flock: { args: ["int", "int"], returns: "int" } } as const
  let native
  try {
    native = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", symbols)
  } catch (error) {
    if (process.platform !== "linux") throw error
    // musl's runtime soname is architecture-specific; libc.so can require
    // development packages that the workbench does not otherwise need.
    native = dlopen(`libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`, symbols)
  }
  let directoryFd = -1
  try {
    directoryFd = openSync(dir, "r")
    let serialized = false
    for (let attempt = 0; attempt < 200; attempt += 1) {
      // LOCK_EX | LOCK_NB. A paused live owner must never be age-evicted.
      if (native.symbols.flock(directoryFd, 2 | 4) === 0) { serialized = true; break }
      Bun.sleepSync(5)
    }
    if (!serialized) throw new Error("could not lock inference settings")
    for (let attempt = 0; attempt < 200; attempt += 1) {
      ownerTmp = join(dir, `.settings-lock-${randomUUID()}.tmp`)
      writeFileSync(
        ownerTmp,
        JSON.stringify({ pid: process.pid, nonce: lockNonce, created_at: Date.now() }),
        { mode: 0o600 },
      )
      chmodSync(ownerTmp, 0o600)
      try {
        linkSync(ownerTmp, lock)
        unlinkSync(ownerTmp)
        ownerTmp = ""
        lockOwned = true
        lockInode = lstatSync(lock).ino
        break
      } catch {
        try { if (ownerTmp) unlinkSync(ownerTmp) } catch {}
        ownerTmp = ""
        if (reclaimLock()) {
          continue
        }
        Bun.sleepSync(5)
      }
    }
    if (!lockOwned) throw new Error("could not lock inference settings")
    const current = update(readPersistedInferenceDocumentState(env))
    const encoded = JSON.stringify(current)
    if (Buffer.byteLength(encoded) > INFERENCE_SETTINGS_MAX_BYTES) throw new Error("inference settings too large")
    tmp = join(dir, `.settings-${randomUUID()}.tmp`)
    writeFileSync(tmp, encoded, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (error) {
    try {
      if (tmp) unlinkSync(tmp)
    } catch {}
    try {
      if (ownerTmp) unlinkSync(ownerTmp)
    } catch {}
    throw error
  } finally {
    releaseLock()
    if (directoryFd >= 0) closeSync(directoryFd)
    native.close()
  }
}

export const appServerCandidateFile = (sessionFile: string): string => {
  if (!isAbsolute(sessionFile)) throw new Error("invalid Codex session file")
  return `${sessionFile}.pending-${randomUUID()}`
}

export function askProviderArgv(
  session: WorkbenchSession,
  bunPath = process.execPath,
  engine = session.codex_ask_engine,
): string[] {
  return engine === "app-server"
    ? [bunPath, BUNDLED_CODEX_APP_SERVER_PROVIDER]
    : session.provider
}

export function codexAskSessionEnvironment(
  provider: string[],
  sessionFile: string | null,
  newSession: boolean,
  engine: CodexAskEngine = "exec",
  candidateFile?: string,
  resumeId?: string,
): Record<string, string> {
  if (!isBundledCodexProvider(provider) || !sessionFile) return {}
  if (!isAbsolute(sessionFile)) {
    throw new Error("invalid Codex session file")
  }
  if (engine === "app-server") {
    if (candidateFile && !isAbsolute(candidateFile)) {
      throw new Error("invalid App Server candidate file")
    }
    if (newSession === Boolean(resumeId) || (resumeId && !UUID.test(resumeId))) {
      throw new Error("invalid App Server session intent")
    }
    return {
      ...(candidateFile ? { SHELLQ_ASK_PENDING_FILE: candidateFile } : {}),
      SHELLQ_CODEX_SESSION_FILE: sessionFile,
      ...(newSession ? { SHELLQ_CODEX_NEW_SESSION: "1" } : {}),
      ...(resumeId ? { SHELLQ_CODEX_SESSION_ID: resumeId } : {}),
    }
  }
  if (newSession !== Boolean(candidateFile) || (candidateFile && !isAbsolute(candidateFile))) {
    throw new Error("invalid Codex session intent")
  }
  return {
    ...(candidateFile ? { SHELLQ_ASK_PENDING_FILE: candidateFile } : {}),
    SHELLQ_CODEX_SESSION_FILE: sessionFile,
    ...(newSession ? { SHELLQ_CODEX_NEW_SESSION: "1" } : {}),
  }
}

export function providerAskSessionEnvironment(
  provider: string[],
  providerId: ProviderId | null,
  sessionFile: string | null,
  newSession: boolean,
  workdir?: string,
  candidateFile?: string,
  resumeId?: string,
): Record<string, string> {
  if (!providerId || !sessionFile) return {}
  const descriptor = descriptorForProvider(providerId)
  if (resolveProviderId(provider) !== providerId || !isAbsolute(sessionFile)) {
    throw new Error("invalid provider session file")
  }
  if (candidateFile && !isAbsolute(candidateFile)) {
    throw new Error("invalid provider pending file")
  }
  if (providerId === "claude" && sessionFile) {
    if (newSession === Boolean(resumeId) || (resumeId && !UUID.test(resumeId))) {
      throw new Error("invalid Claude session intent")
    }
    if (newSession && !candidateFile) {
      throw new Error("invalid Claude pending file")
    }
  }
  return {
    ...(workdir ? { [descriptor.workdirEnv]: workdir } : {}),
    [descriptor.sessionFileEnv]: sessionFile,
    ...(candidateFile ? { SHELLQ_ASK_PENDING_FILE: candidateFile } : {}),
    ...(newSession ? { [descriptor.newSessionEnv]: "1" } : {}),
    ...(resumeId ? { SHELLQ_CLAUDE_SESSION_ID: resumeId } : {}),
  }
}

export type PointerExpectation = { cwd: string; provider: string }
export const PROVIDER_POINTER_MAX_BYTES = 4_096
export type AppServerPointerDecision =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; sessionId: string }

export const providerPointerDecision = (
  path: string,
  expect: PointerExpectation,
): AppServerPointerDecision => {
  try {
    const candidate = lstatSync(path)
    if (
      !candidate.isFile() ||
      candidate.isSymbolicLink() ||
      (candidate.mode & 0o777) !== 0o600 ||
      candidate.size > PROVIDER_POINTER_MAX_BYTES
    ) return { kind: "invalid" }
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    const valid =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(",") === "cwd,provider,session_id" &&
      value.provider === expect.provider &&
      value.cwd === expect.cwd &&
      typeof value.session_id === "string" &&
      UUID.test(value.session_id)
    return valid
      ? { kind: "valid", sessionId: value.session_id as string }
      : { kind: "invalid" }
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" }
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function appServerPointerDecision(
  path: string,
  expect: PointerExpectation,
): AppServerPointerDecision {
  return providerPointerDecision(path, expect)
}

const appServerPointerIsValid = (path: string, expect: PointerExpectation) =>
  appServerPointerDecision(path, expect).kind === "valid"

export function askChatWasSaved(
  sessionFile: string | null,
  expect?: PointerExpectation,
): boolean {
  if (!sessionFile) return false
  if (expect) return appServerPointerIsValid(sessionFile, expect)
  try {
    return statSync(sessionFile).isFile()
  } catch {
    return false
  }
}

export function finalizeAskSessionPointer(
  sessionFile: string | null,
  accept: boolean,
  pendingFile?: string,
  expect?: PointerExpectation,
): boolean {
  if (!sessionFile) return false
  const pending = pendingFile ?? `${sessionFile}.pending`
  const discard = () => {
    try {
      rmSync(pending, { force: true })
    } catch {
      // An invalid pending path is never accepted as session authority.
    }
  }
  if (!accept) {
    discard()
    return false
  }
  try {
    const candidate = lstatSync(pending)
    if (!candidate.isFile() || candidate.isSymbolicLink()) {
      discard()
      return false
    }
    if (expect && !appServerPointerIsValid(pending, expect)) {
      discard()
      return false
    }
    renameSync(pending, sessionFile)
    return true
  } catch {
    discard()
    return false
  }
}

/* Presentation helpers.
 *
 * These stay in this module so the React layer holds no logic that a focused
 * Bun test cannot reach without constructing a renderer. Every width and
 * height below is a hard terminal budget; wrapping cannot silently grow the
 * monotonic footer beyond its current promoted surface. */

export type WorkbenchPhase =
  | "ready"
  | "loading"
  | "streaming"
  | "answer"
  | "analysis"
  | "candidate"
  | "failed"
  | "cancelled"

export function switchAskEngine(
  state: {
    conversation: AskConversation
    askPreview: AskPreviewState
    diagnosis: string | null
    editorMode: EditorMode
    intent: SessionIntent
    lastAskQuery: string
    newAskSession: boolean
    phase: WorkbenchPhase
  },
  engine: CodexAskEngine,
  saved: boolean,
) {
  const label = engine === "app-server" ? "App Server" : "Codex Exec"
  const askActive = state.intent === "ask"
  const detail = state.newAskSession
    ? `new chat armed · ${engine === "app-server" ? "App" : "Exec"}`
    : `next Ask uses ${label} · ${saved ? "saved" : "new"} chat for this cwd`
  return {
    ...state,
    conversation: emptyAskConversation(),
    askPreview: { note: "", text: "", thinking: "" },
    diagnosis: askActive ? null : state.diagnosis,
    editorMode: askActive ? ("composer" as const) : state.editorMode,
    lastAskQuery: "",
    phase: askActive ? ("ready" as const) : state.phase,
    detail,
  }
}
export type WorkbenchView = "main" | "details" | "doctor"
export type EditorMode = "composer" | "view" | "prompt" | "command" | "context" | "endpoint"
export type Density = "narrow" | "medium" | "wide"
export type OutputState = "Available" | "Included" | "Held" | "Unavailable"

export type DoctorRow = { key: string; value: string }

const doctorRow = (
  status: "PASS" | "WARN" | "FAIL",
  key: string,
  value: string,
): DoctorRow => ({ key: `${status} ${key}`, value })

export function captureDoctorRows(state: {
  cwd: string
  providerId: ProviderId | null
  providerSource: ProviderSource
  providerAvailable: boolean
  adapterAvailable: boolean
  settings: PersistedInferenceDocumentState
  localEndpoint?: LocalEndpointResolution
  pointer: AppServerPointerDecision | null
  pointerRequired: boolean
  pointerWillStartNew: boolean
}): DoctorRow[] {
  let cwdAvailable = false
  try {
    cwdAvailable = statSync(state.cwd).isDirectory()
  } catch {}

  const providerStatus =
    state.providerSource === "configured"
      ? doctorRow("WARN", "provider", "launch-validated; not rechecked")
      : state.providerId !== null && state.providerAvailable && state.adapterAvailable
        ? doctorRow("PASS", "provider", `${state.providerId} is available locally`)
        : doctorRow("FAIL", "provider", "selected provider or adapter unavailable")

  const settingsRow =
    state.localEndpoint && !state.localEndpoint.endpoint
      ? doctorRow(state.providerSource === "default" && state.providerId === LOCAL_PROVIDER_ID ? "FAIL" : "WARN", "settings",
          state.localEndpoint.readOnly ? localEndpointUnavailableMessage(state.localEndpoint)
            : state.providerSource === "default" && state.providerId === LOCAL_PROVIDER_ID
              ? "local endpoint unavailable; configure local endpoint" : "local endpoint needs configuration")
      : state.localEndpoint && (state.localEndpoint.source === "not saved" || state.settings.kind === "invalid" || state.settings.kind === "operational-error")
        ? doctorRow("WARN", "settings", "settings not saved; in-memory configuration active")
      : state.settings.kind === "valid" && state.settings.sourceVersion === 2
      ? doctorRow("PASS", "settings", "valid v2 file")
      : state.settings.kind === "missing"
        ? doctorRow("PASS", "settings", "missing; in-memory defaults active")
        : state.settings.kind === "valid" && state.settings.sourceVersion === 1
          ? doctorRow("WARN", "settings", "legacy v1 remains; in-memory settings active")
          : doctorRow("WARN", "settings", "file ignored; in-memory settings active")

  const pointerRow = !state.pointerRequired
    ? doctorRow("PASS", "Ask pointer", "one-shot; no pointer required")
    : state.pointer?.kind === "valid"
      ? doctorRow("PASS", "Ask pointer", "valid provider/cwd metadata")
      : state.pointer?.kind === "missing"
        ? doctorRow("PASS", "Ask pointer", "missing; new chat")
        : state.pointerWillStartNew
          ? doctorRow("WARN", "Ask pointer", "invalid old pointer; new chat will start")
          : doctorRow("FAIL", "Ask pointer", "invalid pointer blocks next Ask; use ^X N")

  return [
    doctorRow(
      cwdAvailable ? "PASS" : "FAIL",
      "cwd",
      cwdAvailable ? terminalLiteral(state.cwd) : "missing or not a directory",
    ),
    providerStatus,
    settingsRow,
    pointerRow,
  ]
}

export const COMPACT_FOOTER_HEIGHT = 3
export const READER_FOOTER_HEIGHT = 8
export const DETAILS_FOOTER_HEIGHT = 12
// SPIKE(local-stream-ask): content-driven Ask streaming/answer envelope.
// The finalized footer receipt (workbench.ts run()) and shellq.plugin.zsh's
// peak-height check must both accept this bound.
export const ASK_STREAM_MAX_FOOTER_HEIGHT = 16

// Maps rendered Ask content rows onto the promoted envelope in fixed steps
// (8 → 12 → 16), never below the eight-row reader promotion and never past
// the smaller of `ASK_STREAM_MAX_FOOTER_HEIGHT` and one row less than the
// physical terminal (the ZLE prompt keeps its own row). `contentLines`
// includes the composer row; the two border rows are added here.
export function steppedAskFooterHeight(contentLines: number, terminalRows: number): number {
  const needed = Math.max(0, contentLines) + 2
  const ceiling = Math.max(
    1,
    Math.min(ASK_STREAM_MAX_FOOTER_HEIGHT, terminalRows - 1),
  )
  for (const step of [4, READER_FOOTER_HEIGHT, DETAILS_FOOTER_HEIGHT, ASK_STREAM_MAX_FOOTER_HEIGHT]) {
    if (needed <= step) return Math.min(step, ceiling)
  }
  return ceiling
}

export const isEditingMode = (mode: EditorMode) =>
  mode === "prompt" || mode === "command" || mode === "context" || mode === "endpoint"

export type RailGlyphs = {
  bottomLeft: string
  bottomRight: string
  horizontal: string
  topLeft: string
  topRight: string
  vertical: string
}

const UNICODE_RAIL_GLYPHS: RailGlyphs = {
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  topLeft: "╭",
  topRight: "╮",
  vertical: "│",
}

const ASCII_RAIL_GLYPHS: RailGlyphs = {
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  topLeft: "+",
  topRight: "+",
  vertical: "|",
}

export const railGlyphs = (unicode: boolean): RailGlyphs =>
  unicode ? UNICODE_RAIL_GLYPHS : ASCII_RAIL_GLYPHS

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
})
const graphemes = (value: string) =>
  Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)

export const terminalWidth = (value: string) => Bun.stringWidth(value)

export function sliceCells(
  value: string,
  start: number,
  limit: number,
): string {
  if (limit <= 0) return ""

  let position = 0
  let width = 0
  let result = ""
  for (const segment of graphemes(value)) {
    const segmentWidth = terminalWidth(segment)
    const end = position + segmentWidth
    if (end <= start) {
      position = end
      continue
    }
    if (width + segmentWidth > limit) break
    result += segment
    width += segmentWidth
    position = end
  }
  return result
}

export function truncateCells(value: string, limit: number): string {
  if (limit <= 0) return ""
  if (terminalWidth(value) <= limit) return value
  if (limit === 1) return "…"
  return `${sliceCells(value, 0, limit - 1)}…`
}

export function visibleShellText(value: string): string {
  let visible = ""
  for (const character of Array.from(value).slice(0, 8192)) {
    if (character === "\n") {
      visible += " ↵ "
    } else if (character === "\t") {
      visible += " ⇥ "
    } else {
      const code = character.codePointAt(0)!
      visible +=
        code < 32 ||
        (code >= 127 && code <= 159) ||
        /\p{Bidi_Control}/u.test(character)
          ? `\\u{${code.toString(16)}}`
          : character
    }
  }
  return visible
}

export function metadataWindow(
  value: string,
  offset: number,
  limit: number,
  unicode = true,
): string {
  if (limit <= 0) return ""
  const safeOffset = Math.max(0, offset)
  const left = safeOffset > 0
  let contentLimit = Math.max(1, limit - (left ? 1 : 0))
  let content = sliceCells(value, safeOffset, contentLimit)
  let right = safeOffset + terminalWidth(content) < terminalWidth(value)
  if (right && contentLimit > 1) {
    contentLimit -= 1
    content = sliceCells(value, safeOffset, contentLimit)
    right = safeOffset + terminalWidth(content) < terminalWidth(value)
  }
  return `${left ? (unicode ? "‹" : "<") : ""}${content}${right ? (unicode ? "›" : ">") : ""}`
}

// A native title paints into the border row starting after the border
// column plus `paddingLeft`, so a click's x coordinate needs the same
// offset subtracted before it can be tested against a span from `modeTabs`
// or `statusRail`. Both origins happen to be 2 (border + one padding cell).
export const TITLE_ORIGIN_X = 2
export const INTERIOR_ORIGIN_X = 2

// The native frame owns two border columns and one padding column on each
// side, so the interior is `width - 4` — narrower than the retired rail
// layout's `width - 2`. `titleBudget` equals `interior` because the native
// title draws inside that same padded region; `composer` further subtracts
// the two-cell prompt gutter.
export function frameLayout(width: number): {
  composer: number
  density: Density
  interior: number
  titleBudget: number
} {
  const interior = Math.max(8, width - 4)
  const titleBudget = interior
  const composer = Math.max(4, interior - 2)
  const density: Density =
    width >= 128 ? "wide" : width >= 96 ? "medium" : "narrow"
  return { composer, density, interior, titleBudget }
}

export function confidenceBand(confidence: number): "high" | "good" | "low" {
  if (confidence >= 0.9) return "high"
  if (confidence >= 0.7) return "good"
  return "low"
}

export function candidateRisk(risk: string): { label: string; level: "low" | "medium" | "high" | null } {
  // Risk is provider prose, not an enum. Never infer safety from an arbitrary
  // sentence containing "low"; only recognize an explicit leading assessment.
  const match = /^(low|medium|med|moderate|high)\b/i.exec(risk.trim())
  if (!match) return { label: risk, level: null }
  const level = /^(med|moderate)/i.test(match[1]!) ? "medium" : match[1]!.toLowerCase() as "low" | "high"
  return { label: level[0]!.toUpperCase() + level.slice(1), level }
}

export const CANDIDATE_MARKER_WIDTH = 5

export function candidateRowMarker(
  index: number,
  selected: boolean,
  unicode = true,
): string {
  return `${selected ? (unicode ? "›" : ">") : " "} ${index + 1}  `
}

export function commandLines(
  command: string,
  width: number,
  rows = 2,
): string[] {
  const lines: string[] = []
  const segments = graphemes(visibleShellText(command))
  let index = 0

  if (width > 0) {
    while (index < segments.length && lines.length < rows) {
      if (lines.length === rows - 1) {
        lines.push(truncateCells(segments.slice(index).join(""), width))
        index = segments.length
        break
      }

      let line = ""
      let lineWidth = 0
      while (index < segments.length) {
        const segmentWidth = terminalWidth(segments[index])
        if (lineWidth + segmentWidth > width) break
        line += segments[index]
        lineWidth += segmentWidth
        index += 1
      }
      if (!line && index < segments.length) {
        line = truncateCells(segments[index], width)
        index += 1
      }
      lines.push(line)
    }
  }
  while (lines.length < rows) lines.push("")
  return lines
}

// Wrap once from left to right. Conversation prose breaks at word boundaries;
// commands use the default character boundary so their bytes stay visible.
export function wrappedTextLines(
  value: string,
  width: number,
  boundary: "character" | "word" = "character",
): string[] {
  if (width <= 0) return []
  const wrapped: string[] = []
  for (const line of value.split(/\r?\n/u)) {
    if (!line) {
      wrapped.push("")
      continue
    }
    let row: string[] = []
    let rowWidths: number[] = []
    let rowWidth = 0
    let lastBreak = -1
    let hasWord = false
    const flush = (end = row.length) => {
      const text = row.slice(0, end).join("")
      wrapped.push(boundary === "word" ? text.trimEnd() : text)
      row = row.slice(end)
      rowWidths = rowWidths.slice(end)
      rowWidth = rowWidths.reduce((total, current) => total + current, 0)
      lastBreak = -1
      hasWord = row.some((segment) => !/\s/u.test(segment))
      if (boundary === "word" && hasWord) {
        row.forEach((segment, index) => {
          if (/\s/u.test(segment)) lastBreak = index + 1
        })
      }
    }
    for (const segment of graphemes(line)) {
      const segmentWidth = terminalWidth(segment)
      while (row.length && rowWidth + segmentWidth > width) {
        flush(boundary === "word" && lastBreak > 0 ? lastBreak : row.length)
      }
      row.push(segment)
      rowWidths.push(segmentWidth)
      rowWidth += segmentWidth
      if (/\s/u.test(segment)) {
        if (hasWord) lastBreak = row.length
      } else {
        hasWord = true
      }
    }
    if (row.length) flush()
  }
  return wrapped
}

export const steppedConversationOffset = (
  current: number,
  maximum: number,
  delta: number,
) => Math.max(0, Math.min(maximum, Math.min(current, maximum) + delta))

// The selected candidate is the one surface whose job is reviewing a command
// before it is inserted, so it shows real line breaks on real rows instead of
// folding them into a marker. Unselected rows keep using `visibleShellText`,
// which folds, so the list stays one row per candidate and comparable.
export function selectedCommandLines(
  command: string,
  width: number,
  rows: number,
): string[] {
  if (width <= 0 || rows <= 0) return []

  const wrapped = wrappedTextLines(
    command.split(/\r?\n/u).map(visibleShellText).join("\n"),
    width,
  )

  if (wrapped.length <= rows) return wrapped
  // Running out of rows must read as truncation, not as a shorter command.
  const kept = wrapped.slice(0, rows)
  kept[rows - 1] = truncateCells(`${kept[rows - 1]} `, width - 1) + "\u2026"
  return kept
}

export function contextSummary(state: {
  contextBytes: number
  contextLabel: string
  contextSource: string
  included: boolean
}): string {
  if (!state.contextBytes) {
    return state.contextSource === "none"
      ? "output Unavailable · paste is available"
      : "output Available · no retained pane text"
  }
  const provenance =
    state.contextSource === "none"
      ? "edited/pasted"
      : `${state.contextSource} ${state.contextLabel}`
  return `${provenance} · ${state.contextBytes} bytes · output ${
    state.included ? "Included" : "Held"
  }`
}

export function outputState(state: {
  contextBytes: number
  contextSource: string
  included: boolean
}): OutputState {
  if (state.contextBytes) return state.included ? "Included" : "Held"
  return state.contextSource === "none" ? "Unavailable" : "Available"
}

const MODE_ORDER: SessionIntent[] = ["ask", "generate", "correct"]
const MODE_LABELS: Record<SessionIntent, string> = {
  ask: "Ask",
  generate: "Command",
  correct: "Fix",
}

// The native box draws its own top border, so this only needs to produce the
// title text itself — no glyphs, no fill, no corners. The selected mode is
// bracketed rather than coloured because the native title draws in a single
// `titleColor`; brackets are the accessible carrier of selection.
export type ModeTabs = {
  spans: Record<SessionIntent, RailSpan>
  text: string
}

// A click hit-tests against `spans`, keyed by the intent it would switch to.
// Clicking the current intent's own span is a rule-level no-op, not
// something this pure function decides.
export function modeTabs(
  intent: SessionIntent,
  width: number,
  unicode: boolean,
): ModeTabs {
  const separator = unicode ? " · " : " | "
  let cursor = 0
  const spans = {} as Record<SessionIntent, RailSpan>
  const parts = MODE_ORDER.map((mode) => {
    const token = mode === intent ? `[${MODE_LABELS[mode]}]` : MODE_LABELS[mode]
    const start = cursor
    const end = start + terminalWidth(token)
    spans[mode] = { end, start }
    cursor = end + terminalWidth(separator)
    return token
  })
  const tabs = parts.join(separator)
  // truncateCells appends a non-ASCII ellipsis on overflow, which would
  // reintroduce a byte above 0x7f into the ASCII fallback. A hard cell slice
  // keeps the ASCII form byte-safe even at widths too narrow to fit fully.
  const text = unicode
    ? truncateCells(tabs, width)
    : terminalWidth(tabs) <= width
      ? tabs
      : sliceCells(tabs, 0, Math.max(0, width))
  const visibleWidth = terminalWidth(text)
  const clipped = {} as Record<SessionIntent, RailSpan>
  for (const mode of MODE_ORDER) {
    clipped[mode] = {
      end: Math.min(spans[mode].end, visibleWidth),
      start: Math.min(spans[mode].start, visibleWidth),
    }
  }
  return { spans: clipped, text }
}

export function modeTabsLine(
  intent: SessionIntent,
  width: number,
  unicode: boolean,
): string {
  return modeTabs(intent, width, unicode).text
}

export type TopRailState = {
  intent: SessionIntent
  provider?: string
  model: string
  reasoning: string
}

export type TopRail = {
  spans: {
    mode: Record<SessionIntent, RailSpan>
    provider: RailSpan | null
    model: RailSpan | null
    reasoning: RailSpan | null
  }
  text: string
}

// The top border's left content is `modeTabs`, unchanged. The right content
// is model and reasoning, right-aligned flush against the corner. A native
// title only supports one alignment, so both ends of the same row have to
// live in one string that this function builds and fills itself — with the
// border's own glyph, never a space, or the fill would blank the border.
// `modeTabs` is always asked for the full `budget`, so its own truncation
// already *is* the ladder's last "truncate the tabs" rung: reasoning and
// then the model are dropped first, and only a budget too narrow for the
// tabs alone would ever reach that inherited truncation.
export function topRail(
  state: TopRailState,
  width: number,
  unicode: boolean,
): TopRail {
  const budget = Math.max(1, width)
  const glyph = railGlyphs(unicode).horizontal
  const SEP = unicode ? " · " : " | "

  const tabs = modeTabs(state.intent, budget, unicode)
  const tabsWidth = terminalWidth(tabs.text)

  let reasoningIncluded = Boolean(state.reasoning) && state.reasoning !== "endpoint default"
  let providerIncluded = state.provider !== undefined
  let modelIncluded = true
  const rightWidth = () => {
    if (!modelIncluded) return 0
    const modelWidth = terminalWidth(modelLabel(state.model))
    const providerWidth = providerIncluded
      ? terminalWidth(state.provider!) + terminalWidth(SEP)
      : 0
    if (!reasoningIncluded) return providerWidth + modelWidth
    return providerWidth + modelWidth + terminalWidth(SEP) + terminalWidth(state.reasoning)
  }
  if (tabsWidth + rightWidth() > budget) reasoningIncluded = false
  if (tabsWidth + rightWidth() > budget) providerIncluded = false
  if (tabsWidth + rightWidth() > budget) modelIncluded = false

  const providerPrefix = providerIncluded ? `${state.provider}${SEP}` : ""
  const rightText = !modelIncluded
    ? ""
    : reasoningIncluded
      ? `${providerPrefix}${modelLabel(state.model)}${SEP}${state.reasoning}`
      : `${providerPrefix}${modelLabel(state.model)}`
  const fillWidth = Math.max(0, budget - tabsWidth - terminalWidth(rightText))
  const text = truncateCells(
    `${tabs.text}${glyph.repeat(fillWidth)}${rightText}`,
    budget,
  )
  const visibleWidth = terminalWidth(text)

  const rightStart = Math.max(0, visibleWidth - terminalWidth(rightText))
  const model: RailSpan | null = modelIncluded
    ? {
        end: Math.min(
          rightStart +
            (providerIncluded ? terminalWidth(state.provider!) + terminalWidth(SEP) : 0) +
            terminalWidth(modelLabel(state.model)),
          visibleWidth,
        ),
        start: Math.min(
          rightStart +
            (providerIncluded ? terminalWidth(state.provider!) + terminalWidth(SEP) : 0),
          visibleWidth,
        ),
      }
    : null
  const reasoning: RailSpan | null =
    modelIncluded && reasoningIncluded && model
      ? {
          end: Math.min(
            model.end + terminalWidth(SEP) + terminalWidth(state.reasoning),
            visibleWidth,
          ),
          start: Math.min(model.end + terminalWidth(SEP), visibleWidth),
        }
      : null
  const provider: RailSpan | null =
    providerIncluded && model
      ? {
          start: rightStart,
          end: Math.min(rightStart + terminalWidth(state.provider!), visibleWidth),
        }
      : null

  const mode = {} as Record<SessionIntent, RailSpan>
  for (const target of MODE_ORDER) {
    mode[target] = {
      end: Math.min(tabs.spans[target].end, visibleWidth),
      start: Math.min(tabs.spans[target].start, visibleWidth),
    }
  }

  return { spans: { mode, provider, model, reasoning }, text }
}

export function topRailLine(
  state: TopRailState,
  width: number,
  unicode: boolean,
): string {
  return topRail(state, width, unicode).text
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes}b`
  return `${(bytes / 1000).toFixed(1)}k`
}

// The only rail actions a pointer may trigger. `contextualAction` can also
// return `Enter insert (never runs)` (or, once taught, `↵ insert`),
// `Enter retry`, and `Esc cancel`, which would insert into the shell
// buffer, submit a request, or cancel one — no pointer path is allowed to
// do any of those, so they are absent by design and their absence is
// asserted, not assumed.
export const POINTER_REACHABLE_ACTIONS: readonly string[] = [
  "Esc back",
  "^X W save",
]

export function transmissionLabel(bytes: number, included: boolean): string {
  // Held back reads as a plain call to action; the byte count only earns its
  // place once the block is actually attached, which is also the one state
  // where it changes what a click would do (detach rather than attach). The
  // exact Included/Held state stays spelled out on the actions sheet and in
  // Ctrl-X H details, which is where the unambiguous reading lives.
  return included
    ? `Output attached (${estimateTokens(bytes)})`
    : "Attach output"
}

// Bytes are a storage fact; what the user is deciding about is how much of a
// model's context window the attachment will consume, so the label reports an
// estimate in tokens instead.
//
// It is an estimate and says so with `~`: there is no tokenizer here and
// adding one would mean a new dependency. Terminal output is code-like —
// paths, punctuation, short tokens — which packs closer to 3.5 bytes per
// token than the ~4 typical of prose. Rounded to two significant figures so
// the number never implies a precision it does not have.
export function estimateTokens(bytes: number): string {
  const tokens = Math.max(1, Math.round(bytes / 3.5))
  if (tokens < 1000) {
    const rounded = tokens < 100 ? tokens : Math.round(tokens / 10) * 10
    return `~${rounded} tokens`
  }
  return `~${(tokens / 1000).toFixed(1)}k tokens`
}

export type RailSpan = { end: number; start: number }

function homeRelative(cwd: string): string {
  const sanitized = cwd.replace(/[\x00-\x1f\x7f-\x9f]|\p{Bidi_Control}/gu, "")
  const home = homedir()
  if (sanitized === home) return "~"
  if (sanitized.startsWith(`${home}/`)) return `~${sanitized.slice(home.length)}`
  return sanitized
}

// The rail's identifying token for cwd is the tail of the path, not the
// root, so density pressure truncates the prefix while a deeper fallback
// (`railCwdTail`) keeps only the last path segment behind a leading ellipsis.
export function railCwd(cwd: string, limit: number): string {
  return truncateCells(homeRelative(cwd), limit)
}

function railCwdTail(cwd: string): string {
  const relative = homeRelative(cwd)
  const base = relative.split("/").filter(Boolean).pop()
  return base ? `…/${base}` : relative
}

const RAIL_SEP = " · "

// The bottom border's left slot shows cwd by default and yields entirely to
// a transient message (a provider error, cancellation, loading, a
// confirmation) when the caller supplies one — the two are mutually
// exclusive, never concatenated. Disclosure (the captured-output toggle) now
// rides in the right group, immediately left of the Ctrl-X keys, so it keeps
// the same position whether or not an action is showing.
export type BottomRailState = {
  // The precomputed result of `contextualAction`. It is an anchor: cwd/
  // message truncates rather than displacing it, and `^X` only drops to
  // protect it.
  action: string
  contextBytes: number
  cwd: string
  included: boolean
  showCtrlX?: boolean
  // Caller-resolved transient text (an explicit result, or a loading/error/
  // cancel word) that replaces cwd until the caller's own next state change
  // clears it. `null` shows cwd.
  message: string | null
  messageMaxWidth?: number
}

export type BottomRail = {
  spans: {
    message: RailSpan | null
    action: RailSpan | null
    ctrlX: RailSpan | null
    disclosure: RailSpan | null
  }
  text: string
}

// This returns only the rail's text content — no `╰ … ╯` wrapping — and
// callers pass `frameLayout(width).titleBudget` as the width budget, then
// fill to it themselves the same way `topRail` does: the model/reasoning
// range that used to live here moved to the top border, and the note slot
// (candidate position, exit status, saved-chat, `ro`) is retired outright —
// those remain in Ctrl-X H details.
//
// Declared grammar: `cwd-or-message ── [ action · ] disclosure · keys`.
// Under narrowing width the rail degrades through a fixed four-rung ladder,
// each rung firing only if still over budget: shorten `^X actions` to `^X`,
// then truncate the left slot, then drop disclosure (now from the right
// group, same declared order), then drop `^X` entirely (only when there is a
// shown action to protect by doing so).
type BottomLadderState = {
  ctrlX: "actions" | "none" | "short"
  discText: string
  leftText: string
}

// Each rung mutates exactly one field, in the declared drop order. `field`
// names which key the reverse-restore pass below reverts to undo it.
type BottomRung = {
  apply: (s: BottomLadderState) => BottomLadderState
  field: keyof BottomLadderState
}

export function bottomRail(
  state: BottomRailState,
  width: number,
  unicode: boolean,
): BottomRail {
  const budget = Math.max(1, width)
  const glyph = railGlyphs(unicode).horizontal
  const { density } = frameLayout(width)
  // The left group is now cwd alone — the model moved to the top border and
  // the disclosure moved into the right group — so the old density caps
  // (18/28/40) were throwing away room the rail actually has: 49 free cells
  // at 80 columns resting, 109 at 140. Give cwd whatever the right group is
  // not using and let the ladder truncate it under pressure, which it already
  // knows how to do. One fewer tuning knob, and a path you can usually read
  // in full.
  const cwdCap = budget
  const messageCap = state.messageMaxWidth ?? (density === "narrow" ? 24 : density === "medium" ? 40 : 60)

  const keysText = (s: BottomLadderState) =>
    s.ctrlX === "actions" ? "^X actions" : s.ctrlX === "short" ? "^X" : ""
  const assemble = (s: BottomLadderState) => {
    const left = s.leftText
    const right = [state.action, s.discText, keysText(s)]
      .filter(Boolean)
      .join(RAIL_SEP)
    const fillWidth = Math.max(
      0,
      budget - terminalWidth(left) - terminalWidth(right),
    )
    return `${left}${glyph.repeat(fillWidth)}${right}`
  }
  const fits = (s: BottomLadderState) => terminalWidth(assemble(s)) <= budget

  const initial: BottomLadderState = {
    ctrlX: state.showCtrlX === false ? "none" : "actions",
    discText:
      state.contextBytes > 0
        ? transmissionLabel(state.contextBytes, state.included)
        : "",
    leftText: state.message
      ? truncateCells(oneLine(state.message), messageCap)
      : railCwd(state.cwd, cwdCap),
  }

  const rungs: BottomRung[] = [
    {
      apply: (s) => state.showCtrlX === false ? s : { ...s, ctrlX: "short" },
      field: "ctrlX",
    },
    {
      apply: (s) => ({
        ...s,
        leftText: state.message
          ? truncateCells(oneLine(state.message), 16)
          : railCwdTail(state.cwd),
      }),
      field: "leftText",
    },
    { apply: (s) => ({ ...s, discText: "" }), field: "discText" },
    {
      // Dropping `^X` only helps when an action needs the room; with no
      // shown action this rung is a no-op, matching the declared "only to
      // protect a shown action".
      apply: (s) => (state.action ? { ...s, ctrlX: "none" } : s),
      field: "ctrlX",
    },
  ]

  // Forward pass: fire each rung only if the rail is still over budget,
  // recording a snapshot before and after so the reverse pass below knows
  // exactly what value each fired rung's field held immediately beforehand.
  const snapshots: BottomLadderState[] = [initial]
  const fired: boolean[] = []
  let working = initial
  for (const rung of rungs) {
    if (fits(working)) {
      fired.push(false)
    } else {
      working = rung.apply(working)
      fired.push(true)
    }
    snapshots.push(working)
  }

  // Reverse pass: same discipline as the retired single-line ladder — walk
  // fired rungs from most- to least-recently-fired, and for each try undoing
  // just that rung's field back to its pre-rung value, keeping the undo only
  // if the rail still fits. This reclaims slack a purely greedy forward pass
  // would waste without ever reordering the declared drop sequence.
  for (let index = rungs.length - 1; index >= 0; index -= 1) {
    if (!fired[index]) continue
    const field = rungs[index].field
    const reverted = { ...working, [field]: snapshots[index][field] }
    if (fits(reverted)) working = reverted
  }

  const text = truncateCells(assemble(working), budget)
  const visibleWidth = terminalWidth(text)

  const rightText = [state.action, working.discText, keysText(working)]
    .filter(Boolean)
    .join(RAIL_SEP)
  const rightStart = Math.max(0, visibleWidth - terminalWidth(rightText))

  // Only a dismissive action is ever hit-tested by the caller — a pointer
  // must never reach `Enter insert (never runs)`/`↵ insert`, `Enter retry`,
  // or `Esc cancel`. The span is emitted regardless so the safety rule lives
  // in exactly one place and stays testable.
  const action: RailSpan | null = state.action
    ? {
        end: Math.min(rightStart + terminalWidth(state.action), visibleWidth),
        start: Math.min(rightStart, visibleWidth),
      }
    : null

  // The disclosure sits immediately left of the keys: after the action and
  // its separator when an action is showing, otherwise at the right group's
  // own start — so its position (and click range) never moves depending on
  // whether an action is present.
  const disclosureStart = action
    ? Math.min(action.end + terminalWidth(RAIL_SEP), visibleWidth)
    : rightStart
  const disclosure: RailSpan | null = working.discText
    ? {
        end: Math.min(
          disclosureStart + terminalWidth(working.discText),
          visibleWidth,
        ),
        start: Math.min(disclosureStart, visibleWidth),
      }
    : null

  // `^X` (in either form) is always the last token when present, so its
  // span is the tail of the visible text.
  const ctrlX: RailSpan | null =
    working.ctrlX !== "none"
      ? {
          end: visibleWidth,
          start: Math.max(0, visibleWidth - terminalWidth(keysText(working))),
        }
      : null

  return { spans: { action, ctrlX, disclosure, message: state.message ? {start:0,end:Math.min(terminalWidth(working.leftText),visibleWidth)} : null }, text }
}

export function bottomRailLine(
  state: BottomRailState,
  width: number,
  unicode: boolean,
): string {
  return bottomRail(state, width, unicode).text
}

export type SettingsField = "provider" | "engine" | "model" | "reasoning"
export type SettingsPaletteView = "root" | "model" | "effort" | "provider" | "more" | "engine" | "choices"
export type UniversalPaletteKind = "set" | "toggle" | "open" | "guard" | "n-a"
export type UniversalPaletteAction =
  | "set-initial-choices"
  | "open-palette-view"
  | "toggle-context"
  | "mode-ask"
  | "mode-command"
  | "mode-fix"
  | "open-context"
  | "open-doctor"
  | "open-details"
  | "open-candidate-details"
  | "open-candidate-edit"
  | "open-provider-setup"
  | "configure-local-endpoint"
  | "check-local-models"
  | "guard-another"
  | "guard-insert"
  | "guard-save"
  | "guard-new-chat"
  | "refusal-context"
  | "refusal-fix"
  | "refusal-another"
  | "refusal-new-chat"
  | "refusal-save"
export type UniversalPaletteField = SettingsField | "action"
export type UniversalPaletteIdentity = {
  field: UniversalPaletteField
  authorityKey: string
  sourceIndex: number
  value: string
}
export type UniversalPaletteDestination =
  | {
      authority: { kind: "managed"; providerId: ProviderId }
      providerId: ProviderId
      providerSource: "default"
      model: string
      reasoning: string
      engine: CodexAskEngine | null
      // Local-only: the exact loopback endpoint this pair activates. The same
      // model ID on two endpoints is two distinct destinations.
      endpoint?: string
    }
  | {
      authority: { kind: "configured" }
      providerId: null
      providerSource: "configured"
      model: string
      reasoning: string
      engine: null
      endpoint?: undefined
    }

export type SettingsPickerSource = {
  field: UniversalPaletteField
  sourceIndex: number
  value: string
  display: string
  publicId?: string
  providerLabel?: string
  active?: boolean
  current?: boolean
  kind?: UniversalPaletteKind
  action?: UniversalPaletteAction
  authorityKey?: string
  label?: string
  effect?: string
  chord?: string
  destination?: UniversalPaletteDestination
  order?: number
  paletteView?: SettingsPaletteView
}
export type SettingsPickerResult = SettingsPickerSource & {
  score: number[]
}

export type UniversalPaletteRecord = SettingsPickerSource & {
  kind: UniversalPaletteKind
  identity: UniversalPaletteIdentity
  label: string
  effect: string
}

type UniversalPaletteStatusRecord =
  Pick<UniversalPaletteRecord, "current" | "kind"> &
  Partial<Pick<UniversalPaletteRecord, "field">>

const paletteDisplayText = (value: string, unicode: boolean) =>
  unicode
    ? value
    : value.replaceAll("→", "->").replaceAll("·", "/").replaceAll("…", "...")

const paletteTruncate = (value: string, width: number, unicode: boolean) => {
  if (unicode) return truncateCells(value, width)
  if (width <= 0) return ""
  if (terminalWidth(value) <= width) return value
  if (width <= 3) return ".".repeat(width)
  return `${sliceCells(value, 0, width - 3)}...`
}

export function universalPaletteStatus(
  focused: UniversalPaletteStatusRecord | undefined,
  applying: boolean,
  _status: string,
  width: number,
  unicode: boolean,
  escapeAction: "clear" | "back" | "close" = "back",
): string {
  if (applying) return ""
  const enter = !focused || focused.kind === "n-a"
    ? ""
    : focused.kind === "guard" || focused.kind === "open"
      ? "Enter open"
      : focused.kind === "toggle"
        ? "Enter toggle"
        : focused.current && focused.field === "model"
          ? "Enter effort"
          : focused.current && focused.field === "reasoning"
            ? "Enter done"
          : focused.current
            ? "Enter keep"
            : "Enter apply"
  return paletteTruncate(
    paletteDisplayText(
      [enter, `Esc ${escapeAction}`].filter(Boolean).join(" · "),
      unicode,
    ),
    width,
    unicode,
  )
}

export type UniversalPaletteBuildContext = {
  initialChoices?: number
  providerId: ProviderId | null
  providerSource: ProviderSource
  model: string
  reasoning: string
  engine: CodexAskEngine | null
  codexEngineAvailable?: boolean
  codexEngine?: CodexAskEngine | null
  configuredModels?: string[]
  configuredReasoningLevels?: string[]
  persisted?: Partial<Record<ProviderId, PersistedInferenceSettings | null>>
  availableProviders: Array<Pick<ProviderDescriptor, "id" | "models" | "reasoningLevels"> & { selectable: boolean }>
  doctorAvailable: boolean
  anotherAvailable: boolean
  codexLunaReasoning?: string
  intent?: SessionIntent
  phase?: WorkbenchPhase
  view?: WorkbenchView
  editorMode?: EditorMode
  editing?: boolean
  hasCandidateList?: boolean
  hasCapturedContext?: boolean
  includeContext?: boolean
  fixAvailable?: boolean
  codexCatalog?: ProviderCapabilityCatalog | null
  codexDiscoveryState?: CodexDiscoveryState
  providerCatalogs?: Partial<Record<ProviderId, ProviderCapabilityCatalog | null>>
  localCheckAvailable?: boolean
  localChecking?: boolean
  // Entries are "endpoint model" pairs (endpoints contain no whitespace), so
  // a model blocked on one endpoint never blocks the same ID on another.
  blockedLocalModels?: string[]
  // The current effective local endpoint, for current/equality checks.
  localEndpoint?: string | null
  // Per-endpoint discovered catalogs feeding endpoint-aware local model rows.
  localEndpointCatalogs?: Record<string, ProviderCapabilityCatalog | null>
  paletteView?: SettingsPaletteView
}

export function settingsPaletteRestoredIndex(
  focused: UniversalPaletteRecord | undefined,
  sources: UniversalPaletteRecord[],
): number {
  if (!focused?.identity) return 0
  const index = sources.findIndex((source) =>
    source.kind === focused.kind &&
    source.value === focused.value &&
    source.identity?.field === focused.identity?.field &&
    source.identity.authorityKey === focused.identity.authorityKey &&
    source.identity.value === focused.identity.value
  )
  return Math.max(0, index)
}

// Provider ids may be hyphenated (`local-openai`); the palette shows the first
// segment capitalized so a leaf reads `Local/<model>` and matches the token the
// Provider Setup availability row already prints for the same provider.
export const paletteProviderLabel = (id: ProviderId) => {
  const [first] = id.split("-")
  return first[0].toUpperCase() + first.slice(1)
}

const paletteDestinationLabel = (destination: UniversalPaletteDestination) =>
  destination.authority.kind === "configured"
    ? `Configured/${modelLabel(destination.model)} · ${destination.reasoning} · no engine`
    : `${paletteProviderLabel(destination.authority.providerId)}/${modelLabel(destination.model)} · ${destination.reasoning} · ${destination.engine ?? "no engine"}`

const paletteDestinationIsCurrent = (
  destination: UniversalPaletteDestination,
  context: UniversalPaletteBuildContext,
) => destination.authority.kind === "configured"
  ? context.providerSource === "configured" &&
    context.model === destination.model &&
    context.reasoning === destination.reasoning
  : context.providerSource === "default" &&
    context.providerId === destination.providerId &&
    context.model === destination.model &&
    context.reasoning === destination.reasoning &&
    context.engine === destination.engine &&
    (destination.endpoint === undefined || destination.endpoint === context.localEndpoint)

const paletteRecord = (
  context: UniversalPaletteBuildContext,
  input: {
    field: UniversalPaletteField
    authorityKey: string
    sourceIndex: number
    value: string
    label: string
    display?: string
    publicId?: string
    providerLabel?: string
    active?: boolean
    destination?: UniversalPaletteDestination
    chord?: string
    kind?: UniversalPaletteKind
    action?: UniversalPaletteAction
    effect?: string
    order: number
    paletteView?: SettingsPaletteView
  },
): UniversalPaletteRecord => {
  const kind = input.kind ?? "set"
  const destination = input.destination
  const effect = input.effect ?? (destination ? `→ ${paletteDestinationLabel(destination)}` : "")
  const current = destination
    ? input.field === "model"
      ? destination.authority.kind === "configured"
        ? context.providerSource === "configured" && context.model === destination.model
        : context.providerSource === "default" &&
          context.providerId === destination.providerId &&
          context.model === destination.model &&
          (destination.endpoint === undefined || destination.endpoint === context.localEndpoint)
      : paletteDestinationIsCurrent(destination, context)
    : false
  return {
    active: input.active ?? (
      destination?.authority.kind === "managed" &&
      context.providerSource === "default" &&
      destination.providerId === context.providerId
    ),
    authorityKey: input.authorityKey,
    chord: input.chord,
    current,
    destination,
    display: input.display ?? input.label,
    effect,
    field: input.field,
    identity: {
      authorityKey: input.authorityKey,
      field: input.field,
      sourceIndex: input.sourceIndex,
      value: input.value,
    },
    kind,
    action: input.action,
    label: input.label,
    order: input.order,
    providerLabel: input.providerLabel,
    publicId: input.publicId,
    paletteView: input.paletteView,
    sourceIndex: input.sourceIndex,
    value: input.value,
  }
}

const persistedFor = (
  context: UniversalPaletteBuildContext,
  providerId: ProviderId,
) => context.persisted?.[providerId] ?? null

type PaletteProvider = Pick<ProviderDescriptor, "id" | "models" | "reasoningLevels"> & {
  selectable: boolean
  capabilities?: ModelCapability[]
  sourceIndex: number
  // Local only: one row per (endpoint, model) pair, carrying that pair's
  // activation destination. Same ID on two endpoints is two rows.
  localModelRows?: Array<{ endpoint: string; capability: ModelCapability; destination: UniversalPaletteDestination }>
}

const capabilityForModel = (provider: PaletteProvider, model: string) =>
  provider.capabilities?.find((capability) => capability.model === model)

const advertisedModel = (
  provider: PaletteProvider,
  context: UniversalPaletteBuildContext,
  model?: string,
) => {
  const persisted = persistedFor(context, provider.id)
  if (model && provider.models.includes(model)) return model
  if (context.providerId === provider.id && provider.models.includes(context.model)) return context.model
  if (persisted && provider.models.includes(persisted.model)) return persisted.model
  if (provider.id === LOCAL_PROVIDER_ID) {
    if (model && SAFE_MODEL.test(model)) return model
    if (context.providerId === LOCAL_PROVIDER_ID && context.model && SAFE_MODEL.test(context.model)) return context.model
    if (persisted?.model && SAFE_MODEL.test(persisted.model)) return persisted.model
    return undefined
  }
  const advertisedDefault = provider.capabilities?.find((capability) => capability.isDefault)
  if (advertisedDefault) return advertisedDefault.model
  return provider.models[0]
}

const advertisedReasoning = (
  provider: PaletteProvider,
  context: UniversalPaletteBuildContext,
  reasoning?: string,
  model?: string,
) => {
  const modelEfforts = model ? capabilityForModel(provider, model)?.efforts : undefined
  const available = modelEfforts ?? provider.reasoningLevels
  const persisted = persistedFor(context, provider.id)
  if (reasoning && available.includes(reasoning)) return reasoning
  if (context.providerId === provider.id && available.includes(context.reasoning)) return context.reasoning
  if (persisted && available.includes(persisted.reasoning)) return persisted.reasoning
  return capabilityForModel(provider, model ?? "")?.defaultEffort ?? available[0]
}

const managedDestination = (
  provider: PaletteProvider,
  context: UniversalPaletteBuildContext,
  model?: string,
  reasoning?: string,
  engine?: CodexAskEngine | null,
  endpoint?: string | null,
): UniversalPaletteDestination | null => {
  const resolvedModel = advertisedModel(provider, context, model)
  const resolvedReasoning = advertisedReasoning(provider, context, reasoning, resolvedModel)
  if (!resolvedModel || !resolvedReasoning) return null
  return {
    authority: { kind: "managed", providerId: provider.id },
    providerId: provider.id,
    providerSource: "default",
    model: resolvedModel,
    reasoning: resolvedReasoning,
    engine: provider.id === "codex" ? engine ?? null : null,
    ...(provider.id === LOCAL_PROVIDER_ID && endpoint ? { endpoint } : {}),
  }
}

const providerDestination = (
  provider: PaletteProvider,
  context: UniversalPaletteBuildContext,
  engine?: CodexAskEngine | null,
): UniversalPaletteDestination | null => {
  const model = advertisedModel(provider, context)
  const reasoning = advertisedReasoning(provider, context, undefined, model)
  if (!model || !reasoning) return null
  return {
    authority: { kind: "managed", providerId: provider.id },
    providerId: provider.id,
    providerSource: "default",
    model,
    reasoning,
    engine: provider.id === "codex" ? engine ?? null : null,
    ...(provider.id === LOCAL_PROVIDER_ID && context.localEndpoint ? { endpoint: context.localEndpoint } : {}),
  }
}

export function buildUniversalPaletteSources(
  context: UniversalPaletteBuildContext,
): UniversalPaletteRecord[] {
  const records: UniversalPaletteRecord[] = []
  const managed = context.providerSource === "default"
  // Codex's catalog folds into the generic per-provider map so callers that
  // still pass `codexCatalog` (every existing caller) need no change, while
  // any provider's dynamic catalog can populate the same slot.
  const providerCatalogs: Partial<Record<ProviderId, ProviderCapabilityCatalog | null>> = {
    ...context.providerCatalogs,
    ...(context.codexCatalog !== undefined ? { codex: context.codexCatalog } : {}),
  }
  const providers: PaletteProvider[] = context.availableProviders
    .filter((provider) => provider.selectable)
    .map((provider) => {
      const dynamicCatalog = providerCatalogs[provider.id]
      const catalog = dynamicCatalog
        ? dynamicCatalog
        : explicitModelCatalog(provider.id, provider.models, provider.reasoningLevels)
      let models = catalog.models.map((model) => model.model)
      const reasoningLevels = [...new Set(catalog.models.flatMap((model) => model.efforts))]
      let capabilities = catalog.models

      if (provider.id === LOCAL_PROVIDER_ID) {
        // Endpoint-aware rows: each discovered endpoint contributes its own
        // catalog, so the same model ID on two servers stays two distinct
        // choices. A short `:port` hint appears only when more than one
        // endpoint is in play, and only here in settings.
        const blocked = context.blockedLocalModels ?? []
        const endpointCatalogs = Object.entries(context.localEndpointCatalogs ?? {})
          .filter((entry): entry is [string, ProviderCapabilityCatalog] => Boolean(entry[1]))
        const showPort = endpointCatalogs.length > 1
        const portHint = (endpoint: string) => {
          if (!showPort) return ""
          const parsed = parseLocalEndpoint(endpoint)
          return parsed ? ` :${parsed.port}` : ""
        }
        const pendingRows: Array<{ endpoint: string; capability: ModelCapability }> = []
        for (const [endpoint, endpointCatalog] of endpointCatalogs) {
          for (const capability of endpointCatalog.models) {
            const isBlocked = blocked.includes(`${endpoint} ${capability.model}`)
            const rowCapability = isBlocked || endpointCatalog.stale
              ? {
                  ...capability,
                  displayName: `${modelLabel(capability.model)}${isBlocked ? " · blocked" : " · unavailable"}${portHint(endpoint)}`,
                  description: isBlocked ? "Blocked local model" : "Unavailable local model",
                }
              : { ...capability, displayName: `${modelLabel(capability.model)}${portHint(endpoint)}` }
            pendingRows.push({ endpoint, capability: rowCapability })
          }
        }
        const persisted = persistedFor(context, LOCAL_PROVIDER_ID)
        const savedModel = (context.providerId === LOCAL_PROVIDER_ID && context.model && SAFE_MODEL.test(context.model))
          ? context.model
          : (persisted?.model && SAFE_MODEL.test(persisted.model))
            ? persisted.model
            : null
        const savedEndpoint = context.localEndpoint ?? endpointCatalogs[0]?.[0]
        if (savedModel && savedEndpoint && !pendingRows.some((row) => row.endpoint === savedEndpoint && row.capability.model === savedModel)) {
          const isBlocked = blocked.includes(`${savedEndpoint} ${savedModel}`)
          const isUnavailable = endpointCatalogs.some(([, entry]) => !entry.stale)
          const statusSuffix = isBlocked
            ? " · blocked"
            : isUnavailable
              ? " · unavailable"
              : " · saved preference"
          pendingRows.push({
            endpoint: savedEndpoint,
            capability: {
              id: savedModel,
              model: savedModel,
              displayName: `${modelLabel(savedModel)}${statusSuffix}${portHint(savedEndpoint)}`,
              description: isBlocked
                ? "Blocked local preference"
                : isUnavailable
                  ? "Unavailable local preference"
                  : "Saved local preference",
              efforts: reasoningLevels.length ? reasoningLevels : provider.reasoningLevels,
              defaultEffort: (reasoningLevels.length ? reasoningLevels : provider.reasoningLevels)[0],
              isDefault: false,
            },
          })
        }
        capabilities = pendingRows.map((row) => row.capability)
        models = capabilities.map((capability) => capability.model)
        const localReasoningLevels = [...new Set(capabilities.flatMap((capability) => capability.efforts))]
        const constructed: PaletteProvider = {
          ...provider,
          models,
          reasoningLevels: localReasoningLevels.length ? localReasoningLevels : provider.reasoningLevels,
          capabilities,
          localModelRows: [],
          sourceIndex: context.availableProviders.indexOf(provider),
        }
        constructed.localModelRows = pendingRows
          .map(({ endpoint, capability }) => ({
            endpoint,
            capability,
            destination: managedDestination(constructed, context, capability.model, undefined, null, endpoint),
          }))
          .filter((row): row is { endpoint: string; capability: ModelCapability; destination: UniversalPaletteDestination } =>
            Boolean(row.destination))
        return constructed
      }

      return {
        ...provider,
        models,
        reasoningLevels: reasoningLevels.length ? reasoningLevels : provider.reasoningLevels,
        capabilities,
        sourceIndex: context.availableProviders.indexOf(provider),
      }
    })
    .filter((provider) => provider.models.length > 0 && provider.reasoningLevels.length > 0)
  const codex = providers.find((provider) => provider.id === "codex")
  const currentCodexTuple = managed &&
    context.providerId === "codex" &&
    context.availableProviders.some((provider) => provider.id === "codex" && provider.selectable) &&
    codexInferenceTupleIsTransportSafe(context.model, context.reasoning)
  const codexEngine = context.codexEngineAvailable
    ? context.codexEngine ?? context.engine ?? "app-server"
    : null
  const codexLunaIndex = codex?.models.indexOf("gpt-5.6-luna") ?? -1
  const codexLuna = codex && codexLunaIndex >= 0
    ? managedDestination(
        codex,
        context,
        "gpt-5.6-luna",
        context.providerId === "codex" ? undefined : context.codexLunaReasoning,
        codexEngine,
      )
    : null
  let order = 0
  const editing = context.editing ?? (context.editorMode ? isEditingMode(context.editorMode) : false)
  const viewIsMain = context.view ? context.view === "main" : true
  const hasCandidateList = context.hasCandidateList ?? false
  const hasCapturedContext = context.hasCapturedContext ?? false
  const fixAvailable = context.fixAvailable ?? true
  const action = (
    input: Omit<Parameters<typeof paletteRecord>[1], "field" | "authorityKey" | "sourceIndex" | "value" | "label" | "order"> & {
      action: UniversalPaletteAction
      label: string
      kind: UniversalPaletteKind
      effect: string
    },
  ) => {
    const actionIndex = order
    records.push(paletteRecord(context, {
      authorityKey: "action",
      field: "action",
      sourceIndex: actionIndex,
      value: input.action,
      label: input.label,
      display: input.label,
      action: input.action,
      chord: input.chord,
      kind: input.kind,
      effect: input.effect,
      order: order++,
    }))
  }

  if (managed) {
    for (const provider of providers) {
      // A provisional local provider destination uses only a saved/current
      // exact tuple, never the first advertised entry.
      const destination = providerDestination(provider, context, provider.id === "codex" ? codexEngine : null)
      if (!destination) continue
      const providerLabel = paletteProviderLabel(provider.id)
      const localStatus = provider.id === LOCAL_PROVIDER_ID
        ? (context.blockedLocalModels ?? []).includes(`${destination.endpoint ?? context.localEndpoint} ${destination.model}`)
          ? " · blocked"
          : capabilityForModel(provider, destination.model)?.description.startsWith("Unavailable")
            ? " · unavailable"
            : ""
        : ""
      const label = `${providerLabel}${localStatus}`
      records.push(paletteRecord(context, {
        authorityKey: provider.id,
        field: "provider",
        sourceIndex: provider.sourceIndex,
        value: provider.id,
        label,
        display: label,
        publicId: provider.id,
        providerLabel,
        destination,
        order: order++,
      }))
    }

    for (const provider of providers) {
      const providerLabel = paletteProviderLabel(provider.id)
      if (provider.id === LOCAL_PROVIDER_ID) {
        // Endpoint-aware leaves: the endpoint is part of the record identity
        // (authorityKey), so the same model ID on two servers restores focus
        // and revalidation exactly.
        for (const [sourceIndex, row] of (provider.localModelRows ?? []).entries()) {
          records.push(paletteRecord(context, {
            authorityKey: row.endpoint,
            field: "model",
            sourceIndex,
            value: row.capability.model,
            label: `${providerLabel}/${row.capability.displayName}`,
            display: `${providerLabel}/${row.capability.displayName}`,
            publicId: row.capability.model,
            providerLabel,
            destination: row.destination,
            order: order++,
          }))
        }
        continue
      }
      for (const [sourceIndex, value] of provider.models.entries()) {
        if (provider.id === "codex" && value === "gpt-5.6-luna") continue
        const destination = managedDestination(provider, context, value, undefined, provider.id === "codex" ? codexEngine : null)
        if (!destination) continue
        const displayName = capabilityForModel(provider, value)?.displayName ?? modelLabel(value)
        records.push(paletteRecord(context, {
          authorityKey: provider.id,
          field: "model",
          sourceIndex,
          value,
          label: `${providerLabel}/${displayName}`,
          display: `${providerLabel}/${displayName}`,
          publicId: value,
          providerLabel,
          destination,
          order: order++,
        }))
      }
    }

    if (codex && codexLuna && codexLunaIndex >= 0) {
      const displayName = capabilityForModel(codex, "gpt-5.6-luna")?.displayName ?? "Luna"
      records.push(paletteRecord(context, {
        authorityKey: "codex",
        field: "model",
        sourceIndex: codexLunaIndex,
        value: "gpt-5.6-luna",
        label: `Codex/${displayName}`,
        display: `Codex/${displayName}`,
        publicId: "gpt-5.6-luna",
        providerLabel: "Codex",
        destination: codexLuna,
        order: order++,
      }))
    }

    const effortProvider = providers.find((provider) => provider.id === context.providerId)
    const effortCapability = effortProvider && context.providerSource === "default"
      ? capabilityForModel(effortProvider, context.model)
      : undefined
    if (effortProvider && effortCapability) {
      const providerLabel = paletteProviderLabel(effortProvider.id)
      for (const [sourceIndex, value] of effortCapability.efforts.entries()) {
        const destination = managedDestination(
          effortProvider,
          context,
          context.model,
          value,
          effortProvider.id === "codex" ? codexEngine : null,
          effortProvider.id === LOCAL_PROVIDER_ID ? context.localEndpoint : null,
        )
        if (!destination) continue
        records.push(paletteRecord(context, {
          authorityKey: effortProvider.id,
          field: "reasoning",
          sourceIndex,
          value,
          label: `${providerLabel}/${value}`,
          display: `${providerLabel}/${value}`,
          publicId: value,
          providerLabel,
          order: order++,
          destination,
        }))
      }
    }

    if ((codex || currentCodexTuple) && codexEngine) {
      const codexModel = currentCodexTuple
        ? context.model
        : (codex ? advertisedModel(codex, context) : undefined)
      const codexReasoning = currentCodexTuple
        ? context.reasoning
        : (codex && codexModel ? advertisedReasoning(codex, context, undefined, codexModel) : undefined)
      if (codexModel && codexReasoning) {
        for (const [sourceIndex, value] of ["app-server", "exec"].entries() as Iterable<[number, CodexAskEngine]>) {
          const destination: UniversalPaletteDestination | null = currentCodexTuple
            ? {
                authority: { kind: "managed", providerId: "codex" },
                providerId: "codex",
                providerSource: "default",
                model: codexModel,
                reasoning: codexReasoning,
                engine: value,
              }
            : (codex ? managedDestination(codex, context, codexModel, codexReasoning, value) : null)
          if (!destination) continue
        const label = value === "app-server" ? "App Server" : "Codex Exec"
        records.push(paletteRecord(context, {
          authorityKey: "codex-engine",
          field: "engine",
          sourceIndex,
          value,
          label: `Codex/${label}`,
          display: `Codex/${label}`,
          publicId: value,
          providerLabel: "Codex",
          order: order++,
          destination,
        }))
      }
    }
  }
} else {
    const models = context.configuredModels ?? []
    const reasoningLevels = context.configuredReasoningLevels ?? []
    const authorityKey = "configured"
    const destination = (model: string, reasoning: string): UniversalPaletteDestination => ({
      authority: { kind: "configured" },
      providerId: null,
      providerSource: "configured",
      model,
      reasoning,
      engine: null,
    })
    for (const [sourceIndex, value] of models.entries()) {
      records.push(paletteRecord(context, {
        authorityKey,
        field: "model",
        sourceIndex,
        value,
        label: modelLabel(value),
        publicId: value,
        providerLabel: "Configured",
        destination: destination(value, reasoningLevels.includes(context.reasoning) ? context.reasoning : reasoningLevels[0] ?? "low"),
        order: order++,
      }))
    }
    for (const [sourceIndex, value] of reasoningLevels.entries()) {
      records.push(paletteRecord(context, {
        authorityKey,
        field: "reasoning",
        sourceIndex,
        value,
        label: `Configured/${value}`,
        publicId: value,
        providerLabel: "Configured",
        destination: destination(models.includes(context.model) ? context.model : models[0] ?? context.model, value),
        order: order++,
      }))
    }
  }

  for (const count of [1, 2, 3, 4, 5]) {
    records.push({...paletteRecord(context, {
      authorityKey: "initial-choices", field: "action", sourceIndex: count - 1,
      value: String(count), label: `${count} initial ${count === 1 ? "choice" : "choices"}${count === 3 ? " (default)" : ""}`,
      kind: "set", action: "set-initial-choices", order: order++,
      effect: "saved globally for the next Command/Fix request; custom providers keep one",
    }), current: count === (context.initialChoices ?? 3)})
  }

  if (hasCapturedContext && !editing && viewIsMain) {
    action({
      action: "toggle-context",
      chord: "Ctrl-X I",
      label: context.includeContext ? "Output attached" : "Attach output",
      kind: "toggle",
      effect: context.includeContext ? "hold captured output" : "include captured output",
    })
  }
  if (!editing && viewIsMain) {
    const modes = [
      ["mode-ask", "Ask"],
      ["mode-command", "Command"],
      ...(fixAvailable ? [["mode-fix", "Fix"] as const] : []),
    ] as const
    for (const [actionName, label] of modes) {
      action({
        action: actionName,
        label,
        kind: "open",
        effect: `switches to ${label}`,
      })
    }
  }
  if (!editing && viewIsMain) {
    action({
      action: "open-context",
      chord: "Ctrl-X C",
      label: "Context",
      kind: "open",
      effect: "opens Context editor",
    })
  }
  if (context.doctorAvailable) {
    action({
      action: "open-doctor",
      chord: "Ctrl-X D",
      label: "Doctor",
      kind: "open",
      effect: "opens Doctor",
    })
  }
  if (!editing && viewIsMain) {
    action({
      action: "open-details",
      chord: "Ctrl-X H",
      label: "Details",
      kind: "open",
      effect: "opens Details",
    })
  }
  if (!editing && viewIsMain && hasCandidateList) {
    action({
      action: "open-candidate-details",
      chord: "Ctrl-X H",
      label: "Candidate details",
      kind: "open",
      effect: "opens candidate Details",
    })
    action({
      action: "open-candidate-edit",
      chord: "Ctrl-X E",
      label: "Edit candidate",
      kind: "open",
      effect: "opens candidate editor",
    })
  }
  if (viewIsMain) {
    action({
      action: "open-provider-setup",
      chord: "Ctrl-X P",
      label: "Provider Setup",
      kind: "open",
      effect: "opens Provider Setup",
    })
  }
  // Configuration is inert even when no managed adapter can be selected.
  action({
    action: "configure-local-endpoint",
    label: "Configure local endpoint",
    kind: "open",
    effect: "opens private endpoint configuration",
  })
  if (context.localCheckAvailable) {
    action({
      action: "check-local-models",
      label: "Check local models",
      kind: "open",
      effect: context.localChecking
        ? "checking the local endpoint…"
        : "lists models advertised by the local endpoint",
    })
  }
  if (context.anotherAvailable && !editing && viewIsMain) {
    action({
      action: "guard-another",
      chord: "Ctrl-X A",
      label: "Another suggestion",
      kind: "guard",
      effect: "Another suggestion · Ctrl-X A to request",
    })
  } else {
    action({
      action: "refusal-another",
      chord: "Ctrl-X A",
      label: "Another suggestion",
      kind: "n-a",
      effect: "unavailable in this state",
    })
  }
  if (hasCandidateList && !editing) {
    action({
      action: "guard-insert",
      chord: "Enter",
      label: "Insert candidate",
      kind: "guard",
      effect: "returns to candidate · Enter inserts for review",
    })
  }
  if (editing) {
    action({
      action: "guard-save",
      chord: "Ctrl-X W",
      label: "Save edit",
      kind: "guard",
      effect: "returns to editor · Ctrl-X W saves",
    })
  } else {
    action({
      action: "refusal-save",
      chord: "Ctrl-X W",
      label: "Save edit",
      kind: "n-a",
      effect: "nothing is being edited",
    })
  }
  action(editing
    ? {
        action: "refusal-new-chat",
        chord: "Ctrl-X N",
        label: "New Ask chat",
        kind: "n-a",
        effect: "save or discard the edit first",
      }
    : {
        action: "guard-new-chat",
        chord: "Ctrl-X N",
        label: "New Ask chat",
        kind: "guard",
        effect: "routes to Ask",
      })
  if (editing) {
    action({
      action: "refusal-context",
      chord: "Ctrl-X C",
      label: "Context",
      kind: "n-a",
      effect: "save or discard the edit first",
    })
  }
  if (!fixAvailable) {
    action({
      action: "refusal-fix",
      label: "Fix",
      kind: "n-a",
      effect: "Fix needs an actionable failed command",
    })
  }
  return records
}

const PARENT_VIEWS: Array<{ view: SettingsPaletteView; label: string }> = [
  { view: "model", label: "Set model" },
  { view: "effort", label: "Set effort" },
  { view: "provider", label: "Set provider" },
  { view: "choices", label: "Initial choices" },
  { view: "more", label: "More settings & actions" },
]

const paletteViewLabel = (view: SettingsPaletteView) =>
  view === "engine"
    ? "Set engine"
    : PARENT_VIEWS.find((item) => item.view === view)?.label ?? view

const paletteParent = (
  view: SettingsPaletteView,
  index: number,
): UniversalPaletteRecord => ({
  field: "action",
  sourceIndex: index,
  value: `palette-${view}`,
  display: paletteViewLabel(view),
  label: paletteViewLabel(view),
  kind: "open",
  action: "open-palette-view",
  effect: "opens settings",
  paletteView: view,
  identity: {
    field: "action",
    authorityKey: "palette-parent",
    sourceIndex: index,
    value: `palette-${view}`,
  },
})

export function settingsPaletteSources(
  sources: UniversalPaletteRecord[],
  view: SettingsPaletteView,
  query = "",
): UniversalPaletteRecord[] {
  const normalized = normalizeSettingsQuery(query).normalize("NFKC").toLowerCase().trim()
  const engineParent = sources.some((source) => source.field === "engine")
    ? [paletteParent("engine", PARENT_VIEWS.length)]
    : []
  if (!normalized && view === "root") return PARENT_VIEWS.map((item, index) => paletteParent(item.view, index))
  if (normalized) return [...PARENT_VIEWS.map((item, index) => paletteParent(item.view, index)), ...engineParent, ...sources]
  if (view === "model") {
    const modelSources = sources.filter((source) => source.field === "model")
    const localActions = sources.filter((source) => source.action === "check-local-models" || source.action === "configure-local-endpoint")
    return [...modelSources, ...localActions]
  }
  if (view === "choices") return sources.filter(source => source.action === "set-initial-choices")
  if (view === "effort") return sources.filter((source) => source.field === "reasoning")
  if (view === "provider") {
    const providerSources = sources.filter((source) => source.field === "provider")
    const localActions = sources.filter((source) => source.action === "check-local-models" || source.action === "configure-local-endpoint")
    return [...providerSources, ...localActions]
  }
  if (view === "engine") return sources.filter((source) => source.field === "engine")
  if (view === "more") return [...engineParent, ...sources.filter((source) => source.field === "action" && source.action !== "set-initial-choices")]
  return PARENT_VIEWS.map((item, index) => paletteParent(item.view, index))
}

const SETTINGS_BIDI_OR_CONTROL = /[\p{Cc}\p{Cf}]/u
const SETTINGS_QUERY_BYTES = new TextEncoder()

export function normalizeSettingsQuery(value: string): string {
  let normalized = ""
  for (const character of value) {
    if (character === "\r" || character === "\n" || character === "\t") {
      normalized += " "
    } else if (!SETTINGS_BIDI_OR_CONTROL.test(character)) {
      normalized += character
    }
  }
  normalized = normalized.replace(/ {2,}/gu, " ")
  // ponytail: bounded O(n²) UTF-8 trim, replace with an incremental encoder if the query ceiling grows.
  let bounded = ""
  for (const character of normalized) {
    const next = bounded + character
    if (SETTINGS_QUERY_BYTES.encode(next).byteLength > ASK_QUERY_MAX_BYTES) break
    bounded = next
  }
  return bounded
}

const subsequenceScore = (value: string, term: string) => {
  let cursor = 0
  let start = -1
  let gaps = 0
  for (const character of term) {
    const position = value.indexOf(character, cursor)
    if (position < 0) return null
    if (start < 0) start = position
    if (cursor > 0) gaps += position - cursor
    cursor = position + character.length
  }
  return { gaps, start: Math.max(0, start) }
}

export function settingsFieldLabel(field: UniversalPaletteField): string {
  if (field === "action") return "Action"
  return field === "reasoning" ? "Effort" : field[0].toUpperCase() + field.slice(1)
}

export function settingsParentIntent(source: SettingsPickerSource): string | null {
  if (source.action === "open-palette-view" || source.paletteView) return null
  if (source.field === "model") return "Set model"
  if (source.field === "reasoning") return "Set effort"
  if (source.field === "provider") return "Set provider"
  if (source.field === "engine") return "Set engine"
  return source.field === "action" ? "More settings & actions" : null
}

const bestSettingsProjection = (
  source: SettingsPickerSource,
  term: string,
  values = [
    source.display,
    source.publicId,
    source.providerLabel,
    settingsFieldLabel(source.field),
    source.chord,
  ],
) => {
  const projections = values
    .filter((value): value is string => value !== undefined)
    .map((value, projection) => ({
      projection,
      value: value.normalize("NFKC").toLowerCase(),
    }))
  const matches: Array<{ class: number; gaps: number; penalty: number; start: number }> = []
  for (const item of projections) {
    if (item.value === term) matches.push({ class: 0, gaps: 0, penalty: item.projection, start: 0 })
    else if (item.value.startsWith(term)) matches.push({ class: 1, gaps: 0, penalty: item.projection, start: 0 })
    else {
      const substring = item.value.indexOf(term)
      if (substring >= 0) {
        matches.push({ class: 2, gaps: 0, penalty: item.projection, start: substring })
      } else {
        const subsequence = subsequenceScore(item.value, term)
        if (subsequence) {
          matches.push({
            class: 3,
            gaps: subsequence.gaps,
            penalty: item.projection,
            start: subsequence.start,
          })
        }
      }
    }
  }
  return matches.sort(
    (left, right) =>
      left.class - right.class ||
      left.penalty - right.penalty ||
      left.gaps - right.gaps ||
      left.start - right.start,
  )[0] ?? null
}

export function fuzzySettingsCandidates<T extends SettingsPickerSource>(
  query: string,
  sources: T[],
  limit = Number.POSITIVE_INFINITY,
): Array<T & { score: SettingsPickerResult["score"] }> {
  const terms = normalizeSettingsQuery(query)
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
  return sources
    .flatMap((source) => {
      if (source.kind === "n-a" && terms.length === 0) return []
      let fallbackTier = 0
      let matches = terms.map((term) => bestSettingsProjection(source, term))
      if (matches.some((match) => match === null)) {
        const parentIntent = settingsParentIntent(source)
        if (!parentIntent) return []
        fallbackTier = 1
        matches = terms.map((term) => bestSettingsProjection(
          source,
          term,
          [parentIntent, `${parentIntent} ${source.display}`],
        ))
      }
      if (matches.some((match) => match === null)) return []
      const projections = matches as Array<NonNullable<(typeof matches)[number]>>
      const score: SettingsPickerResult["score"] = [
        fallbackTier,
        Math.max(0, ...projections.map((match) => match.class)),
        projections.reduce((sum, match) => sum + match.class, 0),
        projections.reduce((sum, match) => sum + match.penalty, 0),
        projections.reduce((sum, match) => sum + match.gaps, 0),
        projections.reduce((sum, match) => sum + match.start, 0),
        source.kind === "n-a" ? 1 : 0,
        source.current ? 0 : 1,
        source.active ? 0 : 1,
        source.field === "provider" ? 0 : source.field === "engine" ? 1 : source.field === "model" ? 2 : source.field === "reasoning" ? 3 : 4,
        source.order ?? source.sourceIndex,
        source.sourceIndex,
      ]
      return [{ ...source, score }]
    })
    .sort((left, right) => {
      for (let index = 0; index < left.score.length; index += 1) {
        if (left.score[index] !== right.score[index]) {
          return left.score[index] - right.score[index]
        }
      }
      return 0
    })
    .slice(0, limit)
}

// The matcher returns the complete logical set. Painting is the only place
// that windows to five rows, so keyboard and pointer navigation can reach
// every child without making source order mutation authority.
export const SETTINGS_PICKER_VISIBLE_ROWS = 5

export function settingsPickerCandidates<T extends SettingsPickerSource>(
  query: string,
  sources: T[],
): Array<T & { score: SettingsPickerResult["score"] }> {
  return fuzzySettingsCandidates(query, sources)
}

export function settingsPickerWindow<T>(
  results: T[],
  focusedIndex: number,
  limit = SETTINGS_PICKER_VISIBLE_ROWS,
): T[] {
  if (limit <= 0 || results.length <= limit) return results
  const focus = Math.max(0, Math.min(focusedIndex, results.length - 1))
  const start = Math.min(
    Math.max(0, focus - limit + 1),
    results.length - limit,
  )
  return results.slice(start, start + limit)
}
export type SettingsRange = { end: number; index: number; start: number }
export type SettingsLine = { field?: SettingsField; text: string }
export type SettingsLines = {
  lines: SettingsLine[]
  ranges: {
    engine: SettingsRange[]
    provider: SettingsRange[]
    model: SettingsRange[]
    reasoning: SettingsRange[]
  }
}

export type ProviderSetupLines = SettingsLines

export function providerSetupLines(
  state: {
    field: SettingsField
    providerId: ProviderId | null
    providers: Array<{ id: ProviderId; selectable: boolean; enabled?: boolean }>
    modelIndex: number
    models: string[]
    reasoningIndex: number
    reasoningLevels: string[]
    controlsEnabled: boolean
    configured: boolean
  },
  width: number,
  unicode: boolean,
): ProviderSetupLines {
  const labelWidth = SETTINGS_LABEL_WIDTH
  const prefixWidth = 2 + labelWidth + 2
  const valueWidth = Math.max(4, width - prefixWidth)
  const marker = unicode ? "›" : ">"
  const tokenRow = (values: string[], selectedIndex: number, enabled = true) => {
    let cursor = 0
    const ranges: SettingsRange[] = []
    const tokens = values.map((value, index) => {
      const token = index === selectedIndex ? `[${value}]` : value
      const start = cursor
      const end = start + terminalWidth(token)
      if (enabled) ranges.push({ start, end, index })
      cursor = end + 2
      return token
    })
    return { ranges, text: tokens.join("  ") }
  }
  const providerValues = state.providers.map(({ id }) => id)
  const providerSelected = providerValues.findIndex((id) => id === state.providerId)
  const providerRow = state.configured
    ? { ranges: [] as SettingsRange[], text: "configured externally" }
    : tokenRow(
        providerValues,
        providerSelected,
        true,
      )
  if (!state.configured) {
    providerRow.ranges = providerRow.ranges.filter(
      (range) => state.providers[range.index]?.enabled ??
        state.providers[range.index]?.selectable,
    )
  }
  const modelRow = tokenRow(
    state.models.map(modelLabel),
    state.modelIndex,
    state.controlsEnabled,
  )
  const reasoningRow = tokenRow(
    state.reasoningLevels,
    state.reasoningIndex,
    state.controlsEnabled,
  )
  const line = (selected: boolean, label: string, text: string) =>
    `${selected ? marker : " "} ${label.padEnd(labelWidth)}  ${text}`
  const statusText = (id: ProviderId) =>
    state.providers.find((provider) => provider.id === id)?.selectable
      ? "AVAILABLE"
      : "UNAVAILABLE"
  // Generated from `state.providers` rather than a hardcoded two-provider
  // literal, so a third (or later) registry entry appears here without
  // touching this function again. CLI providers keep their exact existing
  // "<Label> CLI <STATUS>" wording; a managed-transport provider reports a
  // "<Label> managed <STATUS>" token instead, since it has no CLI binary.
  const transportById = new Map(
    providerRegistry().map((descriptor) => [descriptor.id, descriptor.transport]),
  )
  const availabilityLabel = paletteProviderLabel
  const availabilityText = paletteTruncate(
    `  ${state.providers
      .map(({ id }) =>
        `${availabilityLabel(id)} ${transportById.get(id) === "managed" ? "managed" : "CLI"} ${statusText(id)}`,
      )
      .join(" | ")}`,
    width,
    unicode,
  )
  const lines: SettingsLine[] = [
    { text: "Provider Setup | PATH only | auth/network not checked | nothing sends" },
    {
      field: "provider",
      text: line(state.field === "provider", "Provider", providerRow.text),
    },
    {
      field: "model",
      text: line(
        state.field === "model" && state.controlsEnabled,
        "Model",
        state.controlsEnabled ? modelRow.text : "unavailable until provider selected",
      ),
    },
    {
      field: "reasoning",
      text: line(
        state.field === "reasoning" && state.controlsEnabled,
        "Effort",
        state.controlsEnabled ? reasoningRow.text : "unavailable until provider selected",
      ),
    },
    { text: availabilityText },
    { text: "up/down field | left/right value | Enter/Esc back" },
  ]
  const windowRow = (row: { ranges: SettingsRange[]; text: string }, selectedIndex: number) => {
    if (terminalWidth(row.text) <= valueWidth || !row.ranges.length) return row
    const selected = row.ranges[selectedIndex] ?? row.ranges[0]
    const safeWidth = Math.max(selected.end - selected.start, valueWidth - 2)
    const offset = Math.max(0, Math.min(
      selected.start - Math.floor((safeWidth - (selected.end - selected.start)) / 2),
      terminalWidth(row.text) - safeWidth,
    ))
    const text = metadataWindow(row.text, offset, valueWidth)
    const shift = offset > 0 ? 1 - offset : -offset
    return {
      text,
      ranges: row.ranges.map((range) => ({
        ...range,
        start: Math.max(0, Math.min(valueWidth, range.start + shift)),
        end: Math.max(0, Math.min(valueWidth, range.end + shift)),
      })),
    }
  }
  const providerWindow = windowRow(providerRow, providerSelected)
  const modelWindow = windowRow(modelRow, state.modelIndex)
  const reasoningWindow = windowRow(reasoningRow, state.reasoningIndex)
  const offsetRanges = (ranges: SettingsRange[]) => ranges.map((range) => ({
    ...range,
    start: range.start + prefixWidth,
    end: range.end + prefixWidth,
  }))
  return {
    lines: lines.map((item) => {
      if (!item.field) return item
      const row = item.field === "provider" ? providerWindow : item.field === "model" ? modelWindow : reasoningWindow
      return {
        ...item,
        text: line(
          state.field === item.field && (item.field === "provider" || state.controlsEnabled),
          item.field === "reasoning" ? "Effort" : item.field[0].toUpperCase() + item.field.slice(1),
          item.field !== "provider" && !state.controlsEnabled
            ? "unavailable until provider selected"
            : row.text,
        ),
      }
    }),
    ranges: {
      engine: [],
      provider: offsetRanges(providerWindow.ranges),
      model: offsetRanges(state.controlsEnabled ? modelWindow.ranges : []),
      reasoning: offsetRanges(state.controlsEnabled ? reasoningWindow.ranges : []),
    },
  }
}

const SETTINGS_LABEL_WIDTH = Math.max("Provider".length, "Model".length, "Effort".length)
export type ActionsSheetAction = CtrlXAction | "close"
export type ActionsSheetCell = {
  action: ActionsSheetAction
  end: number
  start: number
}
export type ActionsSheetRow = { cells: ActionsSheetCell[]; text: string }
export type ActionsSheet = {
  actions: ActionsSheetAction[]
  rows: ActionsSheetRow[]
}

// Two fixed column budgets, sized to the letter-gutter plus label shape
// approved at 80 columns; only the right column's trailing space grows with
// `width`, so the rule and the two label columns stay aligned at every
// supported width instead of stretching unevenly.
const ACTIONS_LEFT_WIDTH = 33
const ACTIONS_LEFT_LABEL_WIDTH = 12
const ACTIONS_RIGHT_LABEL_WIDTH = 13

// The layout "K" actions sheet: two clickable columns per row, painted by
// this one function so `actionsOpen`'s click handler and its rendered text
// can never drift apart, the same discipline `modeTabs`/`statusRail`/
// `providerSetupLines` already use. `close` is not a `CtrlXAction` — it is the
// Esc cell, which just returns to the primary surface.
export function actionsSheetLines(
  state: {
    canRequestAlternative: boolean
    doctorAvailable?: boolean
    editing: boolean
    editorMode: EditorMode
    hasCandidateList: boolean
    hasEngine: boolean
    providerAvailable?: boolean
    includeContext: boolean
    intent: SessionIntent
    model: string
    reasoning: string
  },
  width: number,
  unicode: boolean,
): ActionsSheet {
  const rightWidth = Math.max(1, width - ACTIONS_LEFT_WIDTH - 1)
  const vertical = unicode ? "│" : "|"
  const tee = unicode ? "┬" : "+"
  const horizontal = unicode ? "─" : "-"

  const fit = (value: string, budget: number) => {
    const clipped = truncateCells(value, budget)
    return `${clipped}${" ".repeat(Math.max(0, budget - terminalWidth(clipped)))}`
  }
  const withValue = (
    label: string,
    value: string,
    labelWidth: number,
    budget: number,
  ) => {
    const labelBudget = Math.min(
      Math.max(labelWidth, terminalWidth(label) + 1),
      Math.max(1, budget - 1),
    )
    return `${fit(label, labelBudget)}${truncateCells(value, budget - labelBudget)}`
  }
  const left = (key: string, label: string, value?: string) => {
    const prefix = ` ${key}   `
    const body = value
      ? withValue(
          label,
          value,
          ACTIONS_LEFT_LABEL_WIDTH,
          ACTIONS_LEFT_WIDTH - terminalWidth(prefix),
        )
      : label
    return fit(`${prefix}${body}`, ACTIONS_LEFT_WIDTH)
  }
  const right = (key: string, label: string, value?: string) => {
    const prefix = `  ${key.padEnd(3)}  `
    const body = value
      ? withValue(
          label,
          value,
          ACTIONS_RIGHT_LABEL_WIDTH,
          rightWidth - terminalWidth(prefix),
        )
      : label
    return truncateCells(`${prefix}${body}`, rightWidth)
  }

  const includeLabel = state.includeContext ? "hold" : "include"
  const includeState = state.includeContext ? "Included" : "Held"
  const editTarget =
    state.intent === "ask"
      ? "question"
      : state.hasCandidateList
        ? "command"
        : "prompt"
  const currentEdit =
    state.editorMode === "context" ? "output" : editTarget
  const contentRows: {
    la: CtrlXAction
    lt: string
    ra?: ActionsSheetAction
    rightSends?: boolean
    rt?: string
  }[] = state.editing
    ? [
        {
          la: "save",
          lt: left("W", "save edit"),
          ra: "close",
          rt: right("Esc", "close"),
        },
        {
          la: "context",
          lt: left(
            "C",
            state.editorMode === "context"
              ? "editing output"
              : "edit output after save",
          ),
          ra: "edit",
          rt: right(
            "E",
            state.editorMode === "context"
              ? `edit ${editTarget} after save`
              : `editing ${currentEdit}`,
          ),
        },
        {
          la: "model",
          lt: left("M", "model settings"),
          ra: "reasoning",
          rt: right("R", "effort settings"),
        },
        {
          la: "include",
          lt: left("I", `${includeLabel} saved output`, includeState),
          ra: "details",
          rt: right("H", "details after save"),
        },
      ]
    : [
        {
          la: "context",
          lt: left("C", "edit output"),
          ra: "include",
          rt: right("I", `${includeLabel} output`, includeState),
        },
        {
          la: "model",
          lt: left("M", "model", modelLabel(state.model)),
          ra: "reasoning",
          rt: right("R", "effort", state.reasoning),
        },
        state.intent === "ask"
          ? {
              la: "edit",
              lt: left("E", "edit question"),
              ra: "new-chat",
              rt: right("N", "new chat"),
            }
          : state.canRequestAlternative
            ? {
              la: "edit",
              lt: left("E", `edit ${editTarget}`),
              ra: "another",
              rightSends: true,
              rt: right("A", "another suggestion"),
            }
            : {
                la: "edit",
                lt: left("E", `edit ${editTarget}`),
              },
        {
          la: "details",
          lt: left("H", "details"),
          ra:
            state.intent === "ask" && state.hasEngine ? "engine" : "close",
          rt:
            state.intent === "ask" && state.hasEngine
              ? right("G", "engine setting")
              : right("Esc", "close"),
        },
      ]

  const providerHint = state.providerAvailable === true ? "P provider · " : ""
  const doctorHint = state.doctorAvailable ? " · D doctor" : ""
  const settingsHint = "S settings · "
  const header = state.editing
    ? `Editing ${currentEdit} · ${settingsHint}nothing sends · Esc close`
    : state.intent === "ask"
      ? `Actions · ${settingsHint}${providerHint}nothing sends · Esc close${doctorHint}`
      : state.canRequestAlternative
        ? `Actions · ${settingsHint}${providerHint}only A sends · Esc close${doctorHint}`
        : `Actions · ${settingsHint}${providerHint}nothing sends · Esc close${doctorHint}`

  const doctorStart = header.indexOf("D doctor")
  const doctorCell = state.doctorAvailable && doctorStart >= 0
    ? [{
        action: "doctor" as const,
        start: terminalWidth(header.slice(0, doctorStart)),
        end: terminalWidth(header.slice(0, doctorStart)) + terminalWidth("D doctor"),
      }]
    : []

  const rows: ActionsSheetRow[] = [
    { cells: doctorCell, text: truncateCells(header, width) },
    {
      cells: [],
      text: truncateCells(
        `${horizontal.repeat(ACTIONS_LEFT_WIDTH)}${tee}${horizontal.repeat(rightWidth)}`,
        width,
      ),
    },
  ]
  const actions: ActionsSheetAction[] = []
  if (state.doctorAvailable) actions.push("doctor")
  for (const row of contentRows) {
    const rightText = row.ra
      ? row.rightSends
        ? truncateCells(`${row.rt} · key only`, rightWidth)
        : row.rt!
      : fit("", rightWidth)
    const text = truncateCells(`${row.lt}${vertical}${rightText}`, width)
    const visibleWidth = terminalWidth(text)
    actions.push(row.la)
    if (row.ra) actions.push(row.ra)
    const cells: ActionsSheetCell[] = [
      {
        action: row.la,
        end: Math.min(ACTIONS_LEFT_WIDTH, visibleWidth),
        start: 0,
      },
    ]
    if (row.ra && !row.rightSends) {
      cells.push({
        action: row.ra,
        end: visibleWidth,
        start: Math.min(ACTIONS_LEFT_WIDTH + 1, visibleWidth),
      })
    }
    rows.push({
      cells,
      text,
    })
  }
  if (state.providerAvailable === true) actions.push("provider")
  return { actions: [...new Set(actions)], rows }
}

// The composer grows monotonically with its wrapped visual line count while
// compact, but only up to the eight-row envelope; a promoted surface (list,
// editor, answer, details) always requests its fixed height regardless of
// how many lines the composer would otherwise want. The attached-output
// preview promotes the same way: the caller's own effect never shrinks the
// footer back down mid-invocation, so once the preview has shown, height
// stays at the reader envelope even if the user detaches afterward.
export function requestedFooterHeight(state: {
  actionsOpen: boolean
  // SPIKE(local-stream-ask): rendered Ask rows for the streaming/answer
  // envelope (question, answer, labeled thinking, composer included) and the
  // physical terminal row count used only as the growth ceiling.
  askContentLines?: number
  candidateContentLines?: number
  composerLines: number
  editorMode: EditorMode
  intent: SessionIntent
  phase: WorkbenchPhase
  previewVisible: boolean
  settingsOpen: boolean
  terminalRows?: number
  view: WorkbenchView
}): number {
  if (state.view === "details" || state.view === "doctor") return DETAILS_FOOTER_HEIGHT
  if (state.settingsOpen) return READER_FOOTER_HEIGHT
  if (state.phase === "candidate" && !state.actionsOpen && !isEditingMode(state.editorMode)) {
    return Math.max(READER_FOOTER_HEIGHT, steppedAskFooterHeight(state.candidateContentLines ?? 0, state.terminalRows ?? Number.MAX_SAFE_INTEGER))
  }
  if (
    state.actionsOpen ||
    isEditingMode(state.editorMode) ||
    state.phase === "analysis" ||
    state.phase === "candidate"
  ) {
    return READER_FOOTER_HEIGHT
  }
  // Ask streaming and the completed answer grow with their rendered wrapped
  // content in fixed steps; growth stays monotonic because the caller's
  // effect only ever raises the renderer's live footer height.
  if (state.phase === "streaming" && state.intent !== "ask") {
    return Math.min(DETAILS_FOOTER_HEIGHT, steppedAskFooterHeight(
      state.askContentLines ?? 0, state.terminalRows ?? Number.MAX_SAFE_INTEGER,
    ))
  }
  if ((state.phase === "loading" && state.intent === "ask") || state.phase === "streaming" || state.phase === "answer") {
    return steppedAskFooterHeight(
      state.askContentLines ?? 0,
      state.terminalRows ?? Number.MAX_SAFE_INTEGER,
    )
  }
  if (state.previewVisible) return READER_FOOTER_HEIGHT
  return Math.min(
    READER_FOOTER_HEIGHT,
    COMPACT_FOOTER_HEIGHT + Math.max(0, state.composerLines - 1),
  )
}

export const CONTEXT_PREVIEW_MAX_ROWS = 3
export const CONTEXT_PREVIEW_LABEL = "Attached output (tail):"

export type ContextPreview = { label: string; rows: string[] }

// The preview only ever occupies the composer's own idle lead rows, so it is
// gated to exactly the state where nothing else already owns them: no
// promoted surface (Settings, the actions sheet, an editor, details, or the
// candidate list — that last one folds into `phase === "candidate"`) and no
// phase-derived content is already showing there either (an Ask answer,
// analysis, or a loading/failed/cancelled status message all have their own
// phase). `"ready"` is the one phase left once those are excluded, which is
// also exactly the state the render tree's own empty filler box covers.
export function contextPreviewVisible(state: {
  actionsOpen: boolean
  contextBytes: number
  editorMode: EditorMode
  included: boolean
  phase: WorkbenchPhase
  settingsOpen: boolean
  view: WorkbenchView
}): boolean {
  if (!state.included || state.contextBytes <= 0) return false
  if (state.actionsOpen || state.settingsOpen) return false
  if (state.view !== "main") return false
  if (isEditingMode(state.editorMode)) return false
  return state.phase === "ready"
}

// Bounded tail preview of the sanitized context the next request would
// carry: at most `CONTEXT_PREVIEW_MAX_ROWS` of its most recent lines, each
// truncated with the same width-safe helper the rest of the body uses. A
// context that ends in a newline has a trailing empty split segment that
// carries no content of its own, so it is dropped rather than spent on a
// blank row. The label is a plain-ASCII textual marker — it never leans on
// color or a Unicode-only glyph to read as distinct from an answer or a
// candidate.
export function contextPreview(context: string, width: number): ContextPreview {
  const budget = Math.max(1, width)
  const split = context.split("\n")
  const lines =
    split.length > 1 && split[split.length - 1] === ""
      ? split.slice(0, -1)
      : split
  const tail = lines.slice(Math.max(0, lines.length - CONTEXT_PREVIEW_MAX_ROWS))
  return {
    label: truncateCells(CONTEXT_PREVIEW_LABEL, budget),
    rows: tail.map((line) => truncateCells(line, budget)),
  }
}

// Replaces `primaryAction`. There is no routine `Enter ask` / `Enter
// generate` / `Enter fix` / `Enter follow up` label any more — the composer
// shows only the marker and text at rest. An action is surfaced only when it
// is contextual or safety-critical, in strict precedence order, and
// `"Enter insert (never runs)"` is returned whole and must never be split or
// abbreviated by a caller.
//
// The insertion action teaches once per workbench session: `insertActionTaught`
// is a single boolean the caller owns (it starts `false` and becomes
// permanently `true` once a second candidate has ever existed in the
// session — see `workbench-ui.tsx`). While it is `false` this returns the
// full `"Enter insert (never runs)"`; once `true` it returns the short
// `"↵ insert"` instead. Both forms are atomic and must never be split or
// abbreviated further by a caller.
export function contextualAction(state: {
  actionsOpen: boolean
  editorMode: EditorMode
  insertActionTaught: boolean
  phase: WorkbenchPhase
  settingsOpen: boolean
  view: WorkbenchView
}): string {
  if (
    state.actionsOpen ||
    state.view === "details" ||
    state.view === "doctor" ||
    state.settingsOpen
  ) {
    return "Esc back"
  }
  if (isEditingMode(state.editorMode)) {
    return "^X W save"
  }
  if (state.phase === "loading" || state.phase === "streaming") {
    return "Esc cancel"
  }
  if (state.phase === "failed" || state.phase === "cancelled") {
    return "Enter retry"
  }
  if (state.phase === "candidate") {
    return state.insertActionTaught ? "↵ insert" : "Enter insert (never runs)"
  }
  return ""
}

export function readySummary(state: {
  lastCommand: LastCommand | null
  contextBytes: number
  contextLabel: string
  contextSource: string
  included: boolean
}): string {
  const parts = state.lastCommand
    ? [
        `last ${terminalLiteral(state.lastCommand.command)}`,
        `exit ${state.lastCommand.exit_status}`,
      ]
    : ["no recorded last command"]
  parts.push(contextSummary(state))
  return parts.join(" · ")
}

export function verdict(state: {
  phase: WorkbenchPhase
  model: string
  confidence: number | null
  risk: string
}): {
  variant: "success" | "warning" | "error" | "loading" | "pending"
  text: string
} {
  switch (state.phase) {
    case "loading": {
      return {
        text: `asking ${modelLabel(state.model)} · esc cancels the request`,
        variant: "loading",
      }
    }
    case "streaming": {
      return {
        text: `streaming from ${modelLabel(state.model)} · esc cancels the request`,
        variant: "loading",
      }
    }
    case "failed": {
      return {
        text: "provider failed · nothing was inserted",
        variant: "error",
      }
    }
    case "cancelled": {
      return {
        text: "request cancelled · nothing was inserted",
        variant: "pending",
      }
    }
    case "answer": {
      return {
        text: "answer ready · read-only · nothing can be inserted",
        variant: "success",
      }
    }
    case "analysis": {
      return {
        text: "analysis ready · no command inserted",
        variant: "warning",
      }
    }
    case "candidate": {
      const band = confidenceBand(state.confidence ?? 0)
      return {
        text: `${band} confidence · risk ${oneLine(state.risk, 60)}`,
        variant: band === "low" ? "warning" : "success",
      }
    }
    default: {
      return {
        text: "nothing sent yet · opening made no provider call",
        variant: "pending",
      }
    }
  }
}

export function requestOutcome(
  error: unknown,
  cancelled: boolean,
): { phase: "cancelled" | "failed"; message: string } {
  if (cancelled) {
    return {
      message: "the workbench stayed open and kept every earlier suggestion",
      phase: "cancelled",
    }
  }
  return {
    message: oneLine(
      error instanceof Error ? error.message : "provider failed",
      160,
    ),
    phase: "failed",
  }
}

export const appServerFailureMessage = (exitCode: number) =>
  exitCode === 70
    ? "App Server needs a supported native file login · run codex login with file storage"
    : exitCode === 64
    ? "App Server did not start · nothing saved · ^X G opens engine setting"
    : exitCode === 69
      ? "App Server could not resume this saved chat · nothing saved · ^X G opens engine setting"
      : "App Server stopped safely · nothing saved · ^X G opens engine setting"

export function saveContextDraft(value: string): {
  context: string
  included: false
} {
  return {
    context: sanitizeContext(value),
    // Editing changes the payload at the privacy boundary, so prior consent
    // cannot carry forward to the new text.
    included: false,
  }
}

// The reduced set of unique inspector fields: everything the status rail
// already carries in the same form (mode, keys) is dropped so details never
// duplicates the rail or the separate help surface.
export function metadataItems(state: {
  cwd: string
  repositoryAccess: boolean
  lastCommand: LastCommand | null
  contextBytes: number
  contextLabel: string
  contextSource: string
  included: boolean
  engine?: string
  model: string
  reasoning: string
  candidate: ProviderResponse | null
  candidateIndex: number
  candidateCount: number
  askChatState: AskChatState
  provider?: string
  providerCommand?: string[]
}): { key: string; value: string }[] {
  const local = state.provider === LOCAL_PROVIDER_ID && !state.providerCommand
  return [
    {
      key: "cwd",
      value: terminalLiteral(state.cwd),
    },
    {
      key: local ? "repository access" : "repository",
      value: local ? "unavailable · prompt/context only" : state.repositoryAccess ? "read-only access" : "unavailable",
    },
    {
      key: local ? "Ask history" : "Ask chat",
      value:
        local ? "one-shot; no pointer" : state.askChatState === "saved"
          ? "saved for this cwd"
          : state.askChatState === "new"
            ? "new for this cwd"
            : "one-shot provider",
    },
    ...(local ? [{ key: "loopback trust", value: "same-user process: intercept prompts; forge valid results" }] : []),
    ...(state.provider
      ? [{
          key: "provider",
          value: state.provider,
        }]
      : []),
    ...(state.providerCommand
      ? [{ key: "provider command", value: state.providerCommand.map(terminalLiteral).join(" ") }]
      : []),
    ...(state.engine
      ? [
          { key: "engine", value: state.engine },
          {
            key: "Codex boundary",
            value:
              state.engine === "App Server"
                ? "native file login · private history · no user/project instructions, skills or MCP · Ask read-only · answers never execute"
                : "installed auth and AGENTS.md · skips config.toml · Ask read-only · answers never execute",
          },
        ]
      : []),
    {
      key: "last command",
      value: state.lastCommand
        ? terminalLiteral(state.lastCommand.command)
        : "unavailable",
    },
    {
      key: "last cwd",
      value: state.lastCommand
        ? terminalLiteral(state.lastCommand.cwd)
        : "unavailable",
    },
    {
      key: "exit",
      value: state.lastCommand
        ? `${state.lastCommand.exit_status} · pipeline ${JSON.stringify(
            state.lastCommand.pipeline_statuses,
          )}`
        : "unavailable",
    },
    { key: "context", value: contextSummary(state) },
    {
      key: "model",
      value: `${state.model} · effort ${state.reasoning}`,
    },
    {
      key: "candidate",
      value: state.candidate
        ? `${state.candidateIndex + 1} of ${state.candidateCount} · confidence ${
            state.candidate.confidence
          } · risk ${terminalLiteral(state.candidate.risk)}`
        : "none yet",
    },
    {
      key: "candidate command",
      value: state.candidate?.corrected_command
        ? terminalLiteral(state.candidate.corrected_command)
        : "none yet",
    },
    ...(state.candidate ? [{ key: "confidence", value: "Provider estimate, not a measured success rate or safety check." }] : []),
  ]
}

function parseSession(value: unknown): WorkbenchSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid workbench session")
  }
  const session = value as WorkbenchSession
  if (
    !["ask", "generate", "correct"].includes(session.initial_intent) ||
    !session.requests ||
    typeof session.requests !== "object" ||
    !session.requests.ask ||
    !session.requests.ask.input ||
    !session.requests.ask.input.environment ||
    !session.requests.generate ||
    !session.requests.generate.input ||
    (session.requests.correct !== null &&
      (!session.requests.correct || !session.requests.correct.input)) ||
    !Array.isArray(session.provider) ||
    !session.provider.length ||
    !session.provider.every((part) => typeof part === "string" && part.length) ||
    (session.codex_ask_engine !== null &&
      session.codex_ask_engine !== "app-server" &&
      session.codex_ask_engine !== "exec") ||
    (session.codex_ask_engine !== null) !==
      isBundledCodexProvider(session.provider) ||
    typeof session.model !== "string" ||
    typeof session.reasoning !== "string" ||
    !Array.isArray(session.models) ||
    !session.models.length ||
    !Array.isArray(session.reasoning_levels) ||
    !session.reasoning_levels.length ||
    !session.context ||
    typeof session.context.text !== "string" ||
    typeof session.actionable_failure !== "boolean"
  ) {
    throw new Error("invalid workbench session")
  }
  session.provider_source ??= "configured"
  if (session.provider_id === undefined) {
    session.provider_id = resolveProviderId(session.provider)
  }
  return session
}

export function validateTrustedWorkdir(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("invalid workbench directory")
  }
  try {
    if (!statSync(value).isDirectory()) {
      throw new Error("invalid workbench directory")
    }
  } catch {
    throw new Error("invalid workbench directory")
  }
  return value
}

export function prepareProviderSession(
  session: WorkbenchSession,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  let migrationNotice: string | null = null
  const persistedState = readPersistedInferenceDocumentState(env)
  session.localEndpoint = resolveLocalEndpoint(persistedState, env)
  if (persistedState.kind === "operational-error") {
    return "could not read inference settings"
  }
  let document = persistedState.kind === "valid" ? persistedState.document : null
  if (persistedState.kind === "valid" && persistedState.sourceVersion === 1) {
    const selection = persistedState.document.providers.codex
    try {
      writePersistedInferenceSettings(selection.model, selection.reasoning, env, "codex")
      document = readPersistedInferenceDocument(env)
    } catch {
      migrationNotice = "could not migrate inference settings"
    }
  }
  if (session.provider_source === "configured") {
    session.provider_id = resolveProviderId(session.provider)
    return [
      migrationNotice,
      applyPersistedInferenceSettings(
      session,
      readPersistedInferenceSettings(env, "configured"),
      ),
    ].filter(Boolean).join(" · ") || null
  }
  const available = providerAvailability(env)
  const selectable = available.filter((descriptor) => descriptor.selectable)
  if (!selectable.length) {
    session.provider_id = null
    return "no registered provider is available"
  }
  const savedId = document?.provider
  const chosen =
    selectable.find((descriptor) => descriptor.id === savedId) ??
    selectable.find((descriptor) => descriptor.id === BUNDLED_DEFAULT_PROVIDER) ??
    selectable[0]
  session.provider_id = chosen.id
  session.provider = [adapterPath(chosen)]
  session.models = chosen.models
  session.reasoning_levels = chosen.reasoningLevels
  // A managed-transport provider has no static model list, so there is no
  // first entry to fall back to.
  session.model = chosen.models[0] ?? ""
  session.reasoning = chosen.reasoningLevels[0]
  const providerNotice = savedId && savedId !== chosen.id
    ? `saved provider unavailable · using ${chosen.id}`
    : null
  const settingsNotice = applyPersistedInferenceSettings(
    session,
    document?.providers[chosen.id] ?? null,
  )
  return [migrationNotice, providerNotice, settingsNotice].filter(Boolean).join(" · ") || null
}

async function run(
  sessionPath: string,
  resultPath: string,
  workdirPath: string,
) {
  delete process.env.OTUI_USE_ALTERNATE_SCREEN
  delete process.env.OTUI_OVERRIDE_STDOUT
  const { CliRenderEvents, createCliRenderer } = await import("@opentui/core")
  const session = parseSession(JSON.parse(await Bun.file(sessionPath).text()))
  const trustedWorkdir = validateTrustedWorkdir(workdirPath)
  session.requests.ask.input.environment.cwd = trustedWorkdir
  const providerNotice = prepareProviderSession(session)
  const settingsNotice = applyPersistedInferenceSettings(
    session,
    null,
  )
  const askSessionFiles = session.codex_ask_engine
    ? {
        "app-server": codexSessionFile(
          trustedWorkdir,
          process.env,
          "app-server",
        ),
        exec: codexSessionFile(trustedWorkdir, process.env, "exec"),
      }
    : null
  // Local Ask is one-shot with no pointer at all (history class `none`), so it
  // gets no session file — which is what makes Doctor's existing
  // "one-shot; no pointer required" row correct without touching Doctor.
  const askSessionFile = session.provider_id && session.provider_id !== LOCAL_PROVIDER_ID
    ? session.provider_id === "codex" && session.codex_ask_engine
      ? askSessionFiles?.[session.codex_ask_engine] ?? null
      : providerSessionFile(session.provider_id, trustedWorkdir)
    : null
  const pointerExpectation = session.provider_id
    ? {
        provider:
          session.provider_id === "codex"
            ? session.codex_ask_engine === "app-server"
              ? "codex-app-server"
              : "codex"
            : session.provider_id,
        cwd: trustedWorkdir,
      }
    : undefined

  // The React tree owns the provider child, but teardown stays here so the
  // proven onDestroy kill path is unchanged.
  const active: {
    process: { kill: () => void } | null
    session: import("./codex-app-server-session").AppServerSession | null
    closing: Promise<void> | null
    preparing: Promise<void> | null
    prepareCancel: (() => void) | null
    appServerGeneration: number
    closed: boolean
    cancel: (() => void) | null
    discoveryProcess: { kill: (signal?: any) => void } | null
    discoveryCancel: (() => void) | null
    discoveryClosing: Promise<void> | null
  } = {
    process: null,
    session: null,
    closing: null,
    preparing: null,
    prepareCancel: null,
    appServerGeneration: 0,
    closed: false,
    cancel: null,
    discoveryProcess: null,
    discoveryCancel: null,
    discoveryClosing: null,
  }
  const receiptPath = `${resultPath}.footer`
  let finish!: () => void
  let peakEffectiveHeight = 0
  let receiptError: unknown = null
  const destroyed = new Promise<void>((resolve) => {
    finish = resolve
  })
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: COMPACT_FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
    exitOnCtrlC: true,
    useMouse: true,
    // `config.enableMouseMovement ?? true` ships all-motion tracking when
    // omitted (chunk-bun-tkm837n2.js:7250) — unwanted overhead for a feature
    // that only needs button and wheel events, so this must be explicit.
    enableMouseMovement: false,
    autoFocus: false,
    onDestroy: () => {
      active.closed = true
      active.appServerGeneration += 1
      active.prepareCancel?.()
      active.cancel?.()
      active.discoveryCancel?.()
      active.discoveryProcess?.kill()
      active.process?.kill()
      active.session?.disposeSync()
      try {
        if (
          peakEffectiveHeight < 1 ||
          peakEffectiveHeight > ASK_STREAM_MAX_FOOTER_HEIGHT
        ) {
          throw new Error("invalid finalized footer height")
        }
        writeFileSync(receiptPath, `peak_height=${peakEffectiveHeight}\n`, {
          mode: 0o600,
        })
      } catch (error) {
        receiptError = error
      } finally {
        finish()
      }
    },
  })
  const recordEffectiveHeight = () => {
    const height = renderer.height
    if (
      !Number.isInteger(height) ||
      height < 1 ||
      height > ASK_STREAM_MAX_FOOTER_HEIGHT
    ) {
      throw new Error("invalid effective footer height")
    }
    peakEffectiveHeight = Math.max(peakEffectiveHeight, height)
  }
  recordEffectiveHeight()
  renderer.on(CliRenderEvents.RESIZE, recordEffectiveHeight)
  try {
    const { mount } = await import("./workbench-ui")
    mount(
      renderer,
      session,
      resultPath,
      trustedWorkdir,
      active,
      askSessionFile,
      askChatWasSaved(askSessionFile, pointerExpectation),
      [providerNotice, settingsNotice].filter(Boolean).join(" · ") || null,
      askSessionFiles,
    )
    await destroyed
    active.closed = true
    active.appServerGeneration += 1
    active.prepareCancel?.()
    const closing = active.closing
    const discoveryClosing = active.discoveryClosing
    const appServerSession = active.session
    await Promise.allSettled([closing, discoveryClosing])
    await appServerSession?.dispose()
    if (receiptError) throw receiptError
  } finally {
    renderer.off(CliRenderEvents.RESIZE, recordEffectiveHeight)
    renderer.destroy()
  }
}

if (import.meta.main) {
  const [sessionPath, resultPath, workdirPath] = Bun.argv.slice(2)
  if (!sessionPath || !resultPath || !workdirPath) {
    process.stderr.write("usage: bun workbench.ts SESSION RESULT WORKDIR\n")
    process.exitCode = 64
  } else {
    await run(sessionPath, resultPath, workdirPath).catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "workbench failed"}\n`,
      )
      process.exitCode = 1
    })
  }
}
