import type { ScrollBarRenderable as ReaderScrollbar } from "@opentui/core"
/* Component-level rendering assertions for `workbench-ui.tsx`.
 *
 * These mount the real production React tree (`mount()`, the same function
 * `workbench.ts`'s entry point calls) through OpenTUI's test renderer and
 * drive it with real key/mouse events. They exist because the rail's note
 * slot, the Settings surface, and pointer guards are wired in the component
 * layer — the pure-function tests in `workbench.test.ts` cannot reach a
 * `handleCtrlX`/`openSettings` state transition.
 *
 * Bun component mounting under a synchronous fixed-delay assumption is
 * flaky (a fresh mount can still be settling its first effect pass, and a
 * spawned provider subprocess resolves on its own schedule). Every wait
 * below pumps `renderOnce()` against a real predicate on the captured frame
 * instead of trusting a single render pass. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as workbenchBindings from "../src/workbench"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { homedir, tmpdir } from "node:os"
import { startRawTcpFixture } from "./raw-tcp-fixture"
import { join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { createTestRenderer, MouseButtons } from "@opentui/core/testing"
import { mount, type ActiveProcess } from "../src/workbench-ui"
import {
  actionsSheetLines,
  adapterPath,
  bottomRail,
  BUNDLED_CODEX_PROVIDER,
  BUNDLED_CLAUDE_PROVIDER,
  CONTEXT_PREVIEW_LABEL,
  descriptorForProvider,
  frameLayout,
  inferenceSettingsFile,
  LOCAL_PROVIDER_ID,
  LOCAL_TERMINATION_GRACE_MS,
  INTERIOR_ORIGIN_X,
  modeTabs,
  prepareProviderSession,
  readPersistedInferenceDocument,
  readPersistedInferenceSettings,
  writePersistedInferenceSettings,
  writePersistedLocalEndpoint,
  providerSetupLines,
  terminalWidth,
  TITLE_ORIGIN_X,
  topRail,
  type CodexAskEngine,
  type SessionIntent,
  type WorkbenchSession,
} from "../src/workbench"
// railCwd renders home-relative against the real homedir, so cwd fixtures
// that must display as ~/Projects/shellq sit under the actual home.
const HOME_CWD = join(homedir(), "Projects", "shellq")


// Fake executables capture controls before production strips the launch environment.
let isolatedFixtureRoot = ""
let originalNativeHome: string | undefined
let originalUiState: string | undefined
const nativeSpawn = Bun.spawn
beforeEach(() => {
  originalUiState = process.env.SHELLQ_STATE_DIR
  originalNativeHome = process.env.CODEX_HOME
  isolatedFixtureRoot = mkdtempSync(join(tmpdir(), "shellq-ui-native-"))
  writeFileSync(join(isolatedFixtureRoot, "auth.json"), "{}", { mode: 0o600 })
  process.env.CODEX_HOME = isolatedFixtureRoot
  process.env.SHELLQ_STATE_DIR = join(isolatedFixtureRoot, "state")
  const sources = new Map<string, string>()
  Bun.spawn = ((...args: any[]) => {
    if (Array.isArray(args[0]) && args[0][0] === "codex") {
      for (const directory of (process.env.PATH ?? "").split(":")) {
        const executable = join(directory, "codex")
        if (!existsSync(executable)) continue
        if (statSync(executable).size > 64 * 1024) break
        const source = sources.get(executable) ?? readFileSync(executable, "utf8")
        if (source.includes("process.env.FAKE_")) {
          sources.set(executable, source)
          writeFileSync(executable, source.replace(/process\.env\.(FAKE_[A-Z_]+)/g, (_, key) => JSON.stringify(process.env[key]) ?? "undefined"))
        }
        break
      }
    }
    return (nativeSpawn as any)(...args)
  }) as typeof Bun.spawn
})
afterEach(() => {
  Bun.spawn = nativeSpawn
  if (originalUiState === undefined) delete process.env.SHELLQ_STATE_DIR
  else process.env.SHELLQ_STATE_DIR = originalUiState
  if (originalNativeHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalNativeHome
  rmSync(isolatedFixtureRoot, { recursive: true, force: true })
})

// A disposable Bun subprocess standing in for the real provider: it never
// makes a network or authenticated call, and it returns a corrected_command
// that is materially different on every call (keyed off how many commands
// the request already asked it to avoid), so `appendCandidate` accepts each
// one instead of deduping it away.
const FAKE_PROVIDER = [
  "bun",
  "-e",
  `const req = JSON.parse(await Bun.stdin.text());
   if (req.mode === "ask") {
     if (process.env.SHELLQ_STREAM_PREVIEW !== "1") process.exit(70);
     console.log(JSON.stringify({ answer: "fixture answer" }));
   } else {
     if (process.env.SHELLQ_STREAM_PREVIEW !== undefined) process.exit(71);
     const avoid = Array.isArray(req.input.avoid_commands) ? req.input.avoid_commands.length : 0;
     console.log(JSON.stringify({
       tldr: "fixture suggestion",
       corrected_command: "echo candidate-" + avoid,
       confidence: 0.8,
       risk: "removes files",
     }));
   }`,
]

// A deliberately slow stand-in that holds `phase === "loading"` open long
// enough to prove pointer input is ignored while a request is in flight —
// FAKE_PROVIDER above resolves too fast for a test to reliably observe that
// window.
const SLOW_PROVIDER = [
  "bun",
  "-e",
  `await Bun.stdin.text();
   await new Promise((resolve) => setTimeout(resolve, 2000));
   console.log(JSON.stringify({
     tldr: "slow fixture suggestion",
     corrected_command: "echo slow",
     confidence: 0.5,
     risk: "low",
   }));`,
]

const SLOW_ASK_PROVIDER = [
  "bun",
  "-e",
  `const req = JSON.parse(await Bun.stdin.text());
   if (process.env.SHELLQ_STREAM_PREVIEW !== "1") process.exit(70);
   await new Promise((resolve) => setTimeout(resolve, 400));
   console.log(JSON.stringify({ answer: "slow answer for " + req.input.query }));`,
]

const STREAM_OUTCOME_PROVIDER = [
  "bun",
  "-e",
  `const req = JSON.parse(await Bun.stdin.text());
   if (process.env.SHELLQ_STREAM_PREVIEW !== "1") process.exit(70);
   if (req.input.query === "first") {
     console.log(JSON.stringify({ answer: "previous answer" }));
   } else {
     if (req.input.query === "cancel") process.on("SIGTERM", () => {});
     const preview = req.input.query === "overflow"
       ? "PREVIEW_HEAD\\nline 02\\nline 03\\nline 04\\nline 05\\nline 06\\nline 07\\nline 08\\nline 09\\nPREVIEW_TAIL"
       : "request-local preview";
     console.log(JSON.stringify({ t: "delta", text: preview }));
     await new Promise((resolve) => setTimeout(resolve, 150));
     if (req.input.query === "fail") process.exit(9);
     await new Promise((resolve) => setTimeout(resolve, 2000));
     console.log(JSON.stringify({ answer: "late answer" }));
   }`,
]

const ANALYSIS_PROVIDER = [
  "bun",
  "-e",
  `await Bun.stdin.text();
   console.log(JSON.stringify({
     tldr: "no safe single command",
     corrected_command: null,
     confidence: 0.2,
     risk: "unknown",
   }));`,
]

const FAILURE_PROVIDER = [
  "bun",
  "-e",
  `await Bun.stdin.text(); process.exit(9);`,
]

const MULTI_TURN_PROVIDER = [
  "bun",
  "-e",
  `const req = JSON.parse(await Bun.stdin.text());
   const query = String(req.input.query);
   console.log(JSON.stringify({
     answer: [1, 2, 3, 4].map((line) => query + " answer " + line).join("\\n"),
   }));`,
]

const ECHO_COMMAND_PROVIDER = [
  "bun",
  "-e",
  `const req = JSON.parse(await Bun.stdin.text());
   const avoid = Array.isArray(req.input.avoid_commands) ? req.input.avoid_commands.length : 0;
   console.log(JSON.stringify({
     tldr: "saw " + req.input.command,
     corrected_command: "echo " + req.input.command + "-" + avoid,
     confidence: 0.8,
     risk: "low",
   }));`,
]

const fixtureSession = (overrides: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  initial_intent: "generate",
  requests: {
    ask: {
      mode: "ask",
      instructions: "Return Ask JSON.",
      input: {
        query: "",
        environment: { cwd: "/tmp", shell: "zsh", platform: "darwin" },
        captured_output: "",
      },
    },
    generate: {
      mode: "generate",
      instructions: "Return JSON.",
      input: { command: "", captured_output: "", captured_output_correlated_to_command: false },
      response_schema: { type: "object" },
    },
    correct: {
      mode: "correct",
      instructions: "Return correction JSON.",
      input: { command: "pwd", captured_output: "", captured_output_correlated_to_command: false },
      response_schema: { type: "object" },
    },
  },
  provider: FAKE_PROVIDER,
  model: "gpt-5.3-codex-spark",
  reasoning: "low",
  models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
  reasoning_levels: ["low", "medium", "high"],
  context: { text: "", source: "none", label: "unavailable", correlated: false, included: false },
  actionable_failure: false,
  last_command: null,
  ...overrides,
  provider_id: "provider_id" in overrides
    ? overrides.provider_id
    : overrides.provider?.length === 1 && overrides.provider[0] === BUNDLED_CODEX_PROVIDER
      ? "codex"
      : null,
  provider_source: "provider_source" in overrides
    ? overrides.provider_source
    : overrides.provider?.length === 1 && overrides.provider[0] === BUNDLED_CODEX_PROVIDER
      ? "default"
      : "configured",
  codex_ask_engine: overrides.codex_ask_engine ?? null,
})

// Seeds a version-2 settings document into an isolated state root; tests that
// assert the sixteen-row peak need the maximum raised above the twelve-row
// default the Global maximum frame height setting imposes.
const seedStateRoot = (stateDir: string, extra: Record<string, unknown>) => {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ version: 2, provider: "codex", providers: {}, ...extra }))
}

// Provider wrappers are zsh scripts, and a developer's own startup files can
// put real CLIs ahead of this file's fakes on PATH. Every zsh child reads its
// startup files from an empty directory instead.
process.env.ZDOTDIR = mkdtempSync(join(tmpdir(), "shellq-ui-zdotdir-"))
// Real provider CLIs must never run from this file: fail-closed stubs keep
// codex and claude "on PATH" for availability checks, and tests that need a
// working CLI prepend their own fake ahead of these.
const PROVIDER_CLI_STUBS = mkdtempSync(join(tmpdir(), "shellq-ui-cli-stubs-"))
for (const name of ["codex", "claude"]) {
  writeFileSync(join(PROVIDER_CLI_STUBS, name), `#!/bin/sh\necho "shellq test stub: real ${name} is not reachable" >&2\nexit 127\n`, { mode: 0o700 })
}
process.env.PATH = `${PROVIDER_CLI_STUBS}:${process.env.PATH ?? ""}`

async function mountWorkbench(options: {
  width: number
  height: number
  askSessionFile?: string | null
  askSessionFiles?: Record<CodexAskEngine, string> | null
  initialAskChatSaved?: boolean
  session?: WorkbenchSession
  initialNotice?: string | null
  kittyKeyboard?: boolean
  trustedWorkdir?: string
}) {
  const session = options.session ?? fixtureSession()
  if (
    options.askSessionFile &&
    session.codex_ask_engine === null &&
    session.provider.length === 1 &&
    session.provider[0] === BUNDLED_CODEX_PROVIDER
  ) {
    session.codex_ask_engine = "exec"
  }
  const askSessionFiles = options.askSessionFiles ??
    (options.askSessionFile && session.codex_ask_engine
      ? { "app-server": options.askSessionFile, exec: options.askSessionFile }
      : undefined)
  const testSetup = await createTestRenderer({
    width: options.width,
    height: options.height,
    screenMode: "split-footer",
    footerHeight: 3,
    useMouse: true,
    enableMouseMovement: false,
    autoFocus: false,
    kittyKeyboard: options.kittyKeyboard,
  })
  const resultDir = mkdtempSync(join(tmpdir(), "shellq-ui-test-"))
  const resultPath = join(resultDir, "result.json")
  const active: ActiveProcess = {
    process: null,
    discoveryProcess: null,
    discoveryCancel: null,
    discoveryClosing: null,
  }
  mount(
    testSetup.renderer,
    session,
    resultPath,
    options.trustedWorkdir ?? HOME_CWD,
    active,
    options.askSessionFile ?? null,
    options.initialAskChatSaved ?? false,
    options.initialNotice ?? null,
    askSessionFiles,
  )
  // A fresh mount needs a few real render passes before its first effect
  // pass (terminal-dimension measurement, footer sizing) has settled.
  for (let pass = 0; pass < 10; pass += 1) {
    await testSetup.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { ...testSetup, active, resultPath }
}

function findComposerContentChange(
  node: any,
): ((event: Record<string, never>) => void) | null {
  if (node?.editBuffer && typeof node.onContentChange === "function") {
    return node.onContentChange
  }
  for (const child of node?.getChildren?.() ?? []) {
    const callback = findComposerContentChange(child)
    if (callback) return callback
  }
  return null
}

// Pumps real render passes (never a bare timer) until `predicate` is true
// on the captured frame, or throws with the last frame attached. This is
// the "predicate-pumped mount" pattern: robust against both a render that
// hasn't settled yet and a subprocess response that hasn't arrived yet.
async function pumpUntilFrame(
  testSetup: { renderOnce: () => Promise<void>; captureCharFrame: () => string },
  predicate: (frame: string) => boolean,
  { tries = 60, delayMs = 25 } = {},
): Promise<string> {
  for (let pass = 0; pass <= tries; pass += 1) {
    await testSetup.renderOnce()
    const frame = testSetup.captureCharFrame()
    if (predicate(frame)) return frame
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(
    `predicate not satisfied after ${tries} passes\n${testSetup.captureCharFrame()}`,
  )
}

const usesExplicitInverseColors = (span: {
  bg: { b: number; g: number; r: number }
  fg: { b: number; g: number; r: number }
}) =>
  span.fg.r === 0 && span.fg.g === 0 && span.fg.b === 0 &&
  span.bg.r === 1 && span.bg.g === 1 && span.bg.b === 1

const focusedSelectionLine = (setup: Awaited<ReturnType<typeof mountWorkbench>>) =>
  setup.captureSpans().lines.find((line) =>
    line.spans.some(usesExplicitInverseColors),
  )

async function closePalette(
  setup: Awaited<ReturnType<typeof mountWorkbench>>,
): Promise<void> {
  for (let pass = 0; pass < 8; pass += 1) {
    const before = setup.captureCharFrame()
    if (
      !before.includes("Actions ·") &&
      !/(?:Search All|Search Models|Search Effort|Search Providers|Search Engines|Search More):/u.test(before)
    ) return
    setup.mockInput.pressEscape()
    await pumpUntilFrame(setup, (frame) => frame !== before, { tries: 20, delayMs: 5 })
  }
  throw new Error(`palette did not close\n${setup.captureCharFrame()}`)
}

async function openDoctorViaAction(
  setup: Awaited<ReturnType<typeof mountWorkbench>>,
): Promise<string> {
  setup.mockInput.pressKey("x", { ctrl: true })
  setup.mockInput.pressKey("d")
  return pumpUntilFrame(
    setup,
    (frame) => frame.includes("PASS cwd") && frame.includes("Ask pointer"),
  )
}

// The renderer's own `renderOffset` (private in its public types, but real
// at runtime) is the footer band's absolute screen row in split-footer
// mode; a raw mock click needs it added back into `y`, since real mouse
// dispatch subtracts it before a component ever sees the event.
const footerRenderOffset = (renderer: unknown): number =>
  (renderer as { renderOffset: number }).renderOffset

const REUSE_UI_FAKE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const threadId = "019fd36e-a83f-7ad3-ba25-243ea233e1f3";
const ephemeralThreadIds = [
  "019fd36e-a83f-7ad3-ba25-243ea233e1f4",
  "019fd36e-a83f-7ad3-ba25-243ea233e1f5",
];
const turns = [
  "019fd3fe-b1b0-71b0-9fba-38734709fed6",
  "019fd3fe-b1b0-71b0-9fba-38734709fed7",
  "019fd3fe-b1b0-71b0-9fba-38734709fed8",
  "019fd3fe-b1b0-71b0-9fba-38734709fed9",
];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (value) => appendFileSync(process.env.FAKE_LOG, value + "\\n");
let cwd = "";
let turn = 0;
let ephemeral = 0;
let malformedAskSent = false;
const threadCwds = new Map();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.method === "config/read") {
    send({ id: message.id, result: { config: {}, layers: [{ name: { type: "user", file: process.env.CODEX_HOME + "/config.toml", profile: null }, disabledReason: null }] } });
    continue;
  }
  if (message.method === "skills/list") {
    send({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], skills: [], errors: [] }] } });
    continue;
  }
  if (message.method === "initialize") {
    log("initialize");
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    cwd = message.params.cwd;
    const startedId = message.params.ephemeral ? ephemeralThreadIds[ephemeral++] : threadId;
    log(message.method);
    if (process.env.FAKE_FAIL_READY_ONCE && !existsSync(process.env.FAKE_FAIL_READY_ONCE)) {
      writeFileSync(process.env.FAKE_FAIL_READY_ONCE, "failed");
      process.exit(1);
    }
    if (process.env.FAKE_READY_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_READY_DELAY_MS));
    send({ id: message.id, result: {
      thread: { id: startedId, cwd, ephemeral: Boolean(message.params.ephemeral) }, cwd,
      approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false },
      model: message.params.model, reasoningEffort: message.params.config.model_reasoning_effort,
      instructionSources: [],
    }});
    threadCwds.set(startedId, cwd);
  } else if (message.method === "turn/start") {
    const turnId = turns[turn];
    const id = "agent-" + turn;
    const structured = message.params.input[0].text.includes("STRUCTURED REQUEST (JSON)");
    const malformed = message.params.input[0].text.includes('"command":"malformed"');
    const malformedAsk = !structured && !malformedAskSent && message.params.input[0].text.includes("malformed ask");
    if (malformedAsk) malformedAskSent = true;
    const batch = structured && /"candidate_count":[2-5]/.test(message.params.input[0].text);
    let answer = malformedAsk
      ? ""
      : malformed
      ? "not json"
      : structured
      ? JSON.stringify({ tldr: "fixture suggestion", corrected_command: "echo app-server", confidence: 0.8, risk: "low" })
      : "warm-answer-" + (turn + 1);
    if (batch && answer.startsWith("{") && !answer.includes('"candidates"')) answer = '{"candidates":[' + answer + "]}";
    turn += 1;
    log("turn/start");
    if (process.env.FAKE_TURN_DELAY_MS) await Bun.sleep(Number(process.env.FAKE_TURN_DELAY_MS));
    send({ id: message.id, result: { turn: { id: turnId } } });
    const activeThreadId = message.params.threadId;
    const base = { threadId: activeThreadId, turnId };
    send({ method: "item/started", params: { ...base, item: { id, type: "agentMessage", phase: "final_answer" } } });
    send({ method: "item/agentMessage/delta", params: { ...base, itemId: id, delta: answer } });
    send({ method: "item/completed", params: { ...base, item: { id, type: "agentMessage", phase: "final_answer", text: answer } } });
    send({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: turnId, status: "completed" } } });
  } else if (message.method === "thread/read") {
    log("thread/read");
    const readThreadId = message.params.threadId;
    send({ id: message.id, result: { thread: { id: readThreadId, cwd: threadCwds.get(readThreadId), status: { type: "idle" }, turns: [] } } });
  }
}
`

const DISCOVERY_UI_FAKE = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.method === "config/read") {
    send({ id: message.id, result: { config: {}, layers: [{ name: { type: "user", file: process.env.CODEX_HOME + "/config.toml", profile: null }, disabledReason: null }] } });
    continue;
  }
  if (message.method === "skills/list") {
    send({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], skills: [], errors: [] }] } });
    continue;
  }
  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "model/list") {
    await Bun.sleep(Number(process.env.FAKE_CATALOG_DELAY_MS || 200));
    if (process.env.FAKE_CATALOG_MODE === "fail") process.exit(1);
    const ids = process.env.FAKE_CATALOG_MODE === "empty"
      ? []
      : process.env.FAKE_CATALOG_MODE === "sol-only"
        ? ["gpt-5.6-sol"]
        : process.env.FAKE_CATALOG_MODE === "disappear"
          ? ["gpt-5.6-sol", "gpt-5.6-luna"]
          : ["gpt-5.6-sol", "gpt-5.3-codex-spark", "gpt-5.6-luna"];
    send({ id: message.id, result: {
      data: ids.map((model, index) => ({
        id: model, model,
        displayName: model.includes("sol") ? "Sol" : model.includes("spark") ? "Spark" : "Luna",
        description: "fixture",
        supportedReasoningEfforts: ["low"],
        defaultReasoningEffort: "low",
        isDefault: index === 0,
      })),
      nextCursor: null,
    }});
  }
}
`

describe("mounted workbench component", () => {
  test("Phase 1 palette applies Luna, opens Doctor, and firewalls Another", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-universal-picker-test-"))
    const bin = join(root, "bin")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    mkdirSync(bin, { recursive: true })
    for (const name of ["codex", "claude"]) {
      const path = join(bin, name)
      writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    }
    process.env.PATH = `${bin}:${oldPath ?? ""}`
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const setup = await mountWorkbench({
      height: 8,
      session: fixtureSession({
        initial_intent: "generate",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5", "claude-opus-5"],
        provider: [BUNDLED_CLAUDE_PROVIDER],
        provider_id: "claude",
        provider_source: "default",
        reasoning: "low",
      }),
      width: 80,
    })
    try {
      await setup.mockInput.typeText("pwd")
      await setup.mockInput.pressKeys(["\u0018s"])
      const opened = await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search All:") &&
        frame.includes("Set model"),
      )
      expect(opened).not.toContain("pwd")
      expect(opened).toContain("Esc close")

      await setup.mockInput.typeText("lun")
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("Luna · Set model") && frame.includes("Enter apply"),
      )
      expect(setup.captureCharFrame()).toContain("Esc clear")
      setup.mockInput.pressEnter()
      const sticky = await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search Effort:") &&
        frame.includes("Applied Codex/Luna"),
      )
      expect(sticky).toContain("Codex/Luna")
      expect(readPersistedInferenceSettings({ SHELLQ_STATE_DIR: join(root, "state") }, "codex"))
        .toEqual({ model: "gpt-5.6-luna", reasoning: "low" })
      expect(setup.active.process).toBeNull()

      await setup.mockInput.typeText("doctor")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) => frame.includes("PASS cwd"))
      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("PASS cwd"))

      await setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("another")
      setup.mockInput.pressEnter()
      const routed = await pumpUntilFrame(setup, (frame) =>
        frame.includes("Actions") && frame.includes("Another suggestion"),
      )
      expect(routed).toContain("A    another suggestion · key only")
      expect(setup.active.process).toBeNull()

      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("Actions ·") && frame.includes("pwd"))

      setup.mockInput.pressKey("k", { ctrl: true })
      await pumpUntilFrame(setup, (frame) => {
        const body = frame.split("\n").slice(1, 7).join("\n")
        return frame.includes("Search All:") && body.includes("Set model") && !body.includes("Luna")
      })
      await setup.mockInput.typeText("more")
      await pumpUntilFrame(setup, (frame) => frame.includes("More settings & actions"))
      setup.mockInput.pressEnter()
      // Arrows, not typing: in-sheet typing after an Enter-routed view
      // switch does not reach the query input (suspected product focus bug —
      // ticketed separately), and Set engine sits one row below the
      // current-ranked Max height leaf.
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("App Server") && frame.includes("Codex Exec"),
      )
      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => frame.includes("Set model"))
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("a")
      expect(setup.captureCharFrame().split("\n").some((line) => line.includes("╭─Actions"))).toBe(false)
      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) =>
        !frame.split("\n").slice(1, 7).join("\n").includes("Luna"),
      )
    } finally {
      setup.renderer.destroy()
      process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("changes only Engine for a transport-safe catalog-absent Codex tuple", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-provisional-engine-test-"))
    const bin = join(root, "bin")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    process.env.PATH = `${bin}:${oldPath ?? ""}`
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const session = fixtureSession({
      codex_ask_engine: "app-server",
      model: "gpt-private-safe",
      models: ["gpt-5.6-luna"],
      provider: [BUNDLED_CODEX_PROVIDER],
      provider_id: "codex",
      provider_source: "default",
      reasoning: "ultra",
      reasoning_levels: ["low"],
    })
    const setup = await mountWorkbench({ height: 8, session, width: 80 })
    try {
      setup.mockInput.pressKey("k", { ctrl: true })
      await pumpUntilFrame(setup, (frame) => frame.includes("Set model"))
      await setup.mockInput.typeText("more")
      await pumpUntilFrame(setup, (frame) => frame.includes("More settings & actions"))
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) => frame.includes("Set engine"))
      await setup.mockInput.typeText("engine")
      await pumpUntilFrame(setup, (frame) => frame.includes("Set engine") && !frame.includes("Max height"))
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("App Server") && frame.includes("Codex Exec"),
      )
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("Applied Codex/gpt-priva") &&
        frame.includes("Enter keep") &&
        frame.includes("Esc back") &&
        frame.includes("current") &&
        !frame.includes("Already current") &&
        session.codex_ask_engine === "exec",
      )
      expect(session.codex_ask_engine).toBe("exec")
      expect(session.model).toBe("gpt-private-safe")
      expect(session.reasoning).toBe("ultra")
      expect(readPersistedInferenceSettings({ SHELLQ_STATE_DIR: join(root, "state") }, "codex"))
        .toBeNull()
    } finally {
      setup.renderer.destroy()
      process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("keeps discovery focus by stable identity across catalog reorder", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-discovery-focus-test-"))
    const oldPath = process.env.PATH
    const oldModel = process.env.SHELLQ_CODEX_MODEL
    const oldModels = process.env.SHELLQ_WORKBENCH_MODELS
    process.env.SHELLQ_CODEX_MODEL = "gpt-5.6-luna"
    process.env.SHELLQ_WORKBENCH_MODELS = "gpt-5.3-codex-spark"
    try {
      const bin = join(root, "bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "codex"), DISCOVERY_UI_FAKE, { mode: 0o700 })
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      const setup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          model: "gpt-5.6-luna",
          models: ["gpt-5.6-luna", "gpt-5.3-codex-spark"],
          provider: [BUNDLED_CODEX_PROVIDER],
          provider_id: "codex",
          provider_source: "default",
          reasoning: "low",
          reasoning_levels: ["low"],
        }),
        width: 80,
      })
      try {
        setup.mockInput.pressKey("x", { ctrl: true })
        setup.mockInput.pressKey("m")
        await pumpUntilFrame(setup, (frame) =>
          frame.includes("Luna") && frame.includes("Spark"),
        )
        setup.mockInput.pressArrow("down")
        await pumpUntilFrame(setup, (frame) =>
          focusedSelectionLine(setup)?.spans.some((span) => span.text.includes("Spark")) === true &&
          frame.includes("Enter apply"),
        )
        const published = await pumpUntilFrame(setup, (frame) =>
          frame.includes("Sol") &&
          focusedSelectionLine(setup)?.spans.some((span) => span.text.includes("Spark")) === true &&
          frame.includes("Enter apply"),
        )
        expect(published).toContain("Sol")
      } finally {
        setup.renderer.destroy()
      }
    } finally {
      process.env.PATH = oldPath
      if (oldModel === undefined) delete process.env.SHELLQ_CODEX_MODEL
      else process.env.SHELLQ_CODEX_MODEL = oldModel
      if (oldModels === undefined) delete process.env.SHELLQ_WORKBENCH_MODELS
      else process.env.SHELLQ_WORKBENCH_MODELS = oldModels
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("Provider Setup obeys Sol-only and authoritative-empty Codex catalogs", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-setup-catalog-test-"))
    const bin = join(root, "bin")
    const oldPath = process.env.PATH
    const oldMode = process.env.FAKE_CATALOG_MODE
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "codex"), DISCOVERY_UI_FAKE, { mode: 0o700 })
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    process.env.PATH = `${bin}:${oldPath ?? ""}`
    try {
      for (const mode of ["sol-only", "empty"] as const) {
        process.env.FAKE_CATALOG_MODE = mode
        process.env.SHELLQ_STATE_DIR = join(root, mode)
        const session = fixtureSession({
          codex_ask_engine: null,
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          provider: [BUNDLED_CLAUDE_PROVIDER],
          provider_id: "claude",
          provider_source: "default",
          reasoning: "low",
          reasoning_levels: ["low"],
        })
        const setup = await mountWorkbench({ height: 9, session, width: 80 })
        try {
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("m")
          await pumpUntilFrame(setup, (frame) =>
            mode === "sol-only"
              ? frame.includes("Sol") && !frame.includes("Luna")
              : frame.includes("claude-sonnet-5") && !frame.includes("Luna"),
          )
          await closePalette(setup)
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("p")
          const opening = await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
          expect(opening).toContain("Codex CLI AVAILABLE")
          setup.mockInput.pressArrow("left")
          if (mode === "sol-only") {
            const selected = await pumpUntilFrame(setup, (frame) =>
              frame.includes("[codex]") && frame.includes("[gpt-5.6-sol]"),
            )
            expect(selected).not.toContain("Luna")
            expect(session.provider_id).toBe("codex")
            expect(session.model).toBe("gpt-5.6-sol")
            expect(session.codex_ask_engine).toBe("app-server")
          } else {
            await setup.renderOnce()
            expect(session.provider_id).toBe("claude")
            expect(session.model).toBe("claude-sonnet-5")
            expect(session.codex_ask_engine).toBeNull()
          }
        } finally {
          setup.renderer.destroy()
        }
      }
    } finally {
      process.env.PATH = oldPath
      if (oldMode === undefined) delete process.env.FAKE_CATALOG_MODE
      else process.env.FAKE_CATALOG_MODE = oldMode
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("keeps successful apply status when late discovery falls back", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-discovery-failure-test-"))
    const bin = join(root, "bin")
    const oldPath = process.env.PATH
    const oldMode = process.env.FAKE_CATALOG_MODE
    const oldDelay = process.env.FAKE_CATALOG_DELAY_MS
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    try {
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(bin, "codex"), DISCOVERY_UI_FAKE, { mode: 0o700 })
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.FAKE_CATALOG_MODE = "fail"
      process.env.FAKE_CATALOG_DELAY_MS = "800"
      process.env.SHELLQ_STATE_DIR = join(root, "state")
      const setup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          model: "gpt-5.3-codex-spark",
          provider: [BUNDLED_CODEX_PROVIDER],
          provider_id: "codex",
          provider_source: "default",
          reasoning: "low",
        }),
        width: 80,
      })
      try {
        setup.mockInput.pressKey("x", { ctrl: true })
        setup.mockInput.pressKey("m")
        await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
        await setup.mockInput.typeText("luna")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("Applied Codex/Luna"))
        await new Promise((resolve) => setTimeout(resolve, 900))
        const settled = await pumpUntilFrame(setup, (frame) => frame.includes("Applied Codex/Luna"))
        expect(settled).not.toContain("catalog unavailable")
      } finally {
        setup.renderer.destroy()
      }
    } finally {
      process.env.PATH = oldPath
      if (oldMode === undefined) delete process.env.FAKE_CATALOG_MODE
      else process.env.FAKE_CATALOG_MODE = oldMode
      if (oldDelay === undefined) delete process.env.FAKE_CATALOG_DELAY_MS
      else process.env.FAKE_CATALOG_DELAY_MS = oldDelay
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("Phase 2B activates toggle, open, guard, and refusal records locally", async () => {
    const setup = await mountWorkbench({
      height: 8,
      width: 80,
      session: fixtureSession({
        actionable_failure: false,
        context: {
          text: "captured output",
          source: "herdr",
          label: "matched command",
          correlated: false,
          included: false,
        },
      }),
    })
    try {
      await setup.mockInput.typeText("pwd")
      await setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))

      await setup.mockInput.typeText("attach output")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search All:") && frame.includes("output attached"),
      )
      expect(setup.active.process).toBeNull()

      await setup.mockInput.typeText("provider setup")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
      expect(setup.active.process).toBeNull()

      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("Provider Setup"))
      setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))

      await setup.mockInput.typeText("fix")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("Fix") && frame.includes("Fix needs an actionable"),
      )
      expect(setup.active.process).toBeNull()

      await closePalette(setup)
      await pumpUntilFrame(setup, (frame) =>
        !frame.split("\n").slice(1, 7).join("\n").includes("Fix"),
      )
      setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("another")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("Actions") && frame.includes("Another suggestion"),
      )
      expect(setup.active.process).toBeNull()

      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("Actions ·"))
      setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("new ask")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("[Ask]") && frame.includes("New Ask chat"),
      )
      expect(setup.active.process).toBeNull()
    } finally {
      setup.renderer.destroy()
    }
  }, 20_000)

  test("opens an empty Context editor from the universal palette", async () => {
    const setup = await mountWorkbench({
      height: 8,
      session: fixtureSession({
        context: { text: "", source: "none", label: "unavailable", correlated: false, included: false },
      }),
      width: 80,
    })
    try {
      setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("context")
      const opened = await pumpUntilFrame(setup, (frame) => frame.includes("Context"))
      expect(opened).not.toContain("[n-a]")
      setup.mockInput.pressEnter()
      const editor = await pumpUntilFrame(setup, (frame) => frame.includes("^X W save"))
      expect(editor).toContain("^X W save")
    } finally {
      setup.renderer.destroy()
    }
  }, 20_000)

  test("opens the contained Model picker from Ctrl-X S and applies one live identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-test-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const session = fixtureSession({
      codex_ask_engine: "app-server",
      initial_intent: "generate",
      provider: [BUNDLED_CODEX_PROVIDER],
      provider_id: "codex",
      provider_source: "configured",
    })
    const setup = await mountWorkbench({
      height: 8,
      session,
      width: 80,
    })
    try {
      await setup.mockInput.typeText("draft")
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      const opened = await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      expect(opened).not.toContain("draft")
      expect(opened).toContain("Esc back")
      expect(session.model).toBe("gpt-5.3-codex-spark")
      expect(readPersistedInferenceSettings({ SHELLQ_STATE_DIR: join(root, "state") }, "configured"))
        .toBeNull()

      await setup.mockInput.typeText("luna")
      const filtered = await pumpUntilFrame(setup, (frame) => {
        const body = frame.split("\n").slice(1, 7).join("\n")
        return frame.includes("Search Models: luna") &&
          body.includes("Luna") && body.includes("Configured") &&
          !body.includes("Spark")
      })
      expect(filtered).toContain("Enter apply")
      expect(filtered).toContain("Esc clear")
      expect(filtered).not.toContain("Already current")
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressEnter()
      const sticky = await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search Effort:") &&
        frame.includes("Applied Configured/Luna") &&
        frame.includes("current"),
      )
      expect(sticky).toContain("Luna")
      expect(session.model).toBe("gpt-5.6-luna")
      expect(readPersistedInferenceSettings({ SHELLQ_STATE_DIR: join(root, "state") }, "configured"))
        .toEqual({ model: "gpt-5.6-luna", reasoning: "low" })
      await closePalette(setup)
      const closed = setup.captureCharFrame()
      expect(closed).toContain("draft")
    } finally {
      setup.renderer.destroy()
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("labels cross-category child searches with their parent intent", async () => {
    const previousNoUnicode = process.env.NO_UNICODE
    try {
      for (const unicode of [true, false]) {
        if (unicode) delete process.env.NO_UNICODE
        else process.env.NO_UNICODE = "1"
        const setup = await mountWorkbench({
          height: 8,
          session: fixtureSession({ initial_intent: "generate" }),
          width: 80,
        })
        try {
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("m")
          await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
          await setup.mockInput.typeText("doctor")
          const frame = await pumpUntilFrame(setup, (current) =>
            current.includes("Search Models: doctor") &&
            current.includes(
              unicode
                ? "Doctor · More settings & actions"
                : "Doctor / More settings & actions",
            ),
          )
          expect(frame).toContain(unicode ? "Enter open · Esc clear" : "Enter open / Esc clear")
        } finally {
          setup.renderer.destroy()
        }
      }
    } finally {
      if (previousNoUnicode === undefined) delete process.env.NO_UNICODE
      else process.env.NO_UNICODE = previousNoUnicode
    }
  }, 20_000)

  test("keeps Escape mutation-free and current model Enter drills into Effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-noop-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const setup = await mountWorkbench({
      height: 8,
      session: fixtureSession({ initial_intent: "generate" }),
      width: 80,
    })
    try {
      await setup.mockInput.typeText("draft")
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      setup.mockInput.pressEnter()
      const afterCurrent = await pumpUntilFrame(
        setup,
        (frame) => frame.includes("Search Effort:") && frame.includes("current"),
      )
      expect(afterCurrent).toContain("Enter done")
      expect(existsSync(inferenceSettingsFile({ SHELLQ_STATE_DIR: join(root, "state") }))).toBe(false)
      setup.mockInput.pressEnter()
      const afterDone = await pumpUntilFrame(
        setup,
        (frame) => frame.includes("draft") && !frame.includes("Search Effort:"),
      )
      expect(afterDone).toContain("Spark")
      expect(existsSync(inferenceSettingsFile({ SHELLQ_STATE_DIR: join(root, "state") }))).toBe(false)
      expect(setup.active.process).toBeNull()

      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await closePalette(setup)
      const afterEscape = await pumpUntilFrame(setup, (frame) => frame.includes("draft"))
      expect(afterEscape).toContain("Spark")
      expect(existsSync(inferenceSettingsFile({ SHELLQ_STATE_DIR: join(root, "state") }))).toBe(false)
      expect(setup.active.process).toBeNull()
    } finally {
      setup.renderer.destroy()
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("contains a same-drain Ctrl-X S and duplicate Enter", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-drain-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const setup = await mountWorkbench({
      height: 8,
      session: fixtureSession({ initial_intent: "generate" }),
      width: 80,
    })
    try {
      await setup.mockInput.typeText("draft")
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      const opened = await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      expect(opened).not.toContain("Actions ·")

      await setup.mockInput.typeText("luna")
      await pumpUntilFrame(setup, (frame) => {
        const body = frame.split("\n").slice(1, 7).join("\n")
        return frame.includes("Search Models: luna") &&
          body.includes("Luna") && body.includes("Configured") &&
          !body.includes("Spark")
      })
      setup.mockInput.pressEnter()
      setup.mockInput.pressEnter()
      const sticky = await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search Effort:") &&
        frame.includes("Applied Configured/Luna") &&
        frame.includes("current"),
      )
      expect(sticky).toContain("Luna")
      expect(readPersistedInferenceSettings({ SHELLQ_STATE_DIR: join(root, "state") }, "configured"))
        .toEqual({ model: "gpt-5.6-luna", reasoning: "low" })
      await closePalette(setup)
      const closed = setup.captureCharFrame()
      expect(closed).toContain("draft")
    } finally {
      setup.renderer.destroy()
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("applies same-drain typed and pasted picker queries", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-same-drain-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    try {
      for (const paste of [false, true]) {
        const setup = await mountWorkbench({
          height: 8,
          session: fixtureSession({ initial_intent: "generate" }),
          width: 80,
        })
        try {
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("m")
          if (paste) await setup.mockInput.pasteBracketedText("luna")
          else await setup.mockInput.typeText("luna")
          setup.mockInput.pressEnter()
          const closed = await pumpUntilFrame(
            setup,
            (frame) => frame.includes("Search Models:") && frame.includes("Luna") && frame.includes("current"),
          )
          expect(closed).toContain("Luna")
          await closePalette(setup)
        } finally {
          setup.renderer.destroy()
        }
      }
    } finally {
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("rebuilds live picker results before same-drain Down", async () => {
    const setup = await mountWorkbench({
      height: 8,
      session: fixtureSession({
        initial_intent: "generate",
        models: ["gpt-5.3-codex-spark", "target-a", "target-b", "target-c"],
      }),
      width: 80,
    })
    try {
      await setup.mockInput.pressKeys(["\u0018m"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("target")
      setup.mockInput.pressArrow("down")
      await pumpUntilFrame(setup, (frame) =>
        focusedSelectionLine(setup)?.spans.some((span) => span.text.includes("target-b")) === true &&
        frame.includes("Enter apply"),
      )
      const focused = focusedSelectionLine(setup)
      expect(focused).toBeDefined()
      expect(focused!.spans.map((span) => span.text).join("")).toContain("target-b")
      expect(focused!.spans
        .filter(usesExplicitInverseColors)
        .reduce((width, span) => width + span.width, 0))
        .toBe(frameLayout(80).interior)
      expect(focused!.spans.every(
        (span) => (span.attributes & TextAttributes.INVERSE) === 0,
      )).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  }, 20_000)

  test("keeps the picker cursor at the logical position after rejected paste", async () => {
    const setup = await mountWorkbench({
      height: 8,
      session: fixtureSession({ initial_intent: "generate" }),
      width: 80,
    })
    try {
      await setup.mockInput.pressKeys(["\u0018s"])
      await setup.mockInput.typeText("gp")
      setup.mockInput.pressArrow("left")
      await setup.mockInput.pasteBracketedText("\u202e\u0001")
      await setup.mockInput.typeText("t")
      const frame = await pumpUntilFrame(setup, current => current.includes("gtp"))
      expect(frame).toContain("gtp")
    } finally {
      setup.renderer.destroy()
    }
  }, 20_000)

  test("Up/Down replaces sticky set and toggle status with focused truth", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-picker-status-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    try {
      const setSetup = await mountWorkbench({
        height: 8,
        session: fixtureSession({ initial_intent: "generate" }),
        width: 80,
      })
      try {
        setSetup.mockInput.pressKeys(["\u0018s"])
        await pumpUntilFrame(setSetup, (frame) => frame.includes("Search All:"))
        await setSetup.mockInput.typeText("luna")
        await pumpUntilFrame(setSetup, (frame) => frame.includes("Luna"))
        setSetup.mockInput.pressEnter()
        await pumpUntilFrame(setSetup, (frame) => frame.includes("Applied"))
        setSetup.mockInput.pressArrow("down")
        const focusedSet = await pumpUntilFrame(
          setSetup,
          (frame) => focusedSelectionLine(setSetup)?.spans.some(
            (span) => span.text.includes("medium"),
          ) === true && frame.includes("Enter apply"),
        )
        const focusedEffort = focusedSelectionLine(setSetup)
        expect(focusedEffort).toBeDefined()
        expect(focusedEffort!.spans.map((span) => span.text).join(""))
          .toContain("medium")
        expect(focusedEffort!.spans.map((span) => span.text).join(""))
          .toContain("Configured")
        expect(focusedSet).not.toContain("Applied")
      } finally {
        setSetup.renderer.destroy()
      }

      const toggleSetup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          context: {
            correlated: false,
            included: false,
            label: "matched command",
            source: "herdr",
            text: "output",
          },
        }),
        width: 80,
      })
      try {
        toggleSetup.mockInput.pressKeys(["\u0018s"])
        await pumpUntilFrame(toggleSetup, (frame) => frame.includes("Search All:"))
        await toggleSetup.mockInput.typeText("attach output")
        toggleSetup.mockInput.pressEnter()
        await pumpUntilFrame(toggleSetup, (frame) => frame.includes("output attached"))
        toggleSetup.mockInput.pressArrow("down")
        const focusedToggle = await pumpUntilFrame(
          toggleSetup,
          (frame) => frame.includes("Set model") &&
            !frame.includes("output attached") &&
            frame.includes("Enter open"),
        )
        expect(focusedToggle).not.toContain("output attached")
      } finally {
        toggleSetup.renderer.destroy()
      }
    } finally {
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("keeps the picker at six interior rows across supported widths and glyph modes", async () => {
    const previousNoUnicode = process.env.NO_UNICODE
    try {
      for (const unicode of [true, false]) {
        if (unicode) delete process.env.NO_UNICODE
        else process.env.NO_UNICODE = "1"
        for (const width of [80, 100, 140]) {
          const setup = await mountWorkbench({
            height: 9,
            session: fixtureSession({
              models: [
                `gpt-${"x".repeat(124)}`,
                "gpt-5.6-luna",
                "model-three",
                "model-four",
                "model-five",
              ],
            }),
            width,
          })
          try {
            setup.mockInput.pressKey("x", { ctrl: true })
            setup.mockInput.pressKey("m")
            await pumpUntilFrame(
              setup,
              current => current.includes("Search Models:") && current.includes("Enter effort"),
            )
            setup.mockInput.pressArrow("down")
            const unfocused = await pumpUntilFrame(setup, current =>
              focusedSelectionLine(setup)?.spans.some((span) => span.text.includes("Luna")) === true &&
              current.includes("Enter apply") &&
              current.includes("model-three"),
            )
            const lines = unfocused.trimEnd().split("\n")
            expect(lines).toHaveLength(8)
            expect(lines[6]).toContain("model-five")
            expect(lines[7]).toMatch(/Enter (apply|effort)/u)
            expect(lines.slice(1, 7).join("\n")).not.toContain("[set]")
            expect(lines.slice(1, 7).every((line) => terminalWidth(line) <= width)).toBe(true)
            expect(unfocused).toContain("gpt-xxxxxxxxxxxxxxxx")
            expect(unfocused).toContain("Configured")
            expect(unfocused).not.toContain("no engine")
            expect(unfocused).not.toContain(unicode ? "→" : "->")
            expect(lines[2]).not.toContain("current")
            expect(lines[2]).not.toContain("Configured")
            const paintedLines = setup.captureSpans().lines
            const selectedLines = paintedLines.filter((line) =>
              line.spans.some(usesExplicitInverseColors),
            )
            expect(selectedLines).toHaveLength(1)
            expect(selectedLines[0]!.spans
              .filter(usesExplicitInverseColors)
              .reduce((paintedWidth, span) => paintedWidth + span.width, 0))
              .toBe(frameLayout(width).interior)
            expect(selectedLines[0]!.spans.every(
              (span) => (span.attributes & TextAttributes.INVERSE) === 0,
            )).toBe(true)
            expect(paintedLines[1]!.spans.every(
              (span) => !usesExplicitInverseColors(span),
            )).toBe(true)
            if (!unicode) expect(lines.slice(1, 7).join("\n")).not.toMatch(/[^\u0000-\u007f]/u)

            setup.mockInput.pressEscape()
            await pumpUntilFrame(setup, current => current.includes("Set model"))
            setup.mockInput.pressEscape()
            await pumpUntilFrame(setup, current => !current.includes("Set model"))
            setup.mockInput.pressKey("x", { ctrl: true })
            setup.mockInput.pressKey("r")
            const efforts = await pumpUntilFrame(setup, current =>
              current.includes("low") &&
              current.includes("medium") &&
              current.includes("high") &&
              (current.match(/Configured/g)?.length ?? 0) >= 3,
            )
            expect(efforts.trimEnd().split("\n").slice(1, 7).every((line) => terminalWidth(line) <= width))
              .toBe(true)
            expect(efforts).toContain("current")
          } finally {
            setup.renderer.destroy()
          }
        }
      }
    } finally {
      if (previousNoUnicode === undefined) delete process.env.NO_UNICODE
      else process.env.NO_UNICODE = previousNoUnicode
    }
  }, 20_000)

  test("applies only a live painted picker row and ignores inert pointer rows", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-pointer-picker-state-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = stateDir
    const session = fixtureSession({
      models: [
        "gpt-5.3-codex-spark",
        "gpt-5.6-luna",
        "model-three",
        "model-four",
        "model-five",
        "model-six",
      ],
    })
    const setup = await mountWorkbench({ height: 8, session, width: 80 })
    try {
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("model-")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models: model-"))
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      await pumpUntilFrame(setup, (frame) => frame.includes("model-five"))

      const offset = footerRenderOffset(setup.renderer)
      const row = offset + 5
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, row, MouseButtons.RIGHT)
      await setup.mockMouse.scroll(INTERIOR_ORIGIN_X + 4, row, "down")
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 1, MouseButtons.LEFT)
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 7, MouseButtons.LEFT)
      expect(setup.captureCharFrame()).toContain("model-")

      await closePalette(setup)
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("zzzz")
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("No matching settings") &&
        frame.includes("Esc clear") &&
        !frame.includes("no eligible local match") &&
        !frame.includes("Ctrl-X P") &&
        !frame.includes("Provider Setup"),
      )
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 2, MouseButtons.LEFT)
      expect(setup.captureCharFrame()).toContain("Search Models: zzzz")
      setup.mockInput.pressEscape()
      await pumpUntilFrame(
        setup,
        (frame) =>
          !frame.includes("No matching settings") &&
          !frame.includes("Search Models: zzzz"),
      )

      await closePalette(setup)
      setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("fix")
      const refusal = await pumpUntilFrame(
        setup,
        (frame) => frame.includes("Search All: fix") &&
          frame.includes("Fix · More settings & actions") &&
          frame.includes("unavailable"),
      )
      await setup.mockMouse.click(
        INTERIOR_ORIGIN_X + 4,
        footerRenderOffset(setup.renderer) + 1,
        MouseButtons.LEFT,
      )
      expect(setup.captureCharFrame()).toBe(refusal)
      await closePalette(setup)

      session.models = session.models.slice(0, 3)
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("model-")
      await setup.mockMouse.click(
        INTERIOR_ORIGIN_X + 4,
        footerRenderOffset(setup.renderer),
        MouseButtons.LEFT,
      )
      expect(setup.captureCharFrame()).toContain("model-")
      await closePalette(setup)

      session.models = [
        "gpt-5.3-codex-spark",
        "gpt-5.6-luna",
        "model-three",
        "model-four",
        "model-five",
        "model-six",
      ]
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("model-")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models: model-"))
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      await pumpUntilFrame(setup, (frame) => frame.includes("model-five"))
      const staleModel = session.models[4]
      session.models[4] = "model-replaced"
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 4, MouseButtons.LEFT)
      const stale = await pumpUntilFrame(setup, (frame) => frame.includes("model-"))
      expect(stale).toContain("Spark")
      expect(stale).not.toContain(staleModel)
      await closePalette(setup)

      session.models = [
        "gpt-5.3-codex-spark",
        "gpt-5.6-luna",
        "model-three",
        "model-four",
        "model-five",
        "model-six",
      ]
      session.reasoning_levels = ["low", "medium", "high"]
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("model-")
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("down")
      await pumpUntilFrame(setup, (frame) => frame.includes("model-five"))
      session.reasoning_levels = ["high"]
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 4, MouseButtons.LEFT)
      const changedDestination = await pumpUntilFrame(
        setup,
        (frame) => frame.includes("Selection is no longer"),
      )
      expect(changedDestination).toContain("model-five")
      expect(session.model).toBe("gpt-5.3-codex-spark")
      await closePalette(setup)

    } finally {
      setup.renderer.destroy()
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(stateDir, { force: true, recursive: true })
    }
  }, 20_000)

  test("keeps the footer inert and applies the fifth painted picker row", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-fifth-picker-row-"))
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const session = fixtureSession({
      models: [
        "gpt-5.3-codex-spark",
        "model-three",
        "model-four",
        "model-five",
        "model-six",
        "model-seven",
      ],
      provider_source: "configured",
    })
    const setup = await mountWorkbench({ height: 9, session, width: 80 })
    try {
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("model-")
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("model-three") && frame.includes("model-seven"),
      )
      const offset = footerRenderOffset(setup.renderer)
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 7, MouseButtons.LEFT)
      expect(session.model).toBe("gpt-5.3-codex-spark")
      await setup.mockMouse.click(INTERIOR_ORIGIN_X + 4, offset + 6, MouseButtons.LEFT)
      const applied = await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search Effort:") && frame.includes("Applied Configured/mode"),
      )
      expect(applied).toContain("model-seven")
      expect(session.model).toBe("model-seven")
    } finally {
      setup.renderer.destroy()
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  test("retires and prepares exactly once after a model picker change", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-retire-"))
    const bin = join(root, "bin")
    const workdir = join(root, "repo")
    const pointer = join(root, "state", "app-server.json")
    const log = join(root, "events.log")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
    const oldLog = process.env.FAKE_LOG
    const oldDelay = process.env.FAKE_READY_DELAY_MS
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(bin, { recursive: true })
      mkdirSync(workdir, { recursive: true })
      writeFileSync(log, "")
      const fake = join(bin, "codex")
      writeFileSync(fake, REUSE_UI_FAKE)
      chmodSync(fake, 0o700)
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.SHELLQ_STATE_DIR = join(root, "settings")
      process.env.SHELLQ_APP_SERVER_REUSE = "1"
      process.env.FAKE_LOG = log
      process.env.FAKE_READY_DELAY_MS = "300"
      setup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          initial_intent: "ask",
          provider: [BUNDLED_CODEX_PROVIDER],
        }),
        trustedWorkdir: workdir,
        width: 80,
      })
      await pumpUntilFrame(setup, () => readFileSync(log, "utf8").includes("thread/start"))
      await pumpUntilFrame(setup, () => setup!.active.preparing === null)
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length).toBe(1)

      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("luna")
      await pumpUntilFrame(setup, (frame) => {
        const body = frame.split("\n").slice(1, 7).join("\n")
        return frame.includes("Search Models: luna") &&
          body.includes("Luna") && body.includes("Codex") &&
          !body.includes("Spark")
      })
      setup.mockInput.pressEnter()
      setup.mockInput.pressEnter()
      await pumpUntilFrame(
        setup,
        (frame) => frame.includes("Search Effort:") &&
          frame.includes("Applied Codex/Luna") &&
          frame.includes("current"),
        { tries: 100, delayMs: 25 },
      )
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(1)
      await setup.mockInput.typeText("doctor")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) => frame.includes("PASS cwd"))
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(1)
      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("PASS cwd"))

      await setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("new ask")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) => frame.includes("New Ask chat"))
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(1)

      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("m")
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await closePalette(setup)
      await pumpUntilFrame(
        setup,
        (frame) => (readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0) === 2,
        { tries: 100, delayMs: 25 },
      )
      await pumpUntilFrame(setup, () => setup!.active.preparing === null)
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length).toBe(2)
      expect(setup.active.session?.pid).toBeNumber()
    } finally {
      await setup?.active.session?.dispose()
      setup?.renderer.destroy()
      process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
      else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
      if (oldLog === undefined) delete process.env.FAKE_LOG
      else process.env.FAKE_LOG = oldLog
      if (oldDelay === undefined) delete process.env.FAKE_READY_DELAY_MS
      else process.env.FAKE_READY_DELAY_MS = oldDelay
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("rejecting model retirement closes the picker without preparation", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-reject-"))
    const bin = join(root, "bin")
    const workdir = join(root, "repo")
    const pointer = join(root, "state", "app-server.json")
    const log = join(root, "events.log")
    const oldPath = process.env.PATH
    const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
    const oldLog = process.env.FAKE_LOG
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(bin, { recursive: true })
      mkdirSync(workdir, { recursive: true })
      writeFileSync(log, "")
      const fake = join(bin, "codex")
      writeFileSync(fake, REUSE_UI_FAKE)
      chmodSync(fake, 0o700)
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.SHELLQ_APP_SERVER_REUSE = "1"
      process.env.FAKE_LOG = log
      setup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          initial_intent: "ask",
          provider: [BUNDLED_CODEX_PROVIDER],
        }),
        trustedWorkdir: workdir,
        width: 80,
      })
      await pumpUntilFrame(setup, () => readFileSync(log, "utf8").includes("thread/start"))
      await pumpUntilFrame(setup, () => setup!.active.preparing === null)
      const mountedSession = setup.active.session
      expect(mountedSession).not.toBeNull()
      mountedSession!.dispose = async () => {
        throw new Error("retirement rejected")
      }
      const baselineStarts = readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0

      await setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      await setup.mockInput.typeText("luna")
      await pumpUntilFrame(setup, (frame) => {
        const body = frame.split("\n").slice(1, 7).join("\n")
        return frame.includes("Search All: luna") &&
          body.includes("Luna") && body.includes("Codex") &&
          !body.includes("Spark")
      })
      setup.mockInput.pressEnter()
      await setup.renderOnce()
      const failed = await pumpUntilFrame(
        setup,
        (frame) => !frame.includes("Search All:") &&
          setup!.active.session === null &&
          setup!.active.preparing === null,
      )
      expect(failed).toContain("retirement reject")
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(baselineStarts)
      expect(setup.active.session).toBeNull()
      expect(setup.active.preparing).toBeNull()

      await setup.mockInput.typeText("must not submit")
      setup.mockInput.pressEnter()
      const refusedSubmit = await pumpUntilFrame(
        setup,
        (frame) => frame.includes("must not submit") && frame.includes("setting change"),
      )
      expect(refusedSubmit).toContain("must not submit")
      expect(readFileSync(log, "utf8")).not.toContain("turn/start")
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(baselineStarts)
      expect(setup.active.process).toBeNull()
      expect(setup.active.session).toBeNull()

      await setup.mockInput.pressKeys(["\u0018s"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
      setup.mockInput.pressEscape()
      await pumpUntilFrame(
        setup,
        (frame) => !frame.includes("Search All:") &&
          setup!.active.session === null &&
          setup!.active.preparing === null,
      )
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(baselineStarts)
      expect(setup.active.session).toBeNull()
      expect(setup.active.preparing).toBeNull()
    } finally {
      await setup?.active.closing?.catch(() => {})
      setup?.renderer.destroy()
      process.env.PATH = oldPath
      if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
      else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
      if (oldLog === undefined) delete process.env.FAKE_LOG
      else process.env.FAKE_LOG = oldLog
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("rejects a changed dependent destination after delayed retirement", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-model-picker-dependent-"))
    const bin = join(root, "bin")
    const workdir = join(root, "repo")
    const stateDir = join(root, "state")
    const pointer = join(stateDir, "app-server.json")
    const log = join(root, "events.log")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
    const oldLog = process.env.FAKE_LOG
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(bin, { recursive: true })
      mkdirSync(workdir, { recursive: true })
      writeFileSync(log, "")
      writeFileSync(join(bin, "codex"), REUSE_UI_FAKE, { mode: 0o700 })
      writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.SHELLQ_STATE_DIR = stateDir
      process.env.SHELLQ_APP_SERVER_REUSE = "1"
      process.env.FAKE_LOG = log
      writePersistedInferenceSettings("claude-sonnet-5", "low", process.env, "claude")
      const session = fixtureSession({
        codex_ask_engine: "app-server",
        initial_intent: "ask",
        provider: [BUNDLED_CODEX_PROVIDER],
      })
      setup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        session,
        trustedWorkdir: workdir,
        width: 80,
      })
      await pumpUntilFrame(setup, () => readFileSync(log, "utf8").includes("thread/start"))
      await pumpUntilFrame(setup, () => setup!.active.preparing === null)
      const mountedSession = setup.active.session
      expect(mountedSession).not.toBeNull()
      const originalDispose = mountedSession!.dispose.bind(mountedSession)
      mountedSession!.dispose = async () => {
        await new Promise((resolve) => setTimeout(resolve, 75))
        writePersistedInferenceSettings("claude-sonnet-5", "high", process.env, "claude")
        await originalDispose()
      }
      const baselineStarts = readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0

      setup.mockInput.pressKeys(["\u0018m"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("claude sonnet")
      await pumpUntilFrame(setup, (frame) => frame.includes("claude-sonnet-5"))
      setup.mockInput.pressEnter()
      const failed = await pumpUntilFrame(
        setup,
        (frame) => !frame.includes("Search Models:") && frame.includes("selection is no"),
        { tries: 100, delayMs: 25 },
      )
      expect(failed).toContain("selection is no")
      expect(setup.active.session).toBeNull()
      expect(setup.active.preparing).toBeNull()
      expect(setup.active.process).toBeNull()
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0).toBe(baselineStarts)
      expect(session.provider_id).toBe("codex")
      expect(session.model).toBe("gpt-5.3-codex-spark")
      expect(session.reasoning).toBe("low")
      expect(readPersistedInferenceSettings(process.env, "claude")).toEqual({
        model: "claude-sonnet-5",
        reasoning: "high",
      })
    } finally {
      await setup?.active.closing?.catch(() => {})
      setup?.renderer.destroy()
      process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
      else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
      if (oldLog === undefined) delete process.env.FAKE_LOG
      else process.env.FAKE_LOG = oldLog
      rmSync(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("mounts managed zero-provider Setup, persists selection, and reloads it", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-setup-ui-test-"))
    const bin = join(root, "bin")
    const marker = join(root, "provider-called")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    mkdirSync(bin)
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho called > ${marker}\n`, { mode: 0o700 })
    process.env.PATH = bin
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    let second: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      setup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "exec",
          provider: [BUNDLED_CODEX_PROVIDER],
          provider_id: null,
          provider_source: "default",
        }),
        width: 80,
      })
      const opening = await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
      expect(opening).toContain("Codex CLI AVAILABLE")
      expect(opening).toContain("Model     unavailable until provider selected")
      expect(setup.active.process).toBeNull()
      expect(existsSync(marker)).toBe(false)

      setup.mockInput.pressArrow("right")
      await pumpUntilFrame(setup, (frame) => frame.includes("[codex]"))
      setup.mockInput.pressArrow("down")
      setup.mockInput.pressArrow("right")
      await pumpUntilFrame(setup, (frame) => frame.includes("› Model     [Luna]"))
      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("Provider Setup"))

      expect(readPersistedInferenceSettings({ SHELLQ_STATE_DIR: join(root, "state") }, "codex"))
        .toEqual({ model: "gpt-5.6-luna", reasoning: "low" })
      expect(existsSync(marker)).toBe(false)
      setup.renderer.destroy()
      setup = null

      const savedSession = fixtureSession({
        codex_ask_engine: "exec",
        provider: [BUNDLED_CODEX_PROVIDER],
        provider_id: null,
        provider_source: "default",
      })
      prepareProviderSession(savedSession, process.env)
      second = await mountWorkbench({ height: 8, session: savedSession, width: 80 })
      const restored = await pumpUntilFrame(second, (frame) => frame.includes("Luna"))
      expect(restored).toContain("codex")
      expect(restored).toContain("Luna")
      expect(restored).not.toContain("Provider Setup")
      expect(existsSync(marker)).toBe(false)
    } finally {
      setup?.renderer.destroy()
      second?.renderer.destroy()
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { force: true, recursive: true })
    }
  }, 20_000)

  test("pointer Setup selection applies the exact clicked provider ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-setup-pointer-test-"))
    const bin = join(root, "bin")
    const markerCodex = join(root, "codex-called")
    const markerClaude = join(root, "claude-called")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    mkdirSync(bin)
    for (const [name, marker] of [["codex", markerCodex], ["claude", markerClaude]] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf called > ${marker}\n`, { mode: 0o700 })
      chmodSync(join(bin, name), 0o700)
    }
    process.env.PATH = bin
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      setup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "exec",
          provider: [BUNDLED_CODEX_PROVIDER],
          provider_id: null,
          provider_source: "default",
        }),
        width: 80,
      })
      await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
      const providerRanges = providerSetupLines(
        {
          configured: false,
          controlsEnabled: false,
          field: "provider",
          modelIndex: 0,
          models: ["gpt-5.3-codex-spark"],
          providerId: null,
          providers: [
            { id: "codex", selectable: true },
            { id: "claude", selectable: true },
          ],
          reasoningIndex: 0,
          reasoningLevels: ["low"],
        },
        76,
        false,
      ).ranges.provider

      const clickProvider = async (index: number, expected: "codex" | "claude") => {
        await setup!.mockMouse.click(
          INTERIOR_ORIGIN_X + providerRanges[index].start + 1,
          footerRenderOffset(setup!.renderer) + 2,
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(setup!, (frame) => frame.includes(`[${expected}]`))
        expect(readPersistedInferenceDocument({ SHELLQ_STATE_DIR: join(root, "state") })?.provider)
          .toBe(expected)
      }

      await clickProvider(1, "claude")
      await clickProvider(0, "codex")
      expect(existsSync(markerCodex)).toBe(false)
      expect(existsSync(markerClaude)).toBe(false)
    } finally {
      setup?.renderer.destroy()
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      rmSync(root, { force: true, recursive: true })
    }
  }, 20_000)

  test(
    "exposes Doctor through Ctrl-X D across eligible modes and phases",
    async () => {
      const cases: Array<{
        name: string
        intent: "ask" | "generate" | "correct"
        provider?: string[]
        actionableFailure?: boolean
        prepare: (setup: Awaited<ReturnType<typeof mountWorkbench>>) => Promise<void>
      }> = [
        ...(["ask", "generate", "correct"] as const).map((intent) => ({
          name: `ready/${intent}`,
          intent,
          actionableFailure: intent === "correct",
          prepare: async () => {},
        })),
        {
          name: "answer/ask",
          intent: "ask",
          provider: FAKE_PROVIDER,
          prepare: async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
            setup.mockInput.typeText("answer phase")
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("fixture answer"))
          },
        },
        {
          name: "analysis/fix",
          intent: "correct",
          provider: ANALYSIS_PROVIDER,
          actionableFailure: true,
          prepare: async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
            setup.mockInput.typeText("pwd")
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("no safe single command"))
          },
        },
        ...(["ask", "generate", "correct"] as const).map((intent) => ({
          name: `failed/${intent}`,
          intent,
          provider: FAILURE_PROVIDER,
          actionableFailure: intent === "correct",
          prepare: async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
            setup.mockInput.typeText(intent === "ask" ? "failed phase" : "echo failed")
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("provider exited 9"))
          },
        })),
        ...(["ask", "generate", "correct"] as const).map((intent) => ({
          name: `cancelled/${intent}`,
          intent,
          provider: SLOW_PROVIDER,
          actionableFailure: intent === "correct",
          prepare: async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
            setup.mockInput.typeText(intent === "ask" ? "cancelled phase" : "echo cancelled")
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("Esc cancel"))
            setup.mockInput.pressEscape()
            await pumpUntilFrame(
              setup,
              (frame) => frame.includes("Enter retry") && setup.active.process === null,
            )
          },
        })),
      ]

      for (const entry of cases) {
        const session = fixtureSession({
          initial_intent: entry.intent,
          provider: entry.provider ?? FAKE_PROVIDER,
          actionable_failure: entry.actionableFailure ?? false,
        })
        session.requests.correct!.input.command = ""
        const setup = await mountWorkbench({
          height: 8,
          session,
          width: 80,
        })
        try {
          await entry.prepare(setup)
          const doctor = await openDoctorViaAction(setup)
          expect(doctor).toContain("PASS Ask pointer")
          expect(setup.active.process).toBeNull()

          setup.mockInput.pressEscape()
          const returned = await pumpUntilFrame(setup, (frame) => !frame.includes("PASS cwd"))
          if (entry.name.startsWith("failed/") || entry.name.startsWith("cancelled/")) {
            expect(returned).toContain("Enter retry")
          }
        } finally {
          setup.renderer.destroy()
        }
      }
    },
    120_000,
  )

  test("Doctor preserves mounted state, drafts, shell context, and file authorities", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-doctor-state-"))
    const stateDir = join(root, "state")
    const pointer = join(stateDir, "session.json")
    const priorStateDir = process.env.SHELLQ_STATE_DIR
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(stateDir, { recursive: true })
      process.env.SHELLQ_STATE_DIR = stateDir
      writeFileSync(pointer, "pointer stays byte-for-byte", { mode: 0o600 })
      const settings = inferenceSettingsFile()
      writeFileSync(
        settings,
        JSON.stringify({
          version: 2,
          provider: "configured",
          providers: { configured: { model: "gpt-5.3-codex-spark", reasoning: "low" } },
        }),
        { mode: 0o600 },
      )
      const session = fixtureSession({
        initial_intent: "ask",
        provider: FAKE_PROVIDER,
        context: {
          text: "shell buffer authority",
          source: "herdr",
          label: "matched command",
          correlated: true,
          included: false,
        },
      })
      session.requests.generate.input.command = "echo other draft"
      session.requests.correct!.input.command = "fix other draft"
      const sessionBaseline = structuredClone(session)
      setup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        initialAskChatSaved: true,
        session,
        width: 80,
      })
      await setup.mockInput.typeText("preserve conversation")
      setup.mockInput.pressEnter()
      const beforeDoctor = await pumpUntilFrame(setup, (frame) => frame.includes("fixture answer"))
      for (let index = 0; index < "preserve conversation".length; index += 1) {
        setup.mockInput.pressBackspace()
      }
      setup.mockInput.typeText("preserve follow-up")
      writeFileSync(setup.resultPath, "result authority", { mode: 0o600 })
      const fileBaseline = [pointer, settings, setup.resultPath].map((path) => ({
        path,
        bytes: readFileSync(path),
        mtimeMs: statSync(path).mtimeMs,
      }))
      await openDoctorViaAction(setup)
      expect(setup.active.process).toBeNull()
      expect(session.context).toEqual(sessionBaseline.context)
      expect(session.last_command).toEqual(sessionBaseline.last_command)
      expect(session.requests.generate.input.command).toBe("echo other draft")
      expect(session.requests.correct!.input.command).toBe("fix other draft")
      expect(fileBaseline.map(({ path, bytes }) => [path, readFileSync(path)])).toEqual(
        fileBaseline.map(({ path, bytes }) => [path, bytes]),
      )
      expect(fileBaseline.map(({ path, mtimeMs }) => [path, statSync(path).mtimeMs])).toEqual(
        fileBaseline.map(({ path, mtimeMs }) => [path, mtimeMs]),
      )

      setup.mockInput.pressEscape()
      const afterDoctor = await pumpUntilFrame(setup, (frame) => !frame.includes("PASS cwd"))
      expect(afterDoctor).toContain("fixture answer")
      expect(afterDoctor).toContain("preserve follow-up")
      expect(afterDoctor).not.toContain("Enter insert")
      expect(beforeDoctor).toContain("fixture answer")

      setup.mockInput.pressTab()
      const command = await pumpUntilFrame(setup, (frame) => frame.includes("[Command]"))
      expect(command).toContain("echo other draft")
      setup.mockInput.pressTab()
      const fix = await pumpUntilFrame(setup, (frame) => frame.includes("[Fix]"))
      expect(fix).toContain("fix other draft")
    } finally {
      setup?.renderer.destroy()
      if (priorStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = priorStateDir
      rmSync(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("Doctor does not add App Server turns or replace prepared/preparing identities", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-doctor-app-server-"))
    const bin = join(root, "bin")
    const workdir = join(root, "repo")
    const pointer = join(root, "state", "app-server.json")
    const log = join(root, "events.log")
    const oldPath = process.env.PATH
    const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
    const oldLog = process.env.FAKE_LOG
    const oldDelay = process.env.FAKE_READY_DELAY_MS
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(bin, { recursive: true })
      mkdirSync(workdir, { recursive: true })
      writeFileSync(log, "")
      const fake = join(bin, "codex")
      writeFileSync(fake, REUSE_UI_FAKE)
      chmodSync(fake, 0o700)
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.SHELLQ_APP_SERVER_REUSE = "1"
      process.env.FAKE_LOG = log
      process.env.FAKE_READY_DELAY_MS = "300"
      setup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          initial_intent: "ask",
          provider: [BUNDLED_CODEX_PROVIDER],
        }),
        trustedWorkdir: workdir,
        width: 80,
      })
      await pumpUntilFrame(setup, () => readFileSync(log, "utf8").includes("thread/start"))
      const preparing = setup.active.preparing
      const preparingSession = setup.active.session
      const baselineEvents = readFileSync(log, "utf8").trim().split("\n")
      expect(preparing).toBeInstanceOf(Promise)
      expect(preparingSession).toBeDefined()

      await openDoctorViaAction(setup)
      expect(setup.active.preparing).toBe(preparing)
      expect(setup.active.session).toBe(preparingSession)
      expect(readFileSync(log, "utf8").trim().split("\n").slice(baselineEvents.length)).not.toContain("turn/start")

      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => !frame.includes("PASS cwd"))
      await pumpUntilFrame(setup, () => setup!.active.preparing === null)
      const preparedSession = setup.active.session
      const preparedEvents = readFileSync(log, "utf8").trim().split("\n")
      expect(preparedSession).toBe(preparingSession)

      await openDoctorViaAction(setup)
      expect(setup.active.preparing).toBeNull()
      expect(setup.active.session).toBe(preparedSession)
      expect(readFileSync(log, "utf8").trim().split("\n").slice(preparedEvents.length)).not.toContain("turn/start")
    } finally {
      await setup?.active.session?.dispose()
      setup?.renderer.destroy()
      process.env.PATH = oldPath
      if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
      else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
      if (oldLog === undefined) delete process.env.FAKE_LOG
      else process.env.FAKE_LOG = oldLog
      if (oldDelay === undefined) delete process.env.FAKE_READY_DELAY_MS
      else process.env.FAKE_READY_DELAY_MS = oldDelay
      rmSync(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("Setup dismissal waits for delayed App Server retirement and prepares once", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-setup-retirement-test-"))
    const bin = join(root, "bin")
    const workdir = join(root, "repo")
    const pointer = join(root, "state", "app-server.json")
    const log = join(root, "events.log")
    const oldPath = process.env.PATH
    const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
    const oldLog = process.env.FAKE_LOG
    let release!: () => void
    const closing = new Promise<void>((resolve) => {
      release = resolve
    })
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(bin, { recursive: true })
      mkdirSync(workdir, { recursive: true })
      writeFileSync(log, "")
      const fake = join(bin, "codex")
      writeFileSync(fake, REUSE_UI_FAKE)
      chmodSync(fake, 0o700)
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.SHELLQ_APP_SERVER_REUSE = "1"
      process.env.FAKE_LOG = log
      setup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          initial_intent: "ask",
          models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
          provider: [BUNDLED_CODEX_PROVIDER],
        }),
        trustedWorkdir: workdir,
        width: 80,
      })
      await pumpUntilFrame(setup, () => readFileSync(log, "utf8").includes("thread/start"))
      await pumpUntilFrame(setup, () => setup!.active.preparing === null)
      setup.active.closing = closing
      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("p")
      await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
      setup.mockInput.pressArrow("down")
      await pumpUntilFrame(setup, (frame) => frame.includes("› Model"))
      setup.mockInput.pressArrow("right")
      await pumpUntilFrame(setup, (frame) => frame.includes("[Luna]"))
      setup.mockInput.pressEscape()
      setup.mockInput.pressEscape()
      await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
      expect(setup.active.session).toBeNull()
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length).toBe(1)

      release()
      await pumpUntilFrame(
        setup,
        (frame) => !frame.includes("Provider Setup") &&
          (readFileSync(log, "utf8").match(/thread\/start/g)?.length ?? 0) === 2,
      )
      expect(readFileSync(log, "utf8").match(/thread\/start/g)?.length).toBe(2)
    } finally {
      await setup?.active.session?.dispose()
      setup?.renderer.destroy()
      process.env.PATH = oldPath
      if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
      else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
      if (oldLog === undefined) delete process.env.FAKE_LOG
      else process.env.FAKE_LOG = oldLog
      rmSync(root, { force: true, recursive: true })
    }
  }, 30_000)

  test("opens Doctor locally from Ctrl-X D and leaves /doctor on the provider path", async () => {
    const exact = await mountWorkbench({
      height: 8,
      session: fixtureSession({ initial_intent: "ask" }),
      width: 80,
    })
    try {
      const frame = await openDoctorViaAction(exact)
      expect(frame).toContain("WARN provider")
      expect(frame).toContain("PASS settings")
      expect(exact.active.process).toBeNull()
      exact.mockInput.pressKey("x", { ctrl: true })
      exact.mockInput.pressKey("a")
      await exact.renderOnce()
      expect(exact.captureCharFrame()).toContain("PASS cwd")
      exact.mockInput.pressKey("x", { ctrl: true })
      exact.mockInput.pressKey("d")
      await pumpUntilFrame(exact, current => !current.includes("PASS cwd"))

      await openDoctorViaAction(exact)
      exact.mockInput.pressKey("x", { ctrl: true })
      exact.mockInput.pressEscape()
      await pumpUntilFrame(exact, current => !current.includes("PASS cwd"))

      exact.mockInput.pressKey("x", { ctrl: true })
      await pumpUntilFrame(exact, current => current.includes("D doctor"))
      const doctorCell = actionsSheetLines(
        {
          canRequestAlternative: false,
          doctorAvailable: true,
          editing: false,
          editorMode: "composer",
          hasCandidateList: false,
          hasEngine: false,
          includeContext: false,
          intent: "ask",
          model: "gpt-5.3-codex-spark",
          providerAvailable: true,
          reasoning: "low",
        },
        frameLayout(80).interior,
        true,
      ).rows[0].cells[0]
      await exact.mockMouse.click(
        INTERIOR_ORIGIN_X + doctorCell.start,
        footerRenderOffset(exact.renderer) + 1,
        MouseButtons.LEFT,
      )
      await pumpUntilFrame(exact, current => current.includes("PASS cwd"))
      exact.mockInput.pressEscape()
    } finally {
      exact.renderer.destroy()
    }

    const slashText = await mountWorkbench({ height: 8, width: 80 })
    try {
      slashText.mockInput.typeText("/doctor")
      slashText.mockInput.pressEnter()
      await pumpUntilFrame(slashText, current => current.includes("echo candidate-0"))
    } finally {
      slashText.renderer.destroy()
    }
  }, 20_000)

  test(
    "keeps Doctor modal across one-drain input and a late composer callback",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-doctor-race-"))
      const requestLog = join(root, "provider-requested")
      const setup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          initial_intent: "ask",
          provider: [
            "bun",
            "-e",
            `await Bun.stdin.text(); await Bun.write(${JSON.stringify(requestLog)}, "called")`,
          ],
        }),
        trustedWorkdir: root,
        width: 80,
      })
      try {
        const lateCallback = findComposerContentChange(setup.renderer.root)
        expect(lateCallback).toBeFunction()

        await setup.mockInput.pressKeys(["\u0018d\u0018a"])
        const doctor = await pumpUntilFrame(
          setup,
          (frame) => frame.includes("PASS cwd") && frame.includes("Ask pointer"),
        )
        lateCallback!({})
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toBe(doctor)
        expect(setup.active.process).toBeNull()
        expect(existsSync(requestLog)).toBe(false)

        setup.mockInput.pressEscape()
        const blank = await pumpUntilFrame(
          setup,
          (frame) => !frame.includes("PASS cwd") && frame.includes("Ask about"),
        )
        expect(setup.active.process).toBeNull()
        expect(existsSync(requestLog)).toBe(false)
      } finally {
        setup.renderer.destroy()
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test(
    "keeps Doctor input classes inert until the real Esc back span is used",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-doctor-inert-"))
      const requestLog = join(root, "provider-requested")
      const pointer = join(root, "pointer.json")
      const priorStateDir = process.env.SHELLQ_STATE_DIR
      process.env.SHELLQ_STATE_DIR = root
      let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
      try {
        const mounted = await mountWorkbench({
          height: 12,
          session: fixtureSession({
            initial_intent: "ask",
            context: {
              text: "retained context",
              source: "tmux",
              label: "recent pane only",
              correlated: false,
              included: false,
            },
            provider: [
              "bun",
              "-e",
              `await Bun.stdin.text(); await Bun.write(${JSON.stringify(requestLog)}, "called")`,
            ],
          }),
          trustedWorkdir: root,
          width: 80,
        })
        setup = mounted
        const initial = await openDoctorViaAction(mounted)
        const title = topRail(
          { intent: "ask", model: "gpt-5.3-codex-spark", provider: "custom", reasoning: "low" },
          frameLayout(80).titleBudget,
          true,
        ).spans
        const footer = bottomRail(
          {
            action: "Esc back",
            contextBytes: "retained context".length,
            cwd: root,
            included: false,
            message: null,
          },
          frameLayout(80).titleBudget,
          true,
        ).spans
        const routes: Array<() => Promise<void> | void> = [
          () => mounted.mockInput.pressEnter(),
          () => mounted.mockInput.pressEnter({ shift: true }),
          () => mounted.mockInput.pressTab(),
          () => mounted.mockMouse.click(TITLE_ORIGIN_X + title.mode.generate.start, 0, MouseButtons.LEFT),
          () => mounted.mockMouse.click(TITLE_ORIGIN_X + title.provider!.start, 0, MouseButtons.LEFT),
          () => mounted.mockMouse.click(TITLE_ORIGIN_X + title.model!.start, 0, MouseButtons.LEFT),
          () => mounted.mockMouse.click(TITLE_ORIGIN_X + title.reasoning!.start, 0, MouseButtons.LEFT),
          () => mounted.mockMouse.click(INTERIOR_ORIGIN_X + 4, footerRenderOffset(mounted.renderer) + 2, MouseButtons.LEFT),
          () => mounted.mockMouse.scroll(INTERIOR_ORIGIN_X + 4, footerRenderOffset(mounted.renderer) + 2, "down"),
          () => mounted.mockMouse.click(TITLE_ORIGIN_X + footer.ctrlX!.start, footerRenderOffset(mounted.renderer) + mounted.renderer.footerHeight - 1, MouseButtons.LEFT),
          () => mounted.mockMouse.click(TITLE_ORIGIN_X + footer.disclosure!.start, footerRenderOffset(mounted.renderer) + mounted.renderer.footerHeight - 1, MouseButtons.LEFT),
          () => {
            mounted.mockInput.pressKey("x", { ctrl: true })
            mounted.mockInput.pressKey("m")
          },
          () => {
            mounted.mockInput.pressKey("x", { ctrl: true })
            mounted.mockInput.pressKey("e")
          },
          () => {
            mounted.mockInput.pressKey("x", { ctrl: true })
            mounted.mockInput.pressKey("n")
          },
          () => {
            mounted.mockInput.pressKey("x", { ctrl: true })
            mounted.mockInput.pressKey("a")
          },
        ]
        for (const route of routes) {
          await route()
          await mounted.renderOnce()
          expect(mounted.captureCharFrame()).toBe(initial)
          expect(mounted.active.process).toBeNull()
          expect(existsSync(requestLog)).toBe(false)
        }

        await mounted.mockMouse.click(
          TITLE_ORIGIN_X + footer.action!.start,
          footerRenderOffset(mounted.renderer) + mounted.renderer.footerHeight - 1,
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(mounted, (frame) => !frame.includes("PASS cwd"))
        expect(mounted.captureCharFrame()).toContain("Ask about")
        expect(mounted.active.process).toBeNull()
        expect(existsSync(pointer)).toBe(false)
        expect(existsSync(mounted.resultPath)).toBe(false)
        expect(existsSync(inferenceSettingsFile({ SHELLQ_STATE_DIR: root }))).toBe(false)
      } finally {
        setup?.renderer.destroy()
        if (priorStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
        else process.env.SHELLQ_STATE_DIR = priorStateDir
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test("waits for prior App Server cleanup before spawning another provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-provider-handoff-test-"))
    const marker = join(root, "started")
    let release!: () => void
    const closing = new Promise<void>((resolve) => {
      release = resolve
    })
    const testSetup = await mountWorkbench({
      height: 8,
      session: fixtureSession({
        provider: [
          "bun",
          "-e",
          `import { appendFileSync } from "node:fs";
           appendFileSync(${JSON.stringify(marker)}, "started\\n");
           await Bun.stdin.text();
           console.log(JSON.stringify({
             tldr: "fixture suggestion",
             corrected_command: "echo handed-off",
             confidence: 0.8,
             risk: "low",
           }));`,
        ],
      }),
      width: 80,
    })
    try {
      testSetup.active.closing = closing
      testSetup.mockInput.typeText("echo wait")
      testSetup.mockInput.pressEnter()
      await testSetup.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(existsSync(marker)).toBe(false)
      release()
      await pumpUntilFrame(testSetup, (frame) => frame.includes("echo handed-off"))
      expect(existsSync(marker)).toBe(true)

      let cancelRelease!: () => void
      testSetup.active.closing = new Promise<void>((resolve) => {
        cancelRelease = resolve
      })
      testSetup.mockInput.pressKey("x", { ctrl: true })
      await pumpUntilFrame(testSetup, (frame) => frame.includes("only A sends"))
      testSetup.mockInput.pressKey("a")
      await pumpUntilFrame(testSetup, (frame) => frame.includes("Esc cancel"))
      testSetup.mockInput.pressEscape()
      await pumpUntilFrame(testSetup, (frame) => frame.includes("cancelling the request"))
      cancelRelease()
      for (let pass = 0; pass < 10; pass += 1) {
        await testSetup.renderOnce()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1)
    } finally {
      release()
      testSetup.renderer.destroy()
      rmSync(root, { force: true, recursive: true })
    }
  })

  test(
    "prepares on mount and keeps one App Server session across mode switches",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-reuse-ui-test-"))
      const bin = join(root, "bin")
      const workdir = join(root, "repo")
      const pointer = join(root, "state", "app-server.json")
      const log = join(root, "events.log")
      const oldPath = process.env.PATH
      const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
      const oldLog = process.env.FAKE_LOG
      const oldReadyDelay = process.env.FAKE_READY_DELAY_MS
      const oldFailReadyOnce = process.env.FAKE_FAIL_READY_ONCE
      let testSetup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
      try {
        mkdirSync(bin, { recursive: true })
        mkdirSync(workdir, { recursive: true })
        writeFileSync(log, "")
        const fake = join(bin, "codex")
        writeFileSync(fake, REUSE_UI_FAKE)
        chmodSync(fake, 0o700)
        process.env.PATH = `${bin}:${oldPath ?? ""}`
        process.env.SHELLQ_APP_SERVER_REUSE = "1"
        process.env.FAKE_LOG = log
        process.env.FAKE_READY_DELAY_MS = "300"
        testSetup = await mountWorkbench({
          askSessionFile: pointer,
          height: 8,
          session: fixtureSession({
            codex_ask_engine: "app-server",
            initial_intent: "ask",
            model: "gpt-5.6-luna",
            models: ["gpt-5.6-luna"],
            provider: [BUNDLED_CODEX_PROVIDER],
            reasoning_levels: ["low"],
          }),
          trustedWorkdir: workdir,
          width: 80,
        })
        await pumpUntilFrame(
          testSetup,
          () => readFileSync(log, "utf8").includes("thread/start"),
        )
        const pid = testSetup.active.session?.pid
        expect(pid).toBeNumber()
        expect(testSetup.active.preparing).toBeInstanceOf(Promise)
        expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
          "initialize",
          "thread/start",
        ])
        expect(existsSync(pointer)).toBe(false)
        testSetup.mockInput.typeText("first")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("warm-answer-1") && existsSync(pointer),
        )
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
        testSetup.mockInput.pressArrow("right")
        testSetup.mockInput.pressArrow("down")
        testSetup.mockInput.pressArrow("right")
        await testSetup.renderOnce()
        expect(testSetup.active.session?.pid).toBe(pid)
        await closePalette(testSetup)
        await pumpUntilFrame(testSetup, (frame) => !frame.includes("Search Models:"))
        testSetup.mockInput.typeText("second")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("warm-answer-2"))
        expect(testSetup.active.session?.pid).toBe(pid)
        expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
          "initialize",
          "thread/start",
          "turn/start",
          "thread/read",
          "initialize",
          "turn/start",
          "thread/read",
        ])
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("nothing sends"))
        testSetup.mockInput.pressKey("n")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("new chat ready"))
        testSetup.mockInput.typeText("unused")
        await pumpUntilFrame(
          testSetup,
          () => readFileSync(log, "utf8").trim().split("\n").filter(
            (line) => line === "thread/start",
          ).length === 2,
        )
        const firstNewPid = testSetup.active.session?.pid
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("nothing sends"))
        testSetup.mockInput.pressKey("n")
        await pumpUntilFrame(
          testSetup,
          () => readFileSync(log, "utf8").trim().split("\n").filter(
            (line) => line === "thread/start",
          ).length === 3,
        )
        const newPid = testSetup.active.session?.pid
        expect(newPid).not.toBe(firstNewPid)
        testSetup.mockInput.typeText(" malformed ask")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("provider failed"))
        expect(testSetup.active.session?.pid).toBe(newPid)
        expect(readdirSync(root).some((name) => name.startsWith("app-server.json.pending-"))).toBe(false)
        testSetup.mockInput.typeText(" retry")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("warm-answer-2") && existsSync(pointer),
        )
        expect(testSetup.active.session?.pid).toBe(newPid)
        expect(existsSync(pointer)).toBe(true)
        const commandX =
          TITLE_ORIGIN_X +
          modeTabs("ask", frameLayout(80).titleBudget, true).spans.generate.start
        await testSetup.mockMouse.click(commandX, footerRenderOffset(testSetup.renderer), MouseButtons.LEFT)
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Command]"))
        expect(testSetup.active.session?.pid).toBe(newPid)
        testSetup.mockInput.typeText("malformed")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("provider returned a mal"))
        expect(testSetup.active.session?.pid).toBe(newPid)
        testSetup.mockInput.typeText(" show files")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  echo app-server"))
        expect(testSetup.active.session?.pid).toBe(newPid)
      } finally {
        await testSetup?.active.session?.dispose()
        testSetup?.renderer.destroy()
        process.env.PATH = oldPath
        if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
        else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
        if (oldLog === undefined) delete process.env.FAKE_LOG
        else process.env.FAKE_LOG = oldLog
        if (oldReadyDelay === undefined) delete process.env.FAKE_READY_DELAY_MS
        else process.env.FAKE_READY_DELAY_MS = oldReadyDelay
        if (oldFailReadyOnce === undefined) delete process.env.FAKE_FAIL_READY_ONCE
        else process.env.FAKE_FAIL_READY_ONCE = oldFailReadyOnce
        rmSync(root, { force: true, recursive: true })
      }
    },
    10_000,
  )

  test(
    "shows fixed recovery copy when pointer staging hits a filesystem error",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-stage-failure-ui-test-"))
      const bin = join(root, "bin")
      const workdir = join(root, "repo")
      const state = join(root, "state")
      const pointer = join(state, "app-server.json")
      const log = join(root, "events.log")
      const oldPath = process.env.PATH
      const oldLog = process.env.FAKE_LOG
      const oldTurnDelay = process.env.FAKE_TURN_DELAY_MS
      let testSetup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
      try {
        mkdirSync(bin, { recursive: true })
        mkdirSync(workdir, { recursive: true })
        writeFileSync(log, "")
        const fake = join(bin, "codex")
        writeFileSync(fake, REUSE_UI_FAKE)
        chmodSync(fake, 0o700)
        process.env.PATH = `${bin}:${oldPath ?? ""}`
        process.env.FAKE_LOG = log
        process.env.FAKE_TURN_DELAY_MS = "200"
        testSetup = await mountWorkbench({
          askSessionFile: pointer,
          height: 8,
          session: fixtureSession({
            codex_ask_engine: "app-server",
            initial_intent: "ask",
            provider: [BUNDLED_CODEX_PROVIDER],
          }),
          trustedWorkdir: workdir,
          width: 100,
        })
        testSetup.mockInput.typeText("stage failure")
        await pumpUntilFrame(
          testSetup,
          () => readFileSync(log, "utf8").includes("thread/start"),
        )
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(
          testSetup,
          () => readFileSync(log, "utf8").includes("turn/start"),
        )
        writeFileSync(state, "not a directory")
        const frame = await pumpUntilFrame(
          testSetup,
          (value) => value.includes("App Server stopped safely"),
        )
        expect(frame).not.toContain(root)
        expect(existsSync(pointer)).toBe(false)
      } finally {
        await testSetup?.active.closing
        await testSetup?.active.session?.dispose()
        testSetup?.renderer.destroy()
        process.env.PATH = oldPath
        if (oldLog === undefined) delete process.env.FAKE_LOG
        else process.env.FAKE_LOG = oldLog
        if (oldTurnDelay === undefined) delete process.env.FAKE_TURN_DELAY_MS
        else process.env.FAKE_TURN_DELAY_MS = oldTurnDelay
        rmSync(root, { force: true, recursive: true })
      }
    },
    10_000,
  )

  test(
    "shows bundled Ask preview before accepting the final and staged pointer",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-stream-ui-test-"))
      const bin = join(root, "bin")
      const workdir = join(root, "repo")
      const pointer = join(root, "state", "session.json")
      const oldPath = process.env.PATH
      let testSetup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
      try {
        mkdirSync(bin, { recursive: true })
        mkdirSync(workdir, { recursive: true })
        const fakeCodex = join(bin, "codex")
        writeFileSync(
          fakeCodex,
          `#!/usr/bin/env zsh
typeset output=''
typeset -i index=1
typeset count_file="\${0}.count"
typeset -i count=1
[[ -e $count_file ]] && count=$(( $(<$count_file) + 1 ))
print -r -- $count >$count_file
while (( index <= $# )); do
  if [[ \${argv[index]} == -o ]]; then
    output=\${argv[index + 1]}
    break
  fi
  (( ++index ))
done
if (( count == 2 )); then
  [[ " $* " == *" exec resume "* ]] || exit 81
  [[ " $* " == *" 0198f3c2-9999-7999-8999-999999999999 "* ]] || exit 82
  typeset prompt=\${argv[-1]}
  typeset request_file=\${prompt#Read }
  request_file=\${request_file%% and return*}
  jq -e '.input.query == "follow up" and (has("conversation") | not) and (.input | has("turns") | not)' "$request_file" >/dev/null || exit 83
fi
print -r -- '{"type":"thread.started","thread_id":"0198f3c2-9999-7999-8999-999999999999"}'
print -r -- '{"type":"item.completed","item":{"type":"agent_message","text":"Preview arrived safely."}}'
print -r -- '{"type":"item.started","item":{"type":"command_execution","command":"SECRET-UI-CANARY"}}'
print -r -- '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"answer\\":\\"SECRET-FINAL-CANARY\\"}"}}'
sleep 0.5
if (( count == 1 )); then
  print -rn -- '{"answer":"authoritative answer"}' >"$output"
else
  print -rn -- '{"answer":"continued answer"}' >"$output"
fi
`,
        )
        chmodSync(fakeCodex, 0o700)
        process.env.PATH = `${bin}:${oldPath ?? ""}`

        testSetup = await mountWorkbench({
          askSessionFile: pointer,
          height: 9,
          session: fixtureSession({
            initial_intent: "ask",
            provider: [BUNDLED_CODEX_PROVIDER],
          }),
          trustedWorkdir: workdir,
          width: 80,
        })
        testSetup.mockInput.typeText("inspect safely")
        testSetup.mockInput.pressEnter()

        const preview = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("Preview arrived safely."),
        )
        expect(preview).not.toContain('{"t"')
        expect(preview).not.toContain("SECRET-UI-CANARY")
        expect(preview).not.toContain("SECRET-FINAL-CANARY")
        expect(testSetup.renderer.footerHeight).toBe(8)
        expect(existsSync(pointer)).toBe(false)
        expect(existsSync(`${pointer}.pending`)).toBe(false)

        const final = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("authoritative answer") &&
            frame.includes("Ask a follow-up"),
          { tries: 80, delayMs: 20 },
        )
        expect(final).not.toContain("Preview arrived safely.")
        expect(JSON.parse(readFileSync(pointer, "utf8"))).toEqual({
          cwd: workdir,
          provider: "codex",
          session_id: "0198f3c2-9999-7999-8999-999999999999",
        })
        expect(existsSync(`${pointer}.pending`)).toBe(false)

        await testSetup.mockInput.typeText("follow up")
        testSetup.mockInput.pressEnter()
        const continued = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("continued answer"),
          { tries: 80, delayMs: 20 },
        )
        expect(continued).toContain("You: follow up")
        expect(JSON.parse(readFileSync(pointer, "utf8")).session_id).toBe(
          "0198f3c2-9999-7999-8999-999999999999",
        )
        expect(readFileSync(`${fakeCodex}.count`, "utf8").trim()).toBe("2")
      } finally {
        testSetup?.renderer.destroy()
        process.env.PATH = oldPath
        rmSync(root, { force: true, recursive: true })
      }
    },
    10_000,
  )

  test(
    "clips a long Ask preview above the composer and keeps its tail visible",
    async () => {
      const testSetup = await mountWorkbench({
        height: 9,
        session: fixtureSession({
          initial_intent: "ask",
          provider: STREAM_OUTCOME_PROVIDER,
        }),
        width: 80,
      })
      try {
        testSetup.mockInput.typeText("overflow")
        testSetup.mockInput.pressEnter()
        const preview = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("PREVIEW_TAIL"),
        )
        const lines = preview.trimEnd().split("\n")

        expect(lines).toHaveLength(8)
        expect(preview).toContain("You: overflow")
        expect(preview).not.toContain("PREVIEW_HEAD")
        // In flight there is no composer row: the preview tail owns the bottom interior row.
        expect(lines.at(-2)).toContain("PREVIEW_TAIL")
        expect(preview).toContain("Answer · streaming")
        expect(lines.at(-1)).toContain("Answering")
        expect(lines.at(-1)).toContain("Esc cancel")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "promotes the first loading request with question identity and status",
    async () => {
      for (const question of ["one line", "first line\nsecond line"]) {
        const testSetup = await mountWorkbench({
          height: 8,
          kittyKeyboard: true,
          session: fixtureSession({
            initial_intent: "ask",
            provider: SLOW_ASK_PROVIDER,
          }),
          width: 80,
        })
        try {
          const [first, second] = question.split("\n")
          await testSetup.mockInput.typeText(first)
          if (second) {
            testSetup.mockInput.pressEnter({ shift: true })
            await testSetup.mockInput.typeText(second)
          }
          testSetup.mockInput.pressEnter()
          const loading = await pumpUntilFrame(
            testSetup,
            (frame) =>
              frame.includes(`You: ${question.replace("\n", " ")}`) &&
              frame.includes("asking"),
          )
          expect(loading).toContain("Esc cancel")
          expect(loading).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u)
          expect(testSetup.renderer.footerHeight).toBe(4)
          await pumpUntilFrame(testSetup, (frame) => frame.includes("slow answer"))
        } finally {
          testSetup.renderer.destroy()
        }
      }
    },
    10_000,
  )

  test(
    "keeps Ask question identity out of Command loading",
    async () => {
      const testSetup = await mountWorkbench({
        height: 8,
        kittyKeyboard: true,
        session: fixtureSession({ provider: SLOW_PROVIDER }),
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("echo first")
        testSetup.mockInput.pressEnter({ shift: true })
        await testSetup.mockInput.typeText("echo second")
        testSetup.mockInput.pressEnter()
        const loading = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Esc cancel"),
        )

        expect(loading).toContain("[Command]")
        expect(loading).not.toContain("You: ")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "folds a multiline in-flight Ask question into its bounded header",
    async () => {
      const testSetup = await mountWorkbench({
        height: 8,
        kittyKeyboard: true,
        session: fixtureSession({
          initial_intent: "ask",
          provider: STREAM_OUTCOME_PROVIDER,
        }),
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("first line")
        testSetup.mockInput.pressEnter({ shift: true })
        await testSetup.mockInput.typeText("second line")
        testSetup.mockInput.pressEnter()
        const preview = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("request-local preview"),
        )
        expect(preview).toContain("You: first line second line")
        expect(preview).not.toContain("You: first line\nsecond line")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "restores the prior Ask answer after a streamed provider failure",
    async () => {
      const testSetup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          initial_intent: "ask",
          provider: STREAM_OUTCOME_PROVIDER,
        }),
        width: 80,
      })
      try {
        testSetup.mockInput.typeText("first")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("previous answer"))

        testSetup.mockInput.typeText("fail")
        testSetup.mockInput.pressEnter()
        const preview = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("request-local preview"),
        )
        expect(preview).not.toContain("previous answer")

        const failed = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("previous answer") && frame.includes("provider exited 9"),
        )
        expect(failed).not.toContain("request-local preview")
        expect(failed).not.toContain("late answer")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "keeps a chronological Ask conversation with inert scrolling and remounts",
    async () => {
      const testSetup = await mountWorkbench({
        height: 9,
        session: fixtureSession({
          initial_intent: "ask",
          provider: MULTI_TURN_PROVIDER,
        }),
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("first question")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("You: first question") && frame.includes("Ask a follow-up"),
        )

        await testSetup.mockInput.typeText("second question")
        testSetup.mockInput.pressEnter()
        const newest = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("You: second question") &&
            frame.includes("second question answer 4") &&
            frame.includes("Ask a follow-up"),
        )
        expect(newest).not.toContain("You: first question")
        expect(newest).toContain("Ask a follow-up")
        expect(testSetup.renderer.footerHeight).toBe(8)

        testSetup.mockInput.pressKey("\u001b[5~")
        testSetup.mockInput.pressKey("\u001b[5~")
        const older = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("You: first question"),
        )
        expect(older).toContain("You: first question")
        expect(older).not.toContain("second question answer 2")

        await testSetup.mockInput.typeText("draft survives")
        testSetup.mockInput.pressArrow("up")
        const nativeArrow = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("draft survives"),
        )
        expect(nativeArrow).toContain("You: first question")
        for (let page = 0; page < 3; page += 1) {
          testSetup.mockInput.pressKey("\u001b[6~")
        }
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("draft survives") &&
          frame.includes("You: second question") &&
          !frame.includes("You: first question"),
        )

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("h")
        await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("Ask chat") && frame.includes("one-shot provider"),
        )
        testSetup.mockInput.pressEscape()
        const remounted = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("You: second question") &&
            frame.includes("draft survives"),
        )
        expect(remounted).not.toContain("You: first question")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
        await closePalette(testSetup)
        await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("You: second question") && frame.includes("draft survives"),
        )

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("e")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("draft survives"))
        testSetup.mockInput.pressEscape()
        const edited = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("You: second question") && frame.includes("draft survives"),
        )
        expect(edited).not.toContain("You: first question")
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "treats an identical post-answer paste as a real non-empty draft",
    async () => {
      const testSetup = await mountWorkbench({
        height: 9,
        session: fixtureSession({
          initial_intent: "ask",
          provider: MULTI_TURN_PROVIDER,
        }),
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("same question")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("You: same question") && frame.includes("Ask a follow-up"),
        )
        await testSetup.mockInput.pasteBracketedText("same question")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("same question"))
        testSetup.mockInput.pressArrow("down")
        const afterArrow = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("You: same question"),
        )
        expect(afterArrow).toContain("same question answer 1")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "routes a native draft before React state catches up",
    async () => {
      const testSetup = await mountWorkbench({
        height: 9,
        session: fixtureSession({
          initial_intent: "ask",
          provider: MULTI_TURN_PROVIDER,
        }),
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("first question")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("first question answer 4"),
        )

        await testSetup.mockInput.typeText("second question")
        testSetup.mockInput.pressEnter()
        const newest = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("You: second question") &&
            frame.includes("second question answer 4"),
        )
        const bandTop = newest
          .split("\n")
          .findIndex((line) => line.includes("You: second question"))
        expect(bandTop).toBeGreaterThanOrEqual(0)
        const topLine = (frame: string) => frame.split("\n")[bandTop]?.trim()
        const newestTop = topLine(newest)

        testSetup.mockInput.pressArrow("up")
        await pumpUntilFrame(
          testSetup,
          (frame) => topLine(frame) !== newestTop,
        )
        testSetup.mockInput.pressArrow("down")
        await pumpUntilFrame(testSetup, (frame) => topLine(frame) === newestTop)

        const draftPrefix = "burst-draft-zeta"
        void testSetup.mockInput.typeText(draftPrefix)
        testSetup.mockInput.pressArrow("up")
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes(draftPrefix),
        )
        await testSetup.flush()
        const afterArrow = testSetup.captureCharFrame()
        const arrowKeptConversation = topLine(afterArrow) === newestTop

        if (!arrowKeptConversation) {
          testSetup.mockInput.pressKey("\u001b[6~")
          await pumpUntilFrame(testSetup, (frame) => topLine(frame) === newestTop)
        }

        const draftSuffix = "-ctrlx-tail"
        void testSetup.mockInput.typeText(draftSuffix)
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("e")
        const editor = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("^X W save"),
        )

        expect({
          arrowKeptConversation,
          editorKeptNativeSuffix: editor.includes(`${draftPrefix}${draftSuffix}`),
        }).toEqual({
          arrowKeptConversation: true,
          editorKeptNativeSuffix: true,
        })
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "cancellation wins over a late streamed final and restores the prior answer",
    async () => {
      const testSetup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          initial_intent: "ask",
          provider: STREAM_OUTCOME_PROVIDER,
        }),
        width: 80,
      })
      try {
        testSetup.mockInput.typeText("first")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("previous answer"))

        testSetup.mockInput.typeText("cancel")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("request-local preview"),
        )
        testSetup.mockInput.pressEscape()

        const cancelled = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("previous answer") &&
            frame.includes("cancelling the"),
        )
        expect(cancelled).not.toContain("request-local preview")
        expect(cancelled).not.toContain("late answer")

        const settled = await pumpUntilFrame(
          testSetup,
          (frame) =>
            testSetup.active.process === null &&
            frame.includes("previous answer"),
          { tries: 120, delayMs: 25 },
        )
        expect(settled).not.toContain("late answer")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    10_000,
  )

  test(
    "clears the bottom rail's message when a Ctrl-X chord opens, and candidate selection retains the insertion hint",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 8 })
      const { mockInput } = testSetup

      // Selection always spells out the review-only insertion action.
      await mockInput.typeText("echo initial")
      mockInput.pressEnter()
      const first = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("echo candidate-0"),
      )
      expect(first).toContain("Enter insert (never runs)")
      expect(first).not.toContain("↵ insert")

      // Later results keep insertion explicit and show response timing.
      mockInput.pressKey("x", { ctrl: true })
      await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
      mockInput.pressKey("a")
      const second = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("echo candidate-1"),
      )
      expect(second).toContain("Enter insert (never runs)")
      expect(second).not.toContain("↵ insert")
      expect(second.trimEnd().split("\n").at(-1)).toMatch(/\d+\.\d+s/)
      expect(second.trimEnd().split("\n").at(-1)).not.toContain("~/Projects/shellq")

      // Navigating between candidates does not change the insertion contract.
      mockInput.pressArrow("up")
      const backOnFirst = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("echo candidate-0"),
      )
      expect(backOnFirst).toContain("Enter insert (never runs)")
      expect(backOnFirst).not.toContain("↵ insert")
      mockInput.pressArrow("down")
      await pumpUntilFrame(testSetup, (frame) => frame.includes("echo candidate-1"))

      // Opening the actions sheet clears any stale message rather than
      // retaining a `ctrl-x: …` chord hint — the sheet spells out every
      // letter itself (item 4 of the retired note-slot ladder).
      mockInput.pressKey("x", { ctrl: true })
      await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
      mockInput.pressKey("e")
      const editing = await pumpUntilFrame(testSetup, (frame) => frame.includes("^X W save"))
      expect(editing).not.toContain("ctrl-x:")

      mockInput.pressEscape()
      await pumpUntilFrame(testSetup, (frame) => frame.includes("edit discarded"))

      mockInput.pressKey("x", { ctrl: true })
      await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
      mockInput.pressKey("m")
      const settings = await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
      expect(settings).not.toContain("ctrl-x:")

      testSetup.renderer.destroy()
    },
    20_000,
  )

  test(
    "keeps sending Actions keyboard-only and non-sending cells clickable",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 8 })
      try {
        await testSetup.mockInput.typeText("echo initial")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("echo candidate-0"))

        testSetup.mockInput.pressKey("x", { ctrl: true })
        const actions = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Actions · S settings"),
        )
        expect(actions).toContain("another suggestion · key only")

        const renderOffset = footerRenderOffset(testSetup.renderer)
        await testSetup.mockMouse.click(
          INTERIOR_ORIGIN_X + actions.indexOf("S settings"),
          renderOffset + 1,
          MouseButtons.LEFT,
        )
        expect(testSetup.captureCharFrame()).toContain("Actions · S settings")
        await testSetup.mockMouse.click(
          INTERIOR_ORIGIN_X + 35,
          renderOffset + 5,
          MouseButtons.LEFT,
        )
        await testSetup.renderOnce()
        expect(testSetup.captureCharFrame()).toContain("Actions · S settings")
        expect(testSetup.captureCharFrame()).not.toContain("echo candidate-1")
        expect(testSetup.active.process).toBeNull()

        testSetup.mockInput.pressKey("a")
        const second = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("echo candidate-1"),
        )
        expect(second).not.toContain("echo candidate-2")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        const nextOffset = footerRenderOffset(testSetup.renderer)
        await testSetup.mockMouse.click(
          INTERIOR_ORIGIN_X + 1,
          nextOffset + 3,
          MouseButtons.LEFT,
        )
        const contextEditor = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("^X W save"),
        )
        expect(contextEditor).toContain("^X W save")
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "keeps hidden composer input inert and hides unavailable alternatives",
    async () => {
      const testSetup = await mountWorkbench({
        height: 8,
        session: fixtureSession({ provider: ECHO_COMMAND_PROVIDER }),
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("seed")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("h")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("repository"))
        await testSetup.mockInput.typeText("DETAIL_CANARY")
        testSetup.mockInput.pressEscape()
        let composer = await pumpUntilFrame(testSetup, (frame) => frame.includes("seed"))
        expect(composer).not.toContain("DETAIL_CANARY")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        const draftActions = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("Actions · S settings") && frame.includes("edit prompt"),
        )
        expect(draftActions).toContain("another suggestion")
        await testSetup.mockInput.pasteBracketedText("ACTION_CANARY")
        await closePalette(testSetup)
        composer = await pumpUntilFrame(testSetup, (frame) => frame.includes("seed"))
        expect(composer).not.toContain("ACTION_CANARY")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
        await testSetup.mockInput.pasteBracketedText("SETTINGS_CANARY")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("SETTINGS_CANARY"))
        await closePalette(testSetup)
        composer = await pumpUntilFrame(testSetup, (frame) => frame.includes("seed"))
        expect(composer).not.toContain("SETTINGS_CANARY")

        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("echo seed-0"))
        await testSetup.mockInput.typeText("CANDIDATE_CANARY")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions · S settings"))
        testSetup.mockInput.pressKey("a")
        const second = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("echo seed-1"),
        )
        expect(second).not.toContain("CANDIDATE_CANARY")
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "hides A when Command cannot start an alternative request",
    async () => {
      const testSetup = await mountWorkbench({ width: 80, height: 8 })
      try {
        testSetup.mockInput.pressKey("x", { ctrl: true })
        const actions = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("Actions · S settings") &&
            frame.includes("edit prompt"),
        )
        expect(actions).toContain("edit prompt")
        expect(actions).not.toContain("another suggestion")
        testSetup.mockInput.pressKey("a")
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("unknown ctrl-x chord"),
        )
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "uses live Ctrl-X state and disarms mixed keyboard-pointer closes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-actions-burst-test-"))
      const requestPath = join(root, "request.json")
      const provider = [
        "bun",
        "-e",
        `const req = JSON.parse(await Bun.stdin.text());
         await Bun.write(${JSON.stringify(requestPath)}, JSON.stringify(req));
         console.log(JSON.stringify({
           tldr: "captured",
           corrected_command: "echo captured",
           confidence: 0.8,
           risk: "low",
         }));`,
      ]
      const testSetup = await mountWorkbench({
        width: 80,
        height: 8,
        session: fixtureSession({ provider }),
      })
      try {
        await testSetup.mockInput.typeText("old")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("old"))

        testSetup.mockInput.pressKey("z")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("a")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("echo captured"))
        const request = JSON.parse(readFileSync(requestPath, "utf8"))
        expect(request.input.command).toBe("oldz")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("e")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("a")
        const refusedBurst = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("echo captured") &&
            frame.includes("unknown ctrl-x chord"),
        )
        expect(refusedBurst).toContain("^X W save")
        expect(testSetup.active.process).toBeNull()

        testSetup.mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("edit discarded"))

        testSetup.mockInput.pressTab()
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("a")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Fix]"))
        expect(testSetup.active.process).toBeNull()
        testSetup.mockInput.pressKey("\u001b[Z")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Command]"))

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        const ctrlXSpan = bottomRail(
          {
            action: "Esc back",
            contextBytes: 0,
            cwd: HOME_CWD,
            included: false,
            message: null,
          },
          frameLayout(80).titleBudget,
          true,
        ).spans.ctrlX
        expect(ctrlXSpan).not.toBeNull()
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + ctrlXSpan!.start,
          footerRenderOffset(testSetup.renderer) +
            testSetup.renderer.footerHeight -
            1,
          MouseButtons.LEFT,
          { delayMs: 0 },
        )
        testSetup.mockInput.pressKey("a")
        await testSetup.renderOnce()
        expect(testSetup.captureCharFrame()).not.toContain("Actions ·")
        expect(testSetup.active.process).toBeNull()

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        await testSetup.mockMouse.click(
          INTERIOR_ORIGIN_X + 1,
          footerRenderOffset(testSetup.renderer) + 3,
          MouseButtons.LEFT,
        )
        testSetup.mockInput.pressKey("a")
        const contextEdit = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("│ a") && frame.includes("^X W save"),
        )
        expect(contextEdit).toContain("│ a")
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test(
    "paints Actions above Details for keyboard and pointer opening",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 12 })
      try {
        await testSetup.mockInput.typeText("echo initial")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("echo candidate-0"))

        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("h")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Ask chat"))
        testSetup.mockInput.pressKey("x", { ctrl: true })
        const keyboardActions = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Actions · S settings"),
        )
        expect(keyboardActions).not.toContain("Ask chat")
        testSetup.mockInput.pressEscape()
        const detailsFrame = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Ask chat"),
        )
        const bottomLine = detailsFrame.trimEnd().split("\n").at(-1) ?? ""
        const ctrlXColumn = bottomLine.indexOf("^X actions")
        expect(ctrlXColumn).toBeGreaterThan(0)
        await testSetup.mockMouse.click(
          ctrlXColumn + 2,
          footerRenderOffset(testSetup.renderer) +
            testSetup.renderer.footerHeight -
            1,
          MouseButtons.LEFT,
        )
        const pointerActions = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Actions · S settings"),
        )
        expect(pointerActions).not.toContain("Ask chat")
        testSetup.mockInput.pressKey("s")
        const pointerSettings = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Search All:"),
        )
        expect(pointerSettings).toContain("Search All:")
        expect(testSetup.active.process).toBeNull()
        testSetup.mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Ask chat"))
        testSetup.mockInput.pressEscape()
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "preserves unsaved editors and rejects hidden Actions",
    async () => {
      const prompt = await mountWorkbench({ width: 80, height: 8 })
      try {
        await prompt.mockInput.typeText("keep prompt")
        prompt.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(prompt, (frame) => frame.includes("Actions ·"))
        prompt.mockInput.pressKey("e")
        await pumpUntilFrame(prompt, (frame) => frame.includes("keep prompt"))
        await prompt.mockInput.typeText(" plus")

        prompt.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(prompt, (frame) => frame.includes("Editing prompt ·"))
        prompt.mockInput.pressKey("c")
        const refusedContext = await pumpUntilFrame(
          prompt,
          (frame) =>
            frame.includes("keep prompt plus") &&
            frame.includes("save or discard"),
        )
        expect(refusedContext).toContain("keep prompt plus")

        prompt.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(prompt, (frame) => frame.includes("Editing prompt ·"))
        prompt.mockInput.pressKey("a")
        const hiddenA = await pumpUntilFrame(
          prompt,
          (frame) =>
            frame.includes("keep prompt plus") &&
            frame.includes("unknown ctrl-x chord"),
        )
        expect(hiddenA).toContain("keep prompt plus")
        expect(prompt.active.process).toBeNull()

        prompt.mockInput.pressTab()
        let refusedMode = await pumpUntilFrame(
          prompt,
          (frame) =>
            frame.includes("keep prompt plus") &&
            frame.includes("save or discard"),
        )
        expect(refusedMode).toContain("[Command]")

        prompt.mockInput.pressKey("\u001b[Z")
        refusedMode = await pumpUntilFrame(
          prompt,
          (frame) =>
            frame.includes("keep prompt plus") &&
            frame.includes("save or discard"),
        )
        expect(refusedMode).toContain("[Command]")

        const askSpan = modeTabs(
          "generate",
          frameLayout(80).titleBudget,
          true,
        ).spans.ask
        await prompt.mockMouse.click(
          TITLE_ORIGIN_X + askSpan.start,
          0,
          MouseButtons.LEFT,
        )
        refusedMode = await pumpUntilFrame(
          prompt,
          (frame) =>
            frame.includes("keep prompt plus") &&
            frame.includes("save or discard"),
        )
        expect(refusedMode).toContain("[Command]")

        prompt.mockInput.pressEscape()
        await pumpUntilFrame(prompt, (frame) => frame.includes("edit discarded"))
        prompt.mockInput.pressTab()
        await pumpUntilFrame(prompt, (frame) => frame.includes("[Fix]"))
      } finally {
        prompt.renderer.destroy()
      }

      const context = await mountWorkbench({
        width: 80,
        height: 8,
        session: fixtureSession({
          context: {
            correlated: false,
            included: false,
            label: "recent pane only",
            source: "tmux",
            text: "keep context",
          },
        }),
      })
      try {
        context.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(context, (frame) => frame.includes("Actions ·"))
        context.mockInput.pressKey("c")
        await pumpUntilFrame(context, (frame) => frame.includes("keep context"))
        await context.mockInput.typeText(" plus")
        context.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(context, (frame) => frame.includes("Editing output ·"))
        context.mockInput.pressKey("e")
        const refusedEdit = await pumpUntilFrame(
          context,
          (frame) =>
            frame.includes("keep context plus") &&
            frame.includes("save or discard"),
        )
        expect(refusedEdit).toContain("keep context plus")
      } finally {
        context.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "closes Actions with the same unknown-letter result after either opening path",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 8 })
      try {
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("z")
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("unknown ctrl-x chord"),
        )

        const span = bottomRail(
          {
            action: "",
            contextBytes: 0,
            cwd: HOME_CWD,
            included: false,
            message: null,
          },
          frameLayout(width).titleBudget,
          true,
        ).spans.ctrlX
        expect(span).not.toBeNull()
        const renderOffset = footerRenderOffset(testSetup.renderer)
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + span!.start,
          renderOffset + testSetup.renderer.footerHeight - 1,
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("z")
        const pointerUnknown = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("unknown ctrl-x chord"),
        )
        expect(pointerUnknown).not.toContain("Actions ·")
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "the bottom rail's left slot yields to a transient message and returns to cwd on the next state change",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({
        width,
        height: 8,
        session: fixtureSession({ provider: SLOW_PROVIDER }),
      })
      const { mockInput } = testSetup

      const resting = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("~/Projects/shellq"),
      )
      expect(resting).toContain("~/Projects/shellq")

      // Cancelling an in-flight request leaves an explicit message in the
      // left slot, replacing cwd outright (item 2) — never both at once.
      await mockInput.typeText("echo busy")
      mockInput.pressEnter()
      await pumpUntilFrame(testSetup, (frame) => frame.includes("Esc cancel"))
      mockInput.pressEscape()
      const cancelled = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("the workbench stayed"),
      )
      expect(cancelled).toContain("the workbench stayed")
      expect(cancelled).not.toContain("~/Projects/shellq")

      // A keystroke is one of the three triggers back to cwd: typing in the
      // composer clears the message even though nothing else changed.
      await mockInput.typeText("x")
      const afterKeystroke = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("~/Projects/shellq"),
      )
      expect(afterKeystroke).not.toContain("the workbench stayed")

      testSetup.renderer.destroy()
    },
    20_000,
  )

  test(
    "initializes without an Ask thread for an invalid pointer and offers explicit new chat",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-invalid-pointer-ui-test-"))
      const bin = join(root, "bin")
      const pointer = join(root, "app-server.json")
      const log = join(root, "events.log")
      const oldPath = process.env.PATH
      const oldLog = process.env.FAKE_LOG
      mkdirSync(bin)
      writeFileSync(log, "")
      const fake = join(bin, "codex")
      writeFileSync(fake, REUSE_UI_FAKE)
      chmodSync(fake, 0o700)
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.FAKE_LOG = log
      writeFileSync(pointer, "broken", { mode: 0o600 })
      const testSetup = await mountWorkbench({
        askSessionFile: pointer,
        height: 8,
        initialAskChatSaved: true,
        session: fixtureSession({
          codex_ask_engine: "app-server",
          initial_intent: "ask",
          provider: [BUNDLED_CODEX_PROVIDER],
        }),
        trustedWorkdir: root,
        askSessionFiles: {
          "app-server": pointer,
          exec: pointer,
        },
        width: 140,
      })
      try {
        await pumpUntilFrame(
          testSetup,
          () => readFileSync(log, "utf8").includes("initialize"),
        )
        expect(testSetup.active.session?.threadId).toBe("")
        expect(readFileSync(log, "utf8").trim()).toBe("initialize")
        testSetup.mockInput.typeText("do not spawn")
        testSetup.mockInput.pressEnter()
        const blocked = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("invalid App Server chat state"),
        )
        expect(blocked).toContain("^X N starts a new chat")
        expect(testSetup.active.process).toBeNull()
        expect(readFileSync(pointer, "utf8")).toBe("broken")

        testSetup.mockInput.pressTab()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Command]"))
        const pid = testSetup.active.session?.pid
        testSetup.mockInput.typeText("echo ok")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  echo app-server"))
        expect(testSetup.active.session?.pid).toBe(pid)

        testSetup.mockInput.pressTab({ shift: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Ask]"))

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("n")
        const ready = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("new chat ready"),
        )
        expect(ready).toContain("saved chat stays")

        testSetup.mockInput.pressTab()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Command]"))
        testSetup.mockInput.pressTab({ shift: true })
        const restored = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("new chat ready"),
        )
        expect(restored).toContain("saved chat stays until the first answer")
        expect(testSetup.active.process).toBeNull()
      } finally {
        await testSetup.active.session?.dispose()
        testSetup.renderer.destroy()
        process.env.PATH = oldPath
        if (oldLog === undefined) delete process.env.FAKE_LOG
        else process.env.FAKE_LOG = oldLog
        rmSync(root, { force: true, recursive: true })
      }
    },
    10_000,
  )

  test(
    "switches the managed Ask engine in Settings without sending or losing the draft",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-engine-ui-test-"))
      const appServerPointer = join(root, "app-server.json")
      const execPointer = join(root, "exec.json")
      const appServerPointerBytes = JSON.stringify({
        cwd: root,
        provider: "codex-app-server",
        session_id: "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
      })
      const execPointerBytes = "existing Exec pointer"
      const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
      process.env.SHELLQ_APP_SERVER_REUSE = "0"
      const session = fixtureSession({
        codex_ask_engine: "app-server",
        initial_intent: "ask",
        provider: [BUNDLED_CODEX_PROVIDER],
      })
      writeFileSync(appServerPointer, appServerPointerBytes, { mode: 0o600 })
      writeFileSync(execPointer, execPointerBytes, { mode: 0o600 })
      const testSetup = await mountWorkbench({
        askSessionFile: appServerPointer,
        askSessionFiles: {
          "app-server": appServerPointer,
          exec: execPointer,
        },
        height: 13,
        initialAskChatSaved: true,
        session,
        trustedWorkdir: root,
        width: 80,
      })
      try {
        await testSetup.mockInput.typeText("keep this draft")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("keep this draft"))
        testSetup.mockInput.pressKey("x", { ctrl: true })
        const actions = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Actions · S settings · P provider · nothing sends · Esc close"),
        )
        expect(actions).toContain("Esc close")
        testSetup.mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("keep this draft"))
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("g")

        const opened = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("Search Engines:"),
        )
        expect(opened).toContain("App Server")
        expect(opened).toContain("current")
        expect(testSetup.renderer.footerHeight).toBe(8)
        expect(testSetup.active.process).toBeNull()

        testSetup.mockInput.pressArrow("down")
        testSetup.mockInput.pressEnter()
        const switched = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("Search Engines:") && frame.includes("Applied"),
        )
        expect(testSetup.active.process).toBeNull()

        await closePalette(testSetup)
        const restored = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("keep this draft") && frame.includes("next Ask uses Codex Exe"),
        )
        expect(restored).toContain("keep this draft")
        expect(testSetup.active.process).toBeNull()

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("e")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("keep this draft"))
        await testSetup.mockInput.typeText(" plus")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Editing question ·"))
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await testSetup.mockInput.typeText("app")
        testSetup.mockInput.pressEnter()
        const refusedGeneralEngine = await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("keep this draft plus") && frame.includes("save or discard"),
        )
        expect(refusedGeneralEngine).toContain("^X W save")
        expect(testSetup.active.process).toBeNull()
        expect(testSetup.active.session).toBeNull()
        expect(session.codex_ask_engine).toBe("exec")

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Editing question ·"))
        testSetup.mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
        await closePalette(testSetup)
        const refusedEngine = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("keep this draft plus") &&
            frame.includes("^X W save"),
        )
        expect(refusedEngine).toContain("^X W save")
        testSetup.mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("edit discarded"))

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("h")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Codex boundary"))
        expect(testSetup.renderer.footerHeight).toBe(12)
        testSetup.mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) =>
          !frame.includes("Codex boundary") && frame.includes("^X actions"),
        )

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("g")
        const reopenedEngine = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Search Engines:") &&
          frame.includes("Codex Exec") &&
          frame.includes("current"),
        )
        expect(reopenedEngine).not.toContain("Codex/Codex Exec")
        expect(session.codex_ask_engine).toBe("exec")
        expect(testSetup.renderer.footerHeight).toBe(12)
        expect(readFileSync(appServerPointer, "utf8")).toBe(appServerPointerBytes)
        expect(readFileSync(execPointer, "utf8")).toBe(execPointerBytes)
      } finally {
        testSetup.renderer.destroy()
        if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
        else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
        rmSync(root, { force: true, recursive: true })
      }
  },
  20_000,
  )

  test("same-provider Model and Effort changes preserve mounted Workbench state", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-same-provider-state-"))
    const bin = join(root, "bin")
    const workdir = join(root, "repo")
    const stateDir = join(root, "state")
    const pointer = join(stateDir, "app-server.json")
    const log = join(root, "events.log")
    const oldPath = process.env.PATH
    const oldStateDir = process.env.SHELLQ_STATE_DIR
    const oldReuse = process.env.SHELLQ_APP_SERVER_REUSE
    const oldLog = process.env.FAKE_LOG
    let setup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
    try {
      mkdirSync(bin, { recursive: true })
      mkdirSync(workdir, { recursive: true })
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(log, "")
      writeFileSync(join(bin, "codex"), REUSE_UI_FAKE, { mode: 0o700 })
      process.env.PATH = `${bin}:${oldPath ?? ""}`
      process.env.SHELLQ_STATE_DIR = stateDir
      process.env.SHELLQ_APP_SERVER_REUSE = "1"
      process.env.FAKE_LOG = log
      writeFileSync(pointer, JSON.stringify({
        cwd: workdir,
        provider: "codex-app-server",
        session_id: "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
      }), { mode: 0o600 })
      const session = fixtureSession({
        codex_ask_engine: "app-server",
        context: {
          correlated: false,
          included: false,
          label: "recent pane only",
          source: "herdr",
          text: "preserved context",
        },
        initial_intent: "ask",
        provider: [BUNDLED_CODEX_PROVIDER],
      })
      setup = await mountWorkbench({
        askSessionFile: pointer,
        askSessionFiles: { "app-server": pointer, exec: pointer },
        height: 8,
        initialAskChatSaved: true,
        session,
        trustedWorkdir: workdir,
        width: 100,
      })
      await pumpUntilFrame(setup, () => readFileSync(log, "utf8").includes("thread/resume"))
      await setup.mockInput.typeText("first question")
      setup.mockInput.pressEnter()
      // The fake streams the delta before turn/completed, so a bare
      // warm-answer-1 can fire while the turn is still streaming; type only
      // once the accepted follow-up composer exists (the readiness marker
      // sibling tests use).
      await pumpUntilFrame(
        setup,
        (frame) => frame.includes("warm-answer-1") && frame.includes("Ask a follow-up"),
      )
      await setup.mockInput.typeText("keep this follow-up draft")
      await pumpUntilFrame(setup, (frame) => frame.includes("keep this follow-up draft"))
      writeFileSync(setup.resultPath, "accepted result", { mode: 0o600 })
      const pointerBytes = readFileSync(pointer, "utf8")
      const turnsBeforeSettings = readFileSync(log, "utf8").match(/turn\/start/g)?.length ?? 0
      const preparationCount = () =>
        readFileSync(log, "utf8").match(/thread\/(?:start|resume)/g)?.length ?? 0

      setup.mockInput.pressKeys(["\u0018m"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
      await setup.mockInput.typeText("luna")
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, (frame) =>
        frame.includes("Search Effort:") && frame.includes("Applied Codex/Luna"),
      )
      const preparationsBeforeCurrentEffort = preparationCount()
      setup.mockInput.pressEnter()
      await pumpUntilFrame(
        setup,
        (frame) =>
          frame.includes("keep this follow-up draft") &&
          !frame.includes("Search Effort:"),
        { tries: 100, delayMs: 25 },
      )
      await setup.renderOnce()
      expect(preparationCount()).toBe(preparationsBeforeCurrentEffort)
      expect(setup.active.session).toBeNull()
      expect(setup.captureCharFrame()).toContain("warm-answer-1")

      setup.mockInput.pressKeys(["\u0018r"])
      await pumpUntilFrame(setup, (frame) => frame.includes("Search Effort:"))
      await setup.mockInput.typeText("high")
      const preparationsBeforeChangedEffort = preparationCount()
      setup.mockInput.pressEnter()
      const preserved = await pumpUntilFrame(
        setup,
        (frame) =>
          frame.includes("keep this follow-up draft") &&
          !frame.includes("Search Effort:") &&
          preparationCount() === preparationsBeforeChangedEffort + 1 &&
          setup!.active.preparing === null,
        { tries: 100, delayMs: 25 },
      )
      await setup.renderOnce()
      expect(preparationCount()).toBe(preparationsBeforeChangedEffort + 1)
      expect(setup.active.session).not.toBeNull()
      expect(preserved).toContain("warm-answer-1")
      expect(session.model).toBe("gpt-5.6-luna")
      expect(session.reasoning).toBe("high")
      expect(session.context.text).toBe("preserved context")
      expect(readFileSync(pointer, "utf8")).toBe(pointerBytes)
      expect(readFileSync(setup.resultPath, "utf8")).toBe("accepted result")
      expect(readFileSync(log, "utf8").match(/turn\/start/g)?.length ?? 0).toBe(turnsBeforeSettings)

      setup.mockInput.pressKey("x", { ctrl: true })
      setup.mockInput.pressKey("c")
      const contextEditor = await pumpUntilFrame(setup, (frame) => frame.includes("preserved context"))
      expect(contextEditor).toContain("preserved context")
      setup.mockInput.pressEscape()
    } finally {
      await setup?.active.session?.dispose()
      setup?.renderer.destroy()
      process.env.PATH = oldPath
      if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = oldStateDir
      if (oldReuse === undefined) delete process.env.SHELLQ_APP_SERVER_REUSE
      else process.env.SHELLQ_APP_SERVER_REUSE = oldReuse
      if (oldLog === undefined) delete process.env.FAKE_LOG
      else process.env.FAKE_LOG = oldLog
      rmSync(root, { force: true, recursive: true })
    }
  }, 40_000)

  test(
    "keeps armed new-chat and rejects hidden engine actions while editing",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-engine-state-ui-test-"))
      const bin = join(root, "bin")
      const appServerPointer = join(root, "app-server.json")
      const execPointer = join(root, "exec.json")
      const oldPath = process.env.PATH
      const oldStateDir = process.env.SHELLQ_STATE_DIR
      let testSetup: Awaited<ReturnType<typeof mountWorkbench>> | null = null
      try {
        mkdirSync(bin, { recursive: true })
        process.env.SHELLQ_STATE_DIR = join(root, "state")
        writeFileSync(
          appServerPointer,
          JSON.stringify({
            cwd: root,
            provider: "codex-app-server",
            session_id: "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
          }),
          { mode: 0o600 },
        )
        writeFileSync(
          execPointer,
          JSON.stringify({
            cwd: root,
            provider: "codex",
            session_id: "0198f3c2-9999-7999-8999-999999999998",
          }),
          { mode: 0o600 },
        )
        const fakeCodex = join(bin, "codex")
        writeFileSync(
          fakeCodex,
          `#!/usr/bin/env zsh
[[ " $* " != *" exec resume "* ]] || exit 81
typeset output=''
typeset -i index=1
while (( index <= $# )); do
  if [[ \${argv[index]} == -o ]]; then
    output=\${argv[index + 1]}
    break
  fi
  (( ++index ))
done
print -r -- '{"type":"thread.started","thread_id":"0198f3c2-9999-7999-8999-999999999997"}'
print -rn -- '{"answer":"fresh chat answer"}' >"$output"
`,
        )
        chmodSync(fakeCodex, 0o700)
        process.env.PATH = `${bin}:${oldPath ?? ""}`

        testSetup = await mountWorkbench({
          askSessionFile: appServerPointer,
          askSessionFiles: {
            "app-server": appServerPointer,
            exec: execPointer,
          },
          height: 8,
          initialAskChatSaved: true,
          session: fixtureSession({
            codex_ask_engine: "app-server",
            initial_intent: "ask",
            provider: [BUNDLED_CODEX_PROVIDER],
          }),
          trustedWorkdir: root,
          width: 80,
        })

        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("n")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("new chat ready"))
        await testSetup.mockInput.typeText("fresh question")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("fresh question"))
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
        await testSetup.mockInput.typeText("luna")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Search Effort:") &&
          frame.includes("Applied Codex/Luna") &&
          frame.includes("current"),
        )
        await closePalette(testSetup)
        await pumpUntilFrame(testSetup, (frame) => frame.includes("fresh question"))
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("g")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Engines:"))
        testSetup.mockInput.pressArrow("down")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Engines:") && frame.includes("Applied"))
        await closePalette(testSetup)
        await pumpUntilFrame(
          testSetup,
          (frame) => frame.includes("new chat armed") && frame.includes("fresh question"),
        )
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("fresh chat answer"))
        expect(JSON.parse(readFileSync(execPointer, "utf8")).session_id).toBe(
          "0198f3c2-9999-7999-8999-999999999997",
        )

        testSetup.mockInput.pressTab()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("[Command]"))
        await testSetup.mockInput.typeText("keep command")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("e")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("keep command"))
        await testSetup.mockInput.typeText(" plus")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Editing prompt ·"))
        testSetup.mockInput.pressKey("g")
        const preserved = await pumpUntilFrame(
          testSetup,
          (frame) =>
            frame.includes("keep command plus") &&
            frame.includes("unknown ctrl-x chord"),
        )
        expect(preserved).toContain("keep command plus")
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup?.renderer.destroy()
        process.env.PATH = oldPath
        if (oldStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
        else process.env.SHELLQ_STATE_DIR = oldStateDir
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test(
    "non-left click and same-tab click on a mode tab are inert",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 8 })
      const titleBudget = frameLayout(width).titleBudget
      const spans = modeTabs("generate", titleBudget, true).spans
      const askX = TITLE_ORIGIN_X + spans.ask.start
      const generateX = TITLE_ORIGIN_X + spans.generate.start

      const before = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("[Command]"),
      )

      // Right-click (non-left) on an inactive tab switches nothing.
      await testSetup.mockMouse.click(askX, 0, MouseButtons.RIGHT)
      await testSetup.renderOnce()
      let frame = testSetup.captureCharFrame()
      expect(frame).toContain("[Command]")
      expect(frame).not.toContain("[Ask]")

      // Left-click on the tab that is already selected is inert too.
      await testSetup.mockMouse.click(generateX, 0, MouseButtons.LEFT)
      await testSetup.renderOnce()
      frame = testSetup.captureCharFrame()
      expect(frame).toContain("[Command]")
      expect(frame).toBe(before)

      testSetup.renderer.destroy()
    },
    20_000,
  )

  test(
    "pointer input is ignored while a provider request is busy",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({
        width,
        height: 8,
        session: fixtureSession({ provider: SLOW_PROVIDER }),
      })
      const { mockInput } = testSetup

      await mockInput.typeText("echo busy")
      mockInput.pressEnter()
      await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("Esc cancel"),
      )

      const titleBudget = frameLayout(width).titleBudget
      const askX =
        TITLE_ORIGIN_X +
        modeTabs("generate", titleBudget, true).spans.ask.start

      // A mode-tab click while busy must not switch intent or cancel the
      // in-flight request.
      await testSetup.mockMouse.click(askX, 0, MouseButtons.LEFT)
      await testSetup.renderOnce()
      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("[Command]")
      expect(frame).not.toContain("[Ask]")
      expect(frame).toContain("Esc cancel")

      // Escape stops the child, but this test does not assert on the
      // cancellation frame: that wait depends on a real subprocess dying and
      // made the case fail roughly three runs in five. The property under
      // test is already proven above, and cancellation has its own
      // deterministic coverage in the PTY suite.
      mockInput.pressEscape()
      testSetup.renderer.destroy()
    },
    20_000,
  )

  test(
    "clicking the disclosure at its new right-group position still toggles inclusion",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({
        width,
        height: 8,
        session: fixtureSession({
          context: {
            correlated: false,
            included: false,
            label: "recent pane only",
            source: "tmux",
            text: "x".repeat(50),
          },
        }),
      })

      const resting = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("Attach output"),
      )
      expect(resting).toContain("Attach output · ^X actions")

      const budget = frameLayout(width).titleBudget
      const span = bottomRail(
        {
          action: "",
          contextBytes: 50,
          cwd: HOME_CWD,
          included: false,
          message: null,
        },
        budget,
        true,
      ).spans.disclosure
      expect(span).not.toBeNull()

      // Mouse dispatch subtracts the renderer's own live `renderOffset`
      // (the footer band's absolute screen row) before hit-testing against
      // component-local spans — the same mechanism `onFrameMouseDown`'s own
      // comment describes for `event.y`. A raw click needs that offset added
      // back in, or it lands above the footer band entirely and is ignored.
      const renderOffset = footerRenderOffset(testSetup.renderer)
      await testSetup.mockMouse.click(
        TITLE_ORIGIN_X + span!.start,
        renderOffset + testSetup.renderer.footerHeight - 1,
        MouseButtons.LEFT,
      )
      const attached = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("Output attached (~14 tokens)"),
      )
      expect(attached).not.toContain("Attach output")

      testSetup.renderer.destroy()
    },
    20_000,
  )

  const sq16Spans = (intent: SessionIntent, width: number) =>
    topRail(
      { intent, provider: "custom", model: "gpt-5.3-codex-spark", reasoning: "low" },
      frameLayout(width).titleBudget,
      true,
    ).spans

  test(
    "SQ-16: top border clicks open provider/model/effort menus in Ask mode and keep the draft",
    async () => {
      const width = 80
      const root = mkdtempSync(join(tmpdir(), "shellq-sq16-ask-"))
      const requestLog = join(root, "provider-requests")
      const testSetup = await mountWorkbench({
        width,
        height: 12,
        session: fixtureSession({
          initial_intent: "ask",
          provider: [
            "bun",
            "-e",
            `await Bun.stdin.text(); await Bun.write(${JSON.stringify(requestLog)}, "called")`,
          ],
        }),
        trustedWorkdir: root,
      })
      try {
        await testSetup.mockInput.typeText("question draft")
        await testSetup.renderOnce()

        // Provider range → Provider Setup, exactly Ctrl-X P's destination.
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + sq16Spans("ask", width).provider!.start,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Provider Setup"))
        testSetup.mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) => !frame.includes("Provider Setup"))
        expect(testSetup.captureCharFrame()).toContain("question draft")

        // Model range → the typed palette's model view (Ctrl-X M).
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + sq16Spans("ask", width).model!.start,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))
        await closePalette(testSetup)
        expect(testSetup.captureCharFrame()).toContain("question draft")

        // Effort range → the typed palette's effort view (Ctrl-X R).
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + sq16Spans("ask", width).reasoning!.start,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Effort:"))
        await closePalette(testSetup)
        expect(testSetup.captureCharFrame()).toContain("question draft")

        // Opening and closing menus called no provider and wrote no result.
        expect(testSetup.active.process).toBeNull()
        expect(existsSync(requestLog)).toBe(false)
        expect(existsSync(testSetup.resultPath)).toBe(false)
      } finally {
        testSetup.renderer.destroy()
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test(
    "SQ-16: top border clicks open their menus in Command mode and keep results and selection",
    async () => {
      const width = 80
      const root = mkdtempSync(join(tmpdir(), "shellq-sq16-command-"))
      const requestLog = join(root, "provider-requests")
      const testSetup = await mountWorkbench({
        width,
        height: 12,
        session: fixtureSession({
          initial_intent: "generate",
          provider: [
            "bun",
            "-e",
            `const {appendFileSync} = require("node:fs");
             const req = JSON.parse(await Bun.stdin.text());
             appendFileSync(${JSON.stringify(requestLog)}, "call\\n");
             const avoid = Array.isArray(req.input.avoid_commands) ? req.input.avoid_commands.length : 0;
             console.log(JSON.stringify({
               tldr: "fixture suggestion",
               corrected_command: "echo candidate-" + avoid,
               confidence: 0.8,
               risk: "low",
             }));`,
          ],
        }),
        trustedWorkdir: root,
      })
      try {
        await testSetup.mockInput.typeText("echo initial")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("echo candidate-0"))

        // Ctrl-X A asks for another suggestion; the fixture answers with
        // `echo candidate-1` because avoid_commands now holds candidate-0.
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("a")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("echo candidate-1"))
        const withTwo = testSetup.captureCharFrame()
        // The second candidate is appended and becomes the selection.
        expect(withTwo).toContain("Choices · selected 2 of 2")
        expect(withTwo).toContain("› 2  echo candidate-1")
        expect(withTwo).toContain("  1  echo candidate-0")

        const spans = sq16Spans("generate", width)
        for (const [label, span, opened] of [
          ["provider", spans.provider!, "Provider Setup"],
          ["model", spans.model!, "Search Models:"],
          ["effort", spans.reasoning!, "Search Effort:"],
        ] as const) {
          await testSetup.mockMouse.click(
            TITLE_ORIGIN_X + span.start,
            footerRenderOffset(testSetup.renderer),
            MouseButtons.LEFT,
          )
          await pumpUntilFrame(testSetup, (frame) => frame.includes(opened))
          if (opened === "Provider Setup") {
            testSetup.mockInput.pressEscape()
            await pumpUntilFrame(testSetup, (frame) => !frame.includes("Provider Setup"))
          } else {
            await closePalette(testSetup)
          }
          const frame = testSetup.captureCharFrame()
          // Closing the menu returns to the same result list, same selection,
          // with the menu itself gone.
          expect(frame).not.toContain(opened)
          expect(frame).toContain("Choices · selected 2 of 2")
          expect(frame).toContain("› 2  echo candidate-1")
          expect(frame).toContain("  1  echo candidate-0")
        }

        // Exactly the two intentional calls happened — the submit and the
        // another-suggestion; no menu click called again.
        expect(readFileSync(requestLog, "utf8").split("\n").filter((line) => line === "call").length).toBe(2)
        expect(testSetup.active.process).toBeNull()
        expect(existsSync(testSetup.resultPath)).toBe(false)
      } finally {
        testSetup.renderer.destroy()
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test(
    "SQ-16: top border clicks open provider/model/effort menus in Fix mode and keep the draft",
    async () => {
      const width = 80
      const root = mkdtempSync(join(tmpdir(), "shellq-sq16-fix-"))
      const requestLog = join(root, "provider-requests")
      const testSetup = await mountWorkbench({
        width,
        height: 12,
        session: fixtureSession({
          initial_intent: "correct",
          provider: [
            "bun",
            "-e",
            `await Bun.stdin.text(); await Bun.write(${JSON.stringify(requestLog)}, "called")`,
          ],
        }),
        trustedWorkdir: root,
      })
      try {
        await testSetup.mockInput.typeText("refine the failure")
        await testSetup.renderOnce()

        for (const [span, opened] of [
          [sq16Spans("correct", width).provider!, "Provider Setup"],
          [sq16Spans("correct", width).model!, "Search Models:"],
          [sq16Spans("correct", width).reasoning!, "Search Effort:"],
        ] as const) {
          await testSetup.mockMouse.click(
            TITLE_ORIGIN_X + span.start,
            footerRenderOffset(testSetup.renderer),
            MouseButtons.LEFT,
          )
          await pumpUntilFrame(testSetup, (frame) => frame.includes(opened))
          if (opened === "Provider Setup") {
            testSetup.mockInput.pressEscape()
            await pumpUntilFrame(testSetup, (frame) => !frame.includes("Provider Setup"))
          } else {
            await closePalette(testSetup)
          }
          expect(testSetup.captureCharFrame()).toContain("refine the failure")
        }

        expect(testSetup.active.process).toBeNull()
        expect(existsSync(requestLog)).toBe(false)
        expect(existsSync(testSetup.resultPath)).toBe(false)
      } finally {
        testSetup.renderer.destroy()
        rmSync(root, { force: true, recursive: true })
      }
    },
    20_000,
  )

  test(
    "SQ-16: resize drops the effort target and moves provider/model targets with the paint",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 12 })
      try {
        // Resting wide view paints all three ranges.
        const wide = sq16Spans("generate", width)
        expect(wide.reasoning).not.toBeNull()
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + wide.reasoning!.start,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Effort:"))
        await closePalette(testSetup)

        // Narrowing drops only the effort field; provider and model survive,
        // shifted left. Hit testing must follow the repainted positions: both
        // moved ranges open their own menus at the new columns. Like a fresh
        // mount, the renderer needs a few passes after resize before its mouse
        // tracking accepts events, so settle before the first click.
        testSetup.renderer.resize(40, 12)
        const narrow = sq16Spans("generate", 40)
        expect(narrow.reasoning).toBeNull()
        expect(narrow.provider).not.toBeNull()
        await pumpUntilFrame(testSetup, (frame) => !frame.includes("· low"))
        for (let pass = 0; pass < 10; pass += 1) {
          await testSetup.renderOnce()
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        for (const [span, opened] of [
          [narrow.provider!, "Provider Setup"],
          [narrow.model!, "Search Models:"],
        ] as const) {
          await testSetup.mockMouse.click(
            TITLE_ORIGIN_X + span.start,
            footerRenderOffset(testSetup.renderer),
            MouseButtons.LEFT,
          )
          await pumpUntilFrame(testSetup, (frame) => frame.includes(opened))
          if (opened === "Provider Setup") {
            // The setup panel is an overlay, not a Search palette: Escape only.
            testSetup.mockInput.pressEscape()
            await pumpUntilFrame(testSetup, (frame) => !frame.includes(opened))
          } else {
            // A scoped Search palette Escapes to the root palette first, so
            // keep pressing until every Search header is gone.
            await closePalette(testSetup)
          }
        }
        const frame = testSetup.captureCharFrame()
        expect(frame).not.toContain("Search All:")
        expect(frame).not.toContain("Search Effort:")

        // Widening repaints the effort range and its click target returns.
        testSetup.renderer.resize(80, 12)
        await pumpUntilFrame(testSetup, (frame) => frame.includes("· low"))
        for (let pass = 0; pass < 10; pass += 1) {
          await testSetup.renderOnce()
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + sq16Spans("generate", width).reasoning!.start,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Effort:"))
        await closePalette(testSetup)
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "SQ-16: non-left clicks and painted-gap columns never open the menus",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({ width, height: 12 })
      try {
        const spans = sq16Spans("generate", width)
        const resting = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("[Command]"),
        )

        // Right-click on each right-hand field is inert, byte for byte.
        for (const span of [spans.provider!, spans.model!, spans.reasoning!]) {
          await testSetup.mockMouse.click(
            TITLE_ORIGIN_X + span.start + 1,
            footerRenderOffset(testSetup.renderer),
            MouseButtons.RIGHT,
          )
          await testSetup.renderOnce()
          expect(testSetup.captureCharFrame()).toBe(resting)
        }

        // The fill between the mode strip and the right fields belongs to no
        // range: a left click there must not open anything either.
        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + 30,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await testSetup.renderOnce()
        expect(testSetup.captureCharFrame()).toBe(resting)
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  test(
    "SQ-16: a click on the model range is ignored while a request is busy",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({
        width,
        height: 12,
        session: fixtureSession({ provider: SLOW_PROVIDER }),
      })
      try {
        await testSetup.mockInput.typeText("echo busy")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Esc cancel"))

        await testSetup.mockMouse.click(
          TITLE_ORIGIN_X + sq16Spans("generate", width).model!.start,
          footerRenderOffset(testSetup.renderer),
          MouseButtons.LEFT,
        )
        await testSetup.renderOnce()
        const frame = testSetup.captureCharFrame()
        expect(frame).not.toContain("Search")
        expect(frame).not.toContain("Provider Setup")
        expect(frame).toContain("Esc cancel")
        expect(testSetup.active.process).not.toBeNull()

        // Escape stops the child; cancellation itself is asserted by the
        // deterministic PTY suite, so this only releases the subprocess.
        testSetup.mockInput.pressEscape()
      } finally {
        testSetup.renderer.destroy()
      }
    },
    20_000,
  )

  for (const [terminalHeight, expectedFooterHeight] of [[8, 7], [24, 8]]) {
  test(
    `the attached-output preview preserves the shell row at ${terminalHeight} rows and yields to candidates`,
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({
        width,
        height: terminalHeight,
        session: fixtureSession({
          initial_intent: "correct",
          actionable_failure: true,
          context: {
            correlated: false,
            included: true,
            label: "matched command",
            source: "herdr",
            text: ["old-1", "old-2", "tail-1", "tail-2", "tail-3"].join("\n"),
          },
        }),
      })

      // Bounded to the last three lines: the older two never appear.
      const withPreview = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes(CONTEXT_PREVIEW_LABEL),
      )
      expect(withPreview).toContain("tail-1")
      expect(withPreview).toContain("tail-2")
      expect(withPreview).toContain("tail-3")
      expect(withPreview).not.toContain("old-1")
      expect(withPreview).not.toContain("old-2")
      // Promotion reserves one physical terminal row for the shell prompt.
      expect(testSetup.renderer.footerHeight).toBe(expectedFooterHeight)
      expect(testSetup.renderer.footerHeight).toBeLessThan(testSetup.renderer.terminalHeight)

      // Submitting (the prefilled "pwd" draft is already a valid command)
      // promotes a candidate list, which then owns the body instead.
      testSetup.mockInput.pressEnter()
      const withCandidate = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("echo candidate-0"),
      )
      expect(withCandidate).not.toContain(CONTEXT_PREVIEW_LABEL)

      testSetup.renderer.destroy()
    },
    20_000,
  )

  }

  test(
    "a stale-settings notice shows once on open and clears on the next state change",
    async () => {
      const width = 80
      const testSetup = await mountWorkbench({
        width,
        height: 8,
        initialNotice: "saved model unavailable · using Spark",
      })

      // At 80 columns the rail's message cap truncates the full notice with
      // an ellipsis, so only the leading, most-informative words are
      // guaranteed to survive.
      const opening = await pumpUntilFrame(testSetup, (frame) =>
        frame.includes("saved model unavailable"),
      )
      expect(opening).toContain("saved model unavailable")

      await testSetup.mockInput.typeText("x")
      const afterKeystroke = await pumpUntilFrame(
        testSetup,
        (frame) => !frame.includes("saved model unavailable"),
      )
      expect(afterKeystroke).not.toContain("saved model unavailable")

      testSetup.renderer.destroy()
    },
    20_000,
  )

  test(
    "provider switching preserves the active editor and current provider-engine pointers",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-provider-editor-test-"))
      const bin = join(root, "bin")
      const claudePointer = join(root, "claude.json")
      const codexAppPointer = join(root, "codex-app.json")
      const codexExecPointer = join(root, "codex-exec.json")
      const resultAuthority = "existing accepted result"
      const oldPath = process.env.PATH
      mkdirSync(bin)
      for (const name of ["codex", "claude"]) {
        writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
        chmodSync(join(bin, name), 0o700)
      }
      writeFileSync(claudePointer, JSON.stringify({ provider: "claude", cwd: root, session_id: "11111111-1111-4111-8111-111111111111" }), { mode: 0o600 })
      writeFileSync(codexAppPointer, JSON.stringify({ provider: "codex-app-server", cwd: root, session_id: "22222222-2222-4222-8222-222222222222" }), { mode: 0o600 })
      writeFileSync(codexExecPointer, JSON.stringify({ provider: "codex", cwd: root, session_id: "33333333-3333-4333-8333-333333333333" }), { mode: 0o600 })
      process.env.PATH = `${bin}:/bin:/usr/bin`
      const session = fixtureSession({
        codex_ask_engine: "app-server",
        initial_intent: "ask",
        provider: [BUNDLED_CLAUDE_PROVIDER],
        provider_id: "claude",
        provider_source: "default",
        context: {
          correlated: false,
          included: false,
          label: "recent pane only",
          source: "tmux",
          text: "preserved context",
        },
      })
      const testSetup = await mountWorkbench({
        askSessionFile: claudePointer,
        askSessionFiles: { "app-server": codexAppPointer, exec: codexExecPointer },
        height: 8,
        initialAskChatSaved: true,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        writeFileSync(testSetup.resultPath, resultAuthority, { mode: 0o600 })
        await testSetup.mockInput.typeText("preserve this editor")
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        testSetup.mockInput.pressKey("e")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("preserve this editor"))
        testSetup.mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Editing question ·"))
        testSetup.mockInput.pressKey("p")
        const setup = await pumpUntilFrame(testSetup, (frame) => frame.includes("Provider"))
        // Three providers are registered now. Setup lists and reports all
        // three, but only the two CLI providers are steppable here: the
        // managed local provider is bound in the palette by naming an exact
        // model, never by a provider-granularity switch.
        expect(setup).toContain("codex")
        expect(setup).toContain("[claude]")
        expect(setup).toContain("local-openai")
        expect(setup).toContain("Codex CLI AVAILABLE")
        expect(setup).toContain("Claude CLI AVAILABLE")
        expect(setup).toContain("Local managed AVAILABLE")
        testSetup.mockInput.pressArrow("right")
        const stepped = await pumpUntilFrame(testSetup, (frame) => frame.includes("[codex]"))
        expect(stepped).not.toContain("[local-openai]")
        testSetup.mockInput.pressEscape()
        const switched = await pumpUntilFrame(testSetup, (frame) => frame.includes("preserve this editor"))
        expect(switched).toContain("preserve this editor")
        expect(readFileSync(claudePointer, "utf8")).toContain("11111111")
        expect(readFileSync(codexAppPointer, "utf8")).toContain("22222222")
        expect(readFileSync(codexExecPointer, "utf8")).toContain("33333333")
        expect(readFileSync(testSetup.resultPath, "utf8")).toBe(resultAuthority)
        expect(session.context.text).toBe("preserved context")
        expect(session.context.label).toBe("recent pane only")
      } finally {
        testSetup.renderer.destroy()
        process.env.PATH = oldPath
        rmSync(root, { recursive: true, force: true })
      }
    },
    20_000,
  )

  test(
    "blocks a managed provider that disappears after mount",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "shellq-provider-disappear-test-"))
      const bin = join(root, "bin")
      const oldPath = process.env.PATH
      mkdirSync(bin)
      const codex = join(bin, "codex")
      writeFileSync(codex, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
      chmodSync(codex, 0o700)
      process.env.PATH = `${bin}:/bin:/usr/bin`
      const testSetup = await mountWorkbench({
        height: 8,
        session: fixtureSession({
          codex_ask_engine: "exec",
          provider: [BUNDLED_CODEX_PROVIDER],
          provider_id: "codex",
          provider_source: "default",
        }),
        width: 100,
      })
      try {
        unlinkSync(codex)
        await testSetup.mockInput.typeText("must not run")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("must not run"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("no registered provider is available"))
        expect(testSetup.active.process).toBeNull()
      } finally {
        testSetup.renderer.destroy()
        process.env.PATH = oldPath
        rmSync(root, { recursive: true, force: true })
      }
    },
    20_000,
  )

  test(
    "changing a Settings value persists it and a later invocation would resume it",
    async () => {
      const width = 80
      const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-write-"))
      const previous = process.env.SHELLQ_STATE_DIR
      process.env.SHELLQ_STATE_DIR = stateDir
      try {
        const testSetup = await mountWorkbench({ width, height: 8 })
        const { mockInput } = testSetup

        mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))

        mockInput.pressArrow("down")
        mockInput.pressEnter()
        const changed = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Applied Configured/Luna"),
        )
        expect(changed).toContain("Configured/Luna")

        const persisted = readPersistedInferenceSettings({
          SHELLQ_STATE_DIR: stateDir,
        }, "configured")
        expect(persisted).toEqual({ model: "gpt-5.6-luna", reasoning: "low" })

        testSetup.renderer.destroy()
      } finally {
        if (previous === undefined) delete process.env.SHELLQ_STATE_DIR
        else process.env.SHELLQ_STATE_DIR = previous
      }
    },
    20_000,
  )

  test(
    "a Settings change that fails to persist still applies in-memory and reports failure instead of crashing",
    async () => {
      const width = 80
      const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-fail-"))
      writePersistedInferenceSettings("gpt-5.3-codex-spark", "low", { SHELLQ_STATE_DIR: stateDir }, "configured")
      const saved = readFileSync(join(stateDir, "settings.json"), "utf8")
      // A real live owner refuses this save while the prior disk tuple survives.
      writeFileSync(join(stateDir, workbenchBindings.INFERENCE_SETTINGS_LOCK), JSON.stringify({ pid: process.pid, nonce: "held", created_at: Date.now() }))
      const previous = process.env.SHELLQ_STATE_DIR
      process.env.SHELLQ_STATE_DIR = stateDir
      try {
        const testSetup = await mountWorkbench({ width, height: 8, session: fixtureSession({
          provider: [FAKE_PROVIDER[0], FAKE_PROVIDER[1], 'if (process.env.SHELLQ_CODEX_MODEL !== "gpt-5.6-luna") process.exit(90);' + FAKE_PROVIDER[2]],
        }) })
        const { mockInput } = testSetup

        mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        mockInput.pressKey("m")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Models:"))

        mockInput.pressArrow("down")
        mockInput.pressEnter()
        const failed = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("could not save choice"),
        )
        expect(failed).toContain("could not save choice")

        // The workbench itself keeps running: Settings still closes and
        // reopens focused on the other field.
        mockInput.pressEscape()
        await pumpUntilFrame(testSetup, (frame) => !frame.includes("Search Models:"))
        mockInput.pressKey("x", { ctrl: true })
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Actions ·"))
        mockInput.pressKey("r")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search Effort:"))
        await closePalette(testSetup)
        await mockInput.typeText("prove the unsaved model works")
        mockInput.pressEnter()
        await pumpUntilFrame(testSetup, frame => frame.includes("echo candidate-0"), { tries: 160 })
        expect(readFileSync(join(stateDir, "settings.json"), "utf8")).toBe(saved)
        expect(existsSync(testSetup.resultPath)).toBe(false)
        testSetup.renderer.destroy()
      } finally {
        if (previous === undefined) delete process.env.SHELLQ_STATE_DIR
        else process.env.SHELLQ_STATE_DIR = previous
      }
    },
    20_000,
  )
})

/* Local managed provider wiring.
 *
 * Every one of these drives the REAL adapter shim against a loopback fixture
 * server — never the developer's own server on port 8000 — and counts the
 * fixture's hits, so "sends zero HTTP" is an observation rather than a claim. */
describe("mounted workbench: local managed provider", () => {
  const LOCAL_ADAPTER = adapterPath(descriptorForProvider(LOCAL_PROVIDER_ID))
  const CATALOG = ["qwen3-coder-30b-a3b-instruct", "gemma-3-12b-it"]

  type LocalFixture = {
    endpoint: string
    hits: Array<{ method: string; path: string }>
    posts: Array<Record<string, any>>
    sockets: Set<Socket>
    catalog: string[]
    onModels?: (response: ServerResponse) => void
    onCompletion?: (response: ServerResponse) => void
    completion: () => string
    completionStatus: number
    close: () => Promise<void>
  }

  // Serves a whole-body fixture completion the way a conforming server answers
  // this request: SSE when streaming was requested, and a candidates batch when
  // the request schema requires one. Bodies that are not a completion stay raw.
  const asConformingStream = (text: string, post: Record<string, any>) => {
    let parsed: any
    try { parsed = JSON.parse(text) } catch { return null }
    const choice = parsed?.choices?.[0]
    if (typeof choice?.message?.content !== "string") return null
    let content: string = choice.message.content
    if (post.response_format?.json_schema?.schema?.required?.includes("candidates")) {
      try {
        const value = JSON.parse(content)
        if (value && typeof value === "object" && !("candidates" in value)) content = JSON.stringify({ candidates: [value] })
      } catch {}
    }
    const event = { choices: [{ index: 0, delta: { content }, finish_reason: choice.finish_reason ?? "stop" }] }
    return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`
  }

  const startLocalFixture = (
    completion: () => string = () =>
      JSON.stringify({
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                tldr: "lists the files",
                corrected_command: "ls -la",
                confidence: 0.9,
                risk: "low",
              }),
            },
            finish_reason: "stop",
          },
        ],
      }),
  ): Promise<LocalFixture> => {
    const hits: Array<{ method: string; path: string }> = []
    const posts: Array<Record<string, any>> = []
    let fixture: LocalFixture
    return startRawTcpFixture((req, res) => {
      // The adapter writes raw requests without a User-Agent; anything else is
      // a foreign loopback probe from the host, not ShellQ traffic.
      if (req.headers["user-agent"]) {
        res.writeHead(404)
        res.end()
        return
      }
      hits.push({ method: req.method ?? "", path: req.url ?? "" })
      if (req.url === "/v1/models") {
        if (fixture.onModels) return fixture.onModels(res)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: fixture.catalog.map((id) => ({ id })) }))
        return
      }
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        let post: Record<string, any> | undefined
        try {
          post = JSON.parse(body)
          posts.push(post!)
        } catch {}
        if (fixture.onCompletion) return fixture.onCompletion(res)
        const text = fixture.completion()
        const streamed = post?.stream === true && fixture.completionStatus === 200 ? asConformingStream(text, post) : null
        if (streamed) {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          res.end(streamed)
          return
        }
        res.writeHead(fixture.completionStatus, { "Content-Type": "application/json" })
        res.end(text)
      })
    }).then((raw) => {
      fixture = {
        endpoint: `http://127.0.0.1:${raw.port}/v1`,
        hits,
        posts,
        sockets: raw.sockets,
        catalog: [...CATALOG],
        completion,
        completionStatus: 200,
        close: raw.close,
      }
      return fixture
    })
  }

  const localSession = (overrides: Partial<WorkbenchSession> = {}) =>
    fixtureSession({
      initial_intent: "generate",
      provider: [LOCAL_ADAPTER],
      provider_id: LOCAL_PROVIDER_ID,
      provider_source: "default",
      model: "",
      reasoning: "endpoint default",
      models: [],
      reasoning_levels: ["endpoint default"],
      ...overrides,
    })

  // Restores every process-global this suite touches, so an early failure
  // cannot leak an endpoint or a PATH into the rest of the file.
  const withLocalEnvironment = async (
    body: (fixture: LocalFixture, root: string) => Promise<void>,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "shellq-local-openai-test-"))
    // A PATH holding exactly what the shim needs to exec itself (`zsh` for the
    // shebang, `bun` for the adapter) and nothing else — so the CLI providers
    // are unselectable and no Codex discovery can start behind this suite.
    const bin = join(root, "bin")
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, "bun"))
    for (const zsh of ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]) {
      if (existsSync(zsh)) {
        symlinkSync(zsh, join(bin, "zsh"))
        break
      }
    }
    const fixture = await startLocalFixture()
    const previous = {
      endpoint: process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT,
      path: process.env.PATH,
      stateDir: process.env.SHELLQ_STATE_DIR,
    }
    process.env.PATH = bin
    process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = fixture.endpoint
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    try {
      await body(fixture, root)
    } finally {
      if (previous.endpoint === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      else process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = previous.endpoint
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.stateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = previous.stateDir
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const beginLocalCheck = async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("s")
    await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
    await setup.mockInput.typeText("check local")
    await pumpUntilFrame(setup, (frame) => frame.includes("Check local models"))
    setup.mockInput.pressEnter()
  }

  const checkLocalModels = async (setup: Awaited<ReturnType<typeof mountWorkbench>>, count = 2) => {
    await beginLocalCheck(setup)
    await pumpUntilFrame(setup, (frame) => frame.includes(`${count} local model`), { tries: 160 })
  }

  const chooseLocalModel = async (setup: Awaited<ReturnType<typeof mountWorkbench>>, query = "a3b") => {
    await setup.mockInput.typeText(query)
    await pumpUntilFrame(setup, (frame) => frame.includes(`Search All: ${query}`))
    setup.mockInput.pressEnter()
    await pumpUntilFrame(setup, (frame) => frame.includes("Search Effort:"))
    setup.mockInput.pressEnter()
    await pumpUntilFrame(setup, (frame) => !frame.includes("Search Effort:") && !frame.includes("Search All:"))
  }

  const openEndpoint = async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("s")
    await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
    await setup.mockInput.typeText("configure local")
    await pumpUntilFrame(setup, (frame) => frame.includes("Configure local endpoint"))
    setup.mockInput.pressEnter()
    await pumpUntilFrame(setup, (frame) => frame.includes("Local endpoint /"))
  }

  const replaceEndpoint = async (setup: Awaited<ReturnType<typeof mountWorkbench>>, value: string) => {
    setup.mockInput.pressKey("a", { ctrl: true })
    setup.mockInput.pressKey("k", { ctrl: true })
    await setup.mockInput.typeText(value)
    await setup.renderOnce()
  }

  const clickEndpointControl = async (setup: Awaited<ReturnType<typeof mountWorkbench>>, label: string) => {
    const frame = (await pumpUntilFrame(setup, (frame) => frame.includes(label))).split("\n")
    const row = frame.findIndex((line) => line.includes(label))
    expect(row).toBeGreaterThanOrEqual(0)
    await setup.mockMouse.click(frame[row].indexOf(label) + 1, footerRenderOffset(setup.renderer) + row, MouseButtons.LEFT)
    await setup.renderOnce()
  }

  test("writable endpoint Ctrl-X R resets without changing the composer or sending HTTP", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      writePersistedLocalEndpoint(fixture.endpoint, "codex")
      const setup = await mountWorkbench({ width: 100, height: 8, trustedWorkdir: root })
      try {
        await setup.mockInput.typeText("keep this composer")
        await openEndpoint(setup)
        setup.mockInput.pressKey("x", { ctrl: true })
        setup.mockInput.pressKey("r")
        await pumpUntilFrame(setup, frame => !frame.includes("Local endpoint /") && frame.includes("keep this composer"))
        expect(readPersistedInferenceDocument()?.localEndpoint).toBeUndefined()
        await openEndpoint(setup)
        expect(setup.captureCharFrame()).toContain("Local endpoint / default")
        expect(setup.captureCharFrame()).toContain("http://127.0.0.1:8000/v1")
        expect(fixture.hits).toEqual([])
        expect(existsSync(setup.resultPath)).toBe(false)
      } finally { setup.renderer.destroy() }
    })
  }, 20_000)

  test("endpoint configured repair requires confirmation and preserves dispatch for the next selection", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      mkdirSync(process.env.SHELLQ_STATE_DIR!, { mode: 0o700 })
      writeFileSync(inferenceSettingsFile(), "private-corrupted-settings", { mode: 0o600 })
      const session = fixtureSession()
      prepareProviderSession(session)
      const before = JSON.stringify({ provider: session.provider, source: session.provider_source, model: session.model })
      const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session })
      try {
        await setup.mockInput.typeText("configured draft")
        await openEndpoint(setup)
        expect(setup.captureCharFrame()).not.toContain("private-corrupted-settings")
        expect(setup.captureCharFrame()).toContain("Unreadable selections cannot be preserved")
        await replaceEndpoint(setup, fixture.endpoint)
        await clickEndpointControl(setup, "[^X W Save]")
        await pumpUntilFrame(setup, (frame) => frame.includes("Replace unreadable saved settings?"))
        expect(readFileSync(inferenceSettingsFile(), "utf8")).toBe("private-corrupted-settings")
        setup.mockInput.pressEscape()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Replace unreadable saved settings?"))
        await clickEndpointControl(setup, "[^X W Save]")
        await clickEndpointControl(setup, "[Enter Confirm]")
        await pumpUntilFrame(setup, (frame) => frame.includes("configured draft") && !frame.includes("Local endpoint /"))
        expect(JSON.stringify({ provider: session.provider, source: session.provider_source, model: session.model })).toBe(before)
        expect(readPersistedInferenceDocument()?.providers).toEqual({})
        setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey("s")
        await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
        await setup.mockInput.typeText("gpt-5.6-luna")
        await pumpUntilFrame(setup, (frame) => frame.includes("gpt-5.6-luna"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("Search Effort:"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Search Effort:"))
        expect(readPersistedInferenceSettings(process.env, "configured")?.model).toBe("gpt-5.6-luna")
        expect(readPersistedInferenceDocument()?.localEndpoint).toBe(fixture.endpoint)
        expect(session.provider).toEqual(FAKE_PROVIDER)
        expect(session.provider_source).toBe("configured")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("echo candidate-0"))
        expect(fixture.hits).toEqual([])
      } finally { setup.renderer.destroy() }
    })
  }, 30_000)

  for (const override of ["valid", "", "private-invalid-override"]) {
    test(`endpoint override ${override || "empty"} is read-only without shadowed writes`, async () => {
      await withLocalEnvironment(async (fixture, root) => {
        writePersistedLocalEndpoint("http://127.0.0.1:1/v1", null)
        process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = override === "valid" ? fixture.endpoint : override
        const initial = readFileSync(inferenceSettingsFile(), "utf8")
        const setup = await mountWorkbench({ width: 100, height: 8, trustedWorkdir: root, session: localSession() })
        try {
          await openEndpoint(setup)
          expect(setup.captureCharFrame()).not.toContain("private-invalid-override")
          await setup.mockInput.typeText("private-typed-value")
          for (const key of ["w", "r", "e", "c", "n", "m", "s", "d", "a"]) {
            setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey(key)
          }
          setup.mockInput.pressEnter()
          await setup.renderOnce()
          expect(readFileSync(inferenceSettingsFile(), "utf8")).toBe(initial)
          expect(setup.captureCharFrame()).toContain("Remove the override")
          expect(setup.captureCharFrame()).not.toContain("private-typed-value")
          // A valid override admits only automatic discovery, which entering the
          // editor may retire before its GET is sent.
          if (override === "valid") {
            expect(fixture.hits.every((hit) => hit.method === "GET" && hit.path === "/v1/models")).toBe(true)
            expect(fixture.hits.length).toBeLessThanOrEqual(1)
          } else {
            expect(fixture.hits).toEqual([])
          }
          await clickEndpointControl(setup, "[Esc Discard]")
          await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /"))
        } finally { setup.renderer.destroy() }
      })
    }, 20_000)
  }

  for (const width of [80, 100, 140]) for (const ascii of [false, true]) {
    test(`endpoint modal editor preserves normal drafts at ${width} columns ${ascii ? "ASCII" : "Unicode"}`, async () => {
      await withLocalEnvironment(async (fixture, root) => {
        delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
        const previous = process.env.NO_UNICODE
        if (ascii) process.env.NO_UNICODE = "1"
        else delete process.env.NO_UNICODE
        const setup = await mountWorkbench({ width, height: 8, trustedWorkdir: root, session: fixtureSession() })
        try {
          await setup.mockInput.typeText("untouched prompt")
          for (const editor of ["composer", "prompt", "context", "command"] as const) {
            if (editor === "command") {
              setup.mockInput.pressEnter()
              await pumpUntilFrame(setup, (frame) => frame.includes("echo candidate-0"))
            }
            if (editor !== "composer") {
              setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey(editor === "context" ? "c" : "e")
              await pumpUntilFrame(setup, (frame) => frame.includes("^X W save"))
              await setup.mockInput.typeText(`-${editor}-draft`)
              await setup.renderOnce()
            }
            const before = setup.captureCharFrame()
            await openEndpoint(setup)
            await replaceEndpoint(setup, fixture.endpoint)
            for (const key of ["e", "c", "n", "m", "s", "d", "a", "g", "i", "h"]) {
              setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey(key)
            }
            setup.mockInput.pressTab()
            setup.mockInput.pressEnter()
            await setup.mockMouse.click(5, footerRenderOffset(setup.renderer), MouseButtons.LEFT)
            await setup.renderOnce()
            expect(setup.captureCharFrame()).toContain("Local endpoint /")
            expect(setup.captureCharFrame()).toContain(fixture.endpoint)
            expect(fixture.posts).toEqual([])
            expect(existsSync(setup.resultPath)).toBe(false)
            await clickEndpointControl(setup, "[^X W Save]")
            const restored = await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /"))
            expect(restored).not.toContain(fixture.endpoint)
            if (editor === "composer") expect(restored).toContain("untouched prompt")
            else {
              expect(restored).toContain(`-${editor}-draft`)
              expect(before).toContain(`-${editor}-draft`)
              setup.mockInput.pressEscape()
              await pumpUntilFrame(setup, (frame) => !frame.includes("^X W save"))
            }
          }
          await openEndpoint(setup)
          await clickEndpointControl(setup, "[^X R Reset]")
          await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /"))
          expect(readPersistedInferenceDocument()?.localEndpoint).toBeUndefined()
        } finally {
          setup.renderer.destroy()
          if (previous === undefined) delete process.env.NO_UNICODE
          else process.env.NO_UNICODE = previous
        }
      })
    }, 30_000)
  }

  test("endpoint change retires held discovery and requires fresh same-ID activation at the new listener", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const second = await startLocalFixture()
      delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      writePersistedLocalEndpoint(fixture.endpoint, LOCAL_PROVIDER_ID)
      let held: ServerResponse | null = null
      fixture.onModels = (response) => { held = response }
      const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session: localSession() })
      try {
        await setup.mockInput.typeText("list files")
        await beginLocalCheck(setup)
        await pumpUntilFrame(setup, () => held !== null)
        const child = setup.active.discoveryProcess as unknown as { pid: number; exited: Promise<number> }
        await setup.mockInput.typeText("configure local")
        await pumpUntilFrame(setup, (frame) => frame.includes("Configure local endpoint"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("Local endpoint /"))
        await replaceEndpoint(setup, second.endpoint)
        setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey("w")
        await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /"))
        await child.exited
        expect(processIsGone(child.pid)).toBe(true)
        ;(held as unknown as ServerResponse).end(JSON.stringify({ object: "list", data: [{ id: CATALOG[0] }] }))
        expect(second.hits).toEqual([])
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("no local model is active"))
        await checkLocalModels(setup)
        await chooseLocalModel(setup)
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("› 1  ls -la") && setup.active.process === null, { tries: 160 })
        expect(second.hits).toHaveLength(3)
        expect(fixture.hits).toHaveLength(1)
      } finally { setup.renderer.destroy(); await setup.active.closing; await second.close() }
    })
  }, 30_000)

  test("endpoint save rechecks newly invalid settings and failed repair remains invocation-only", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      writePersistedLocalEndpoint("http://127.0.0.1:1/v1", null)
      const session = fixtureSession()
      prepareProviderSession(session)
      const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session })
      try {
        await setup.mockInput.typeText("still usable")
        await openEndpoint(setup)
        await replaceEndpoint(setup, fixture.endpoint)
        writeFileSync(inferenceSettingsFile(), "newly-corrupted-private-settings")
        setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey("w")
        await pumpUntilFrame(setup, (frame) => frame.includes("Replace unreadable saved settings?"))
        expect(readFileSync(inferenceSettingsFile(), "utf8")).toBe("newly-corrupted-private-settings")
        const target = join(root, "safe-target")
        writeFileSync(target, "private-target-contents")
        unlinkSync(inferenceSettingsFile())
        symlinkSync(target, inferenceSettingsFile())
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /"))
        expect(readFileSync(target, "utf8")).toBe("private-target-contents")
        expect(session.localEndpoint).toEqual({ endpoint: fixture.endpoint, source: "not saved", readOnly: false })
        await openDoctorViaAction(setup)
        const doctor = await pumpUntilFrame(setup, (frame) => frame.includes("WARN settings"))
        expect(doctor).toContain("settings not saved; in-memory configuration active")
        expect(doctor).not.toContain(fixture.endpoint)
        setup.mockInput.pressEscape()
        await pumpUntilFrame(setup, (frame) => !frame.includes("WARN settings"))
        setup.mockInput.pressKey("x", { ctrl: true }); setup.mockInput.pressKey("m")
        await pumpUntilFrame(setup, (frame) => frame.includes("Search Models:"))
        await setup.mockInput.typeText("gpt-5.6-luna")
        await pumpUntilFrame(setup, (frame) => frame.includes("Search Models: gpt-5.6-luna"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Search Models:"))
        expect(session.model).toBe("gpt-5.6-luna")
        expect(readFileSync(target, "utf8")).toBe("private-target-contents")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("echo candidate-0"))
        expect(fixture.hits).toEqual([])
        const reopened = fixtureSession()
        prepareProviderSession(reopened)
        expect(reopened.localEndpoint?.endpoint).toBeNull()
        unlinkSync(inferenceSettingsFile())
        await openEndpoint(setup)
        expect(setup.captureCharFrame()).toContain("Local endpoint / not saved")
        await clickEndpointControl(setup, "[^X W Save]")
        await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /"))
        expect(readPersistedInferenceDocument()?.localEndpoint).toBe(fixture.endpoint)
      } finally { setup.renderer.destroy() }
    })
  }, 30_000)

  test("endpoint save before activation reopens through Command and review-only insertion", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      const first = localSession()
      prepareProviderSession(first)
      const setup = await mountWorkbench({ width: 100, height: 8, trustedWorkdir: root, session: first })
      try {
        await setup.mockInput.typeText("preserved command")
        await openEndpoint(setup)
        await replaceEndpoint(setup, fixture.endpoint)
        setup.mockInput.pressEnter()
        await setup.renderOnce()
        expect(setup.captureCharFrame()).toContain("Local endpoint /")
        setup.mockInput.pressKey("x", { ctrl: true })
        setup.mockInput.pressKey("w")
        await pumpUntilFrame(setup, (frame) => !frame.includes("Local endpoint /") && frame.includes("preserved command"))
        expect(readPersistedInferenceDocument()?.localEndpoint).toBe(fixture.endpoint)
        expect(readPersistedInferenceDocument()?.providers).toEqual({})
        expect(fixture.hits).toEqual([])
      } finally { setup.renderer.destroy() }
      const reopened = localSession()
      prepareProviderSession(reopened)
      expect(reopened.localEndpoint?.endpoint).toBe(fixture.endpoint)
      const again = await mountWorkbench({ width: 100, height: 8, trustedWorkdir: root, session: reopened })
      try {
        await again.mockInput.typeText("list files")
        expect(fixture.hits).toEqual([])
        await checkLocalModels(again)
        await chooseLocalModel(again)
        again.mockInput.pressEnter()
        await pumpUntilFrame(again, (frame) => frame.includes("› 1  ls -la") && again.active.process === null, { tries: 160 })
        expect(fixture.hits).toEqual([
          { method: "GET", path: "/v1/models" },
          { method: "GET", path: "/v1/models" },
          { method: "POST", path: "/v1/chat/completions" },
        ])
        expect(JSON.stringify(fixture.posts)).not.toContain(fixture.endpoint)
        expect(existsSync(again.resultPath)).toBe(false)
        again.mockInput.pressEnter()
        await pumpUntilFrame(again, () => existsSync(again.resultPath))
        expect(readFileSync(again.resultPath, "utf8")).toContain("ls -la")
        expect(readFileSync(again.resultPath, "utf8")).not.toContain(fixture.endpoint)
      } finally { again.renderer.destroy() }
    })
  }, 30_000)

  test("endpoint draft never reaches search or stale native composer callbacks", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      const observedQueries: string[] = []
      const observedRecords: string[] = []
      const rank = workbenchBindings.settingsPickerCandidates
      const ranking = spyOn(workbenchBindings, "settingsPickerCandidates").mockImplementation((query, sources) => {
        observedQueries.push(query)
        observedRecords.push(JSON.stringify(sources))
        return rank(query, sources)
      })
      const setup = await mountWorkbench({ width: 100, height: 8, trustedWorkdir: root, session: fixtureSession() })
      const findComposer = (node: any): any => {
        if (node?.editBuffer && typeof node.onSubmit === "function") return node
        for (const child of node?.getChildren?.() ?? []) {
          const found = findComposer(child)
          if (found) return found
        }
        return null
      }
      try {
        await setup.mockInput.typeText("private draft stays here")
        const composer = findComposer(setup.renderer.root)
        expect(composer?.onSubmit).toBeFunction()
        const lateSubmit = composer.onSubmit
        const lateChange = composer.onContentChange
        await openEndpoint(setup)
        await replaceEndpoint(setup, fixture.endpoint)
        lateChange({})
        lateSubmit({})
        await setup.mockInput.pressKeys(["\u0018a\u0018e\r"])
        await setup.renderOnce()
        expect(setup.active.process).toBeNull()
        expect(setup.captureCharFrame()).toContain("Local endpoint /")
        expect(existsSync(setup.resultPath)).toBe(false)
        await clickEndpointControl(setup, "[Esc Discard]")
        await pumpUntilFrame(setup, (frame) => frame.includes("private draft stays here"))
        expect(observedQueries.length).toBeGreaterThan(0)
        expect(JSON.stringify(observedQueries)).not.toContain(fixture.endpoint)
        expect(JSON.stringify(observedRecords)).not.toContain(fixture.endpoint)
        expect(readPersistedInferenceDocument()?.localEndpoint).toBeUndefined()
        expect(fixture.hits).toEqual([])
      } finally { ranking.mockRestore(); setup.renderer.destroy() }
    })
  }, 20_000)

  test("saved and refreshed sole local model reselection activates and Effort returns to the draft", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      fixture.catalog = [CATALOG[0]]
      writePersistedInferenceSettings(CATALOG[0], "n/a", process.env, LOCAL_PROVIDER_ID)
      for (const restart of [false, true]) {
        const session = localSession({ model: readPersistedInferenceSettings(process.env, LOCAL_PROVIDER_ID)!.model })
        const setup = await mountWorkbench({ width: 120, height: 8, trustedWorkdir: root,
          session })
        try {
          await setup.mockInput.typeText(restart ? "restart draft" : "refresh draft")
          setup.mockInput.pressEnter()
          await pumpUntilFrame(setup, (frame) => frame.includes("› 1  ls -la") && setup.active.process === null, { tries: 160 })
          expect(fixture.posts).toHaveLength(restart ? 2 : 1)
          await checkLocalModels(setup, 1)
          await chooseLocalModel(setup)
          if (!restart) {
            await checkLocalModels(setup, 1)
            await chooseLocalModel(setup)
          }
          expect(session.model).toBe(CATALOG[0])
          expect(existsSync(setup.resultPath)).toBe(false)
        } finally { setup.renderer.destroy() }
      }
    })
  }, 30_000)

  test("local Ask discloses one-shot limits and loopback trust before and after answering", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const setup = await mountWorkbench({ width: 100, height: 12, trustedWorkdir: root, session: localSession({ initial_intent: "ask" }) })
      const inspect = async () => {
        setup.mockInput.pressKey("x", { ctrl: true })
        setup.mockInput.pressKey("h")
        const frame = await pumpUntilFrame(setup, frame => frame.includes("Ask history"))
        expect(frame).toContain("repository access")
        expect(frame).toContain("unavailable · prompt/context only")
        expect(frame).toContain("one-shot; no pointer")
        expect(frame).toContain("same-user process: intercept prompts; forge valid results")
        expect(frame).not.toContain(fixture.endpoint)
        setup.mockInput.pressEscape()
        await pumpUntilFrame(setup, frame => !frame.includes("Ask history"))
      }
      try {
        expect(setup.captureCharFrame()).toContain("Ask a local question")
        await inspect()
        expect(fixture.hits).toEqual([])
        await setup.mockInput.typeText("a standalone question")
        await checkLocalModels(setup)
        await chooseLocalModel(setup)
        expect(setup.captureCharFrame()).not.toContain("endpoint default")
        let held: ServerResponse | undefined
        fixture.onCompletion = response => { held = response }
        setup.mockInput.pressEnter()
        const loading = await pumpUntilFrame(setup, frame => !!held && frame.includes("asking qwen3-coder-30b-a3b-instruct"), { tries: 160 })
        expect(loading).not.toContain("new chat")
        held!.writeHead(200, { "Content-Type": "text/event-stream" })
        held!.end(asConformingStream(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"answer":"independent answer"}' }, finish_reason: "stop" }] }), fixture.posts.at(-1)!))
        const answered = await pumpUntilFrame(setup, frame => frame.includes("independent answer") && setup.active.process === null, { tries: 160 })
        expect(answered).not.toContain("follow up")
        expect(answered).not.toContain("follow-up")
        expect(answered).toContain("Ask a local question")
        await inspect()
        expect(JSON.stringify(fixture.posts)).not.toContain("endpoint default")
        expect(existsSync(setup.resultPath)).toBe(false)
      } finally { setup.renderer.destroy() }
    })
  }, 20_000)

  for (const mode of ["ask", "correct"] as const) {
    test(`local ${mode} uses the real request path without a pointer or result write`, async () => {
      await withLocalEnvironment(async (fixture, root) => {
        fixture.completion = () => JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(
          mode === "ask" ? { answer: "local one-shot answer" } : {
            tldr: "No safe repair is known", corrected_command: null, confidence: 0.2, risk: "unknown",
          }) }, finish_reason: "stop" }] })
        const setup = await mountWorkbench({ width: 120, height: 8, trustedWorkdir: root,
          askSessionFile: join(root, "must-not-create-pointer"),
          session: localSession({ initial_intent: mode, actionable_failure: true }) })
        try {
          await setup.mockInput.typeText("first local question")
          await checkLocalModels(setup)
          await chooseLocalModel(setup)
          setup.mockInput.pressEnter()
          await pumpUntilFrame(setup, (frame) => frame.includes(mode === "ask" ? "local one-shot answer" : "No safe repair is known"), { tries: 160 })
          expect(fixture.posts[0].response_format.json_schema.name).toBe(mode === "ask" ? "shellq_ask_v1" : "shellq_fix_v1")
          expect(existsSync(setup.resultPath)).toBe(false)
          expect(existsSync(join(root, "must-not-create-pointer"))).toBe(false)
          expect(setup.captureCharFrame()).not.toContain("insert")
          if (mode === "ask") {
            await setup.mockInput.typeText("second local question")
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, () => fixture.posts.length === 2 && setup.active.process === null, { tries: 160 })
            expect(JSON.stringify(fixture.posts[1])).not.toContain("first local question")
            expect(JSON.stringify(fixture.posts[1])).not.toContain("local one-shot answer")
          }
        } finally { setup.renderer.destroy() }
      })
    }, 30_000)
  }

  for (const failure of [
    { status: 404, message: "local model is gone" },
    { status: 400, message: "local model rejected request", blocked: "model" },
    { status: 200, message: "local completion is malformed", blocked: "model", body: "private malformed body" },
    { status: 408, message: "local request timed out" },
    { status: 429, message: "local rate limit" },
    { status: 503, message: "local server failed" },
    { status: 503, message: "local server failed", framing: "malformed" },
    { status: 503, message: "local server failed", framing: "oversized" },
    { status: 503, message: "local server failed", framing: "premature" },
    { status: 200, message: "local connection lost", framing: "premature" },
  ]) {
    test(`local completion ${failure.message} ${"framing" in failure ? failure.framing : ""} is redacted and has the required retry scope`, async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const validCompletion = fixture.completion
        fixture.completionStatus = failure.status
        fixture.completion = () => failure.body ?? "private server failure body"
        if ("framing" in failure) fixture.onCompletion = response => {
          const body = failure.framing === "malformed" ? "Transfer-Encoding: chunked\r\n\r\ninvalid\r\nprivate"
            : failure.framing === "oversized" ? `Content-Length: 200000\r\n\r\n${"private".repeat(30000)}`
            : "Content-Length: 1000\r\n\r\nprivate"
          response.socket!.end(`HTTP/1.1 ${failure.status} ${failure.status === 200 ? "OK" : "Failed"}\r\n${body}`)
        }
        const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session: localSession() })
        try {
          await setup.mockInput.typeText("list files")
          await checkLocalModels(setup)
          await chooseLocalModel(setup)
          setup.mockInput.pressEnter()
          const failed = await pumpUntilFrame(setup, (frame) => frame.includes(failure.message), { tries: 160 })
          expect(failed).not.toContain("private")
          expect(failed).not.toContain("provider exited")
          expect(existsSync(setup.resultPath)).toBe(false)
          fixture.completionStatus = 200
          fixture.completion = validCompletion
          fixture.onCompletion = undefined
          if (failure.blocked) {
            const before = fixture.hits.length
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("no local model is active"))
            expect(fixture.hits.length).toBe(before)
            setup.mockInput.pressKey("x", { ctrl: true })
            setup.mockInput.pressKey("s")
            await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
            // Entering Settings runs the automatic probe; let it publish first so
            // the blocked selection below is the only remaining action.
            await pumpUntilFrame(setup, (frame) => frame.includes("2 local models"), { tries: 160 })
            const probed = fixture.hits.length
            await setup.mockInput.typeText(CATALOG[0])
            const blocked = await pumpUntilFrame(setup, (frame) =>
              frame.includes(`Search All: ${CATALOG[0]}`) && frame.includes("blocked"),
            )
            expect(blocked).toContain("blocked")
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("local model is blocked"))
            expect(fixture.hits.length).toBe(probed)
            if (failure.blocked === "model") {
              await closePalette(setup)
              setup.mockInput.pressKey("x", { ctrl: true })
              setup.mockInput.pressKey("s")
              await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
              await chooseLocalModel(setup, "gemma")
            } else {
              await closePalette(setup)
              await checkLocalModels(setup)
              await chooseLocalModel(setup)
            }
          }
          setup.mockInput.pressEnter()
          await pumpUntilFrame(setup, (frame) => frame.includes("› 1  ls -la") && setup.active.process === null, { tries: 160 })
          expect(fixture.posts).toHaveLength(2)
          if (failure.blocked === "model") {
            expect(fixture.posts[1].model).toBe(CATALOG[1])
            await checkLocalModels(setup)
            await chooseLocalModel(setup)
            expect(readPersistedInferenceSettings(process.env, LOCAL_PROVIDER_ID)?.model).toBe(CATALOG[0])
          }
        } finally { setup.renderer.destroy() }
      })
    }, 30_000)
  }

  test("local discovery projects distinct fixed failures without probing from Setup or Doctor", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session: localSession() })
      try {
        for (const [status, message, body] of [
          [401, "local authentication is unsupported", "private auth body"],
          [404, "local protocol mismatch", "private models body"],
          [200, "local catalog is malformed", "private malformed catalog"],
          [503, "local server failed", "private server body"],
          [200, "no local endpoint advertises a usable model", '{"object":"list","data":[]}'],
        ] as const) {
          fixture.onModels = (res) => { res.writeHead(status); res.end(body) }
          await beginLocalCheck(setup)
          const frame = await pumpUntilFrame(setup, (frame) => frame.includes(message), { tries: 160 })
          expect(frame).not.toContain("private")
          await closePalette(setup)
          const hits = fixture.hits.length
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("p")
          await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup |"))
          setup.mockInput.pressEscape()
          await pumpUntilFrame(setup, (frame) => !frame.includes("Provider Setup |"))
          await openDoctorViaAction(setup)
          setup.mockInput.pressEscape()
          await pumpUntilFrame(setup, (frame) => !frame.includes("Ask pointer"))
          expect(fixture.hits.length).toBe(hits)
        }
      } finally { setup.renderer.destroy() }
    })
  }, 30_000)

  for (const cancellation of ["Escape", "Ctrl-C", "destroy", "teardown"] as const) {
    test(`local discovery ${cancellation} confirms exit and refuses late publication`, async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const responses: ServerResponse[] = []
        fixture.onModels = (response) => { responses.push(response) }
        const setup = await mountWorkbench({ width: 120, height: 8, trustedWorkdir: root, session: localSession() })
        try {
          await beginLocalCheck(setup)
          await pumpUntilFrame(setup, () => responses.length === 1, { tries: 160 })
          const child = setup.active.discoveryProcess as unknown as { pid: number; exited: Promise<number> }
          expect(child).toBeDefined()
          expect(setup.active.process).toBeNull()
          expect(setup.active.discoveryCancel).toBeFunction()
          expect(setup.active.cancel).toBeUndefined()
          if (cancellation === "Escape") setup.mockInput.pressEscape()
          else if (cancellation === "Ctrl-C") setup.mockInput.pressKey("c", { ctrl: true })
          else if (cancellation === "destroy") setup.renderer.destroy()
          else setup.active.discoveryCancel?.()
          await setup.active.discoveryClosing
          await child.exited
          expect(processIsGone(child.pid)).toBe(true)
          responses[0].end(JSON.stringify({ object: "list", data: [{ id: "stale-only-model" }] }))
          if (cancellation === "Escape" || cancellation === "teardown") {
            if (cancellation === "Escape") await pumpUntilFrame(setup, (frame) => !frame.includes("Search All:"))
            else await closePalette(setup)
            await beginLocalCheck(setup)
            await pumpUntilFrame(setup, () => responses.length === 2, { tries: 160 })
            expect(setup.active.discoveryProcess).not.toBeNull()
            responses[1].end(JSON.stringify({ object: "list", data: [{ id: CATALOG[0] }] }))
            await pumpUntilFrame(setup, (frame) => frame.includes("1 local model"), { tries: 160 })
            await setup.mockInput.typeText("stale-only")
            const frame = await pumpUntilFrame(setup, (frame) => frame.includes("Search All: stale-only"))
            expect(frame.split("\n").slice(2, 7).join("\n")).not.toContain("stale-only-model")
          }
          expect(fixture.posts).toEqual([])
        } finally { setup.renderer.destroy(); await setup.active.discoveryClosing }
      })
    }, 30_000)
  }

  test("refresh during apply preserves unchanged exact selectable tuple", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      writePersistedInferenceSettings(CATALOG[1], "n/a", process.env, LOCAL_PROVIDER_ID)
      const session = localSession({ model: CATALOG[1] })
      const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session })
      let releaseRetirement = () => {}
      try {
        await setup.mockInput.typeText("preserve stale draft")
        await checkLocalModels(setup)
        await closePalette(setup)
        let response: ServerResponse | undefined
        fixture.onModels = (res) => { response = res }
        await beginLocalCheck(setup)
        await pumpUntilFrame(setup, () => response !== undefined, { tries: 160 })
        const child = setup.active.discoveryProcess as unknown as { exited: Promise<number> }
        expect(child).toBeDefined()
        expect(setup.active.process).toBeNull()
        setup.active.closing = new Promise<void>((resolve) => { releaseRetirement = resolve })
        await setup.mockInput.typeText("a3b")
        await pumpUntilFrame(setup, (frame) => frame.includes("Search All: a3b"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("Applying Local/qwen3"))
        // Staged catalog arrives during apply containing the exact selected model
        response!.end(JSON.stringify({ object: "list", data: [{ id: CATALOG[0] }] }))
        await child.exited
        await pumpUntilFrame(setup, () => setup.active.discoveryProcess === null)
        releaseRetirement()
        // Mid-apply refresh preserves unchanged exact selectable tuple
        await pumpUntilFrame(setup, (frame) => !frame.includes("Applying Local/qwen3"), { tries: 160 })
        expect(session.model).toBe(CATALOG[0])
        expect(readPersistedInferenceSettings(process.env, LOCAL_PROVIDER_ID)?.model).toBe(CATALOG[0])
      } finally { releaseRetirement(); setup.renderer.destroy(); await setup.active.closing }
    })
  }, 30_000)

  for (const route of ["palette", "Setup keyboard", "Setup pointer"] as const) {
    test(`local discovery cannot publish after provider change through ${route}`, async () => {
      await withLocalEnvironment(async (fixture, root) => {
        writeFileSync(join(root, "bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
        const session = localSession()
        const setup = await mountWorkbench({ width: 140, height: 8, trustedWorkdir: root, session })
        try {
          await setup.mockInput.typeText("provider draft")
          await checkLocalModels(setup)
          await chooseLocalModel(setup)
          let response: ServerResponse | undefined
          fixture.onModels = (res) => { response = res }
          await beginLocalCheck(setup)
          await pumpUntilFrame(setup, () => response !== undefined, { tries: 160 })
          const child = setup.active.discoveryProcess as unknown as { pid: number; exited: Promise<number> }
          expect(child).toBeDefined()
          expect(setup.active.process).toBeNull()
          if (route === "palette") {
            await setup.mockInput.typeText("Claude")
            await pumpUntilFrame(setup, (frame) => frame.includes("Search All: Claude"))
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, () => session.provider_id === "claude")
            await closePalette(setup)
          } else {
            await setup.mockInput.typeText("Provider Setup")
            await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup · More settings"))
            setup.mockInput.pressEnter()
            await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup |"))
            if (route === "Setup keyboard") setup.mockInput.pressArrow("right")
            else {
              const frame = setup.captureCharFrame().split("\n")
              const row = frame.findIndex((line) => line.includes("[local-openai]"))
              const column = frame[row].indexOf("claude")
              expect(column).toBeGreaterThan(0)
              await setup.mockMouse.click(column, footerRenderOffset(setup.renderer) + row, MouseButtons.LEFT)
            }
            await pumpUntilFrame(setup, () => session.provider_id === "claude")
            setup.mockInput.pressEscape()
            await pumpUntilFrame(setup, (frame) => !frame.includes("Provider Setup |"))
          }
          await setup.active.discoveryClosing
          await child.exited
          expect(processIsGone(child.pid)).toBe(true)
          const lateSentinel = "late-only-local-sentinel"
          response!.end(JSON.stringify({ object: "list", data: [{ id: lateSentinel }] }))
          expect(setup.captureCharFrame()).toContain("provider draft")
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("s")
          await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
          await setup.mockInput.typeText("local")
          const frame = await pumpUntilFrame(setup, (frame) => frame.includes("Search All: local") && frame.includes("Check local models"))
          expect(frame).toContain("Check local models")
          expect(frame).not.toContain(lateSentinel)
          expect(frame.split("\n").slice(2, 7).join("\n")).toContain(CATALOG[0])
          expect(fixture.posts).toEqual([])
        } finally { setup.renderer.destroy(); await setup.active.discoveryClosing }
      })
    }, 30_000)
  }

  test(
    "opening the workbench, Setup, Doctor, and the palette sends zero HTTP",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const testSetup = await mountWorkbench({
          height: 8,
          session: localSession(),
          trustedWorkdir: root,
          width: 100,
        })
        try {
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Command"))
          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("p")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Provider Setup |"))
          expect(testSetup.captureCharFrame()).toContain("Local managed AVAILABLE")
          testSetup.mockInput.pressEscape()
          await pumpUntilFrame(testSetup, (frame) => !frame.includes("Provider Setup |"))
          await openDoctorViaAction(testSetup)
          // Local Ask keeps no pointer at all, so the cached Doctor row must
          // report the one-shot truth without Doctor learning about local.
          expect(testSetup.captureCharFrame()).toContain("one-shot; no pointer required")
          testSetup.mockInput.pressEscape()
          await pumpUntilFrame(testSetup, (frame) => !frame.includes("Ask pointer"))
          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("s")
          const palette = await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
          expect(palette).toContain("Set model")
          await pumpUntilFrame(testSetup, () => fixture.hits.length === 1)
          expect(fixture.hits).toEqual([{ method: "GET", path: "/v1/models" }])
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    30_000,
  )

  test(
    "with no active model the palette offers only the check, never a local provider leaf",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const testSetup = await mountWorkbench({
          height: 8,
          session: localSession(),
          trustedWorkdir: root,
          width: 100,
        })
        try {
          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("s")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
          await testSetup.mockInput.typeText("local")
          const filtered = await pumpUntilFrame(
            testSetup,
            (frame) => frame.includes("Search All: local") && frame.includes("Check local models"),
          )
          // Body rows only: the top rail names the active provider, which is
          // not a palette leaf.
          const body = filtered.split("\n").slice(2, 7).join("\n")
          expect(body).not.toContain("Local/")
          expect(body).not.toContain("local-openai")
          await pumpUntilFrame(testSetup, () => fixture.hits.length === 1)
          expect(fixture.hits).toEqual([{ method: "GET", path: "/v1/models" }])
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    30_000,
  )

  test(
    "submitting without an active local model is refused with zero process spawn",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const session = localSession({ model: "" })
        const testSetup = await mountWorkbench({
          height: 8,
          session,
          trustedWorkdir: root,
          width: 100,
        })
        try {
          await testSetup.mockInput.typeText("list files")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) =>
            frame.includes("no local model is active"),
          )
          expect(testSetup.active.process).toBeNull()
          expect(fixture.hits).toEqual([])
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    30_000,
  )

  test(
    "saved local reopen directly submits with preflight GET and one POST",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        writePersistedInferenceSettings(
          "qwen3-coder-30b-a3b-instruct",
          "endpoint default",
          process.env,
          LOCAL_PROVIDER_ID,
        )
        const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
        const testSetup = await mountWorkbench({
          height: 8,
          session,
          trustedWorkdir: root,
          width: 100,
        })
        try {
          expect(readPersistedInferenceSettings(process.env, LOCAL_PROVIDER_ID))
            .toEqual({ model: "qwen3-coder-30b-a3b-instruct", reasoning: "endpoint default" })
          await testSetup.mockInput.typeText("list files")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  ls -la") && testSetup.active.process === null, { tries: 160 })
          // Direct submission: one preflight GET and one POST, without opening picker
          expect(fixture.hits).toEqual([
            { method: "GET", path: "/v1/models" },
            { method: "POST", path: "/v1/chat/completions" },
          ])
          expect(fixture.posts).toHaveLength(1)
          expect(fixture.posts[0].model).toBe("qwen3-coder-30b-a3b-instruct")
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    30_000,
  )

  test(
    "an explicit check, a typed substring, and one activation drive a real Command turn",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const session = localSession()
        const testSetup = await mountWorkbench({
          height: 8,
          session,
          trustedWorkdir: root,
          width: 100,
        })
        try {
          const resultAuthority = "untouched"
          writeFileSync(testSetup.resultPath, resultAuthority, { mode: 0o600 })
          await testSetup.mockInput.typeText("list files")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))

          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("s")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
          await testSetup.mockInput.typeText("check local")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Check local models"))
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), {
            tries: 120,
          })
          // Exactly one fresh GET for the explicit check, and no POST.
          expect(fixture.hits).toEqual([{ method: "GET", path: "/v1/models" }])

          // A distinctive substring of the target model, not its full name.
          await testSetup.mockInput.typeText("a3b")
          await pumpUntilFrame(
            testSetup,
            (frame) =>
              frame.includes("Search All: a3b") &&
              frame.includes("qwen3-coder-30b-a3b-instruct"),
          )
          // The focused row is the exact model, and its provider column names
          // the local provider.
          const focused = focusedSelectionLine(testSetup)
          const focusedText = focused?.spans.map((span) => span.text).join("") ?? ""
          expect(focusedText).toContain("qwen3-coder-30b-a3b-instruct")
          expect(focusedText).toContain("Local")
          testSetup.mockInput.pressEnter()
          // The status line truncates the long id, so match its stable prefix.
          await pumpUntilFrame(testSetup, (frame) =>
            frame.includes("Applied Local/qwen3"),
          )
          expect(session.provider_id).toBe(LOCAL_PROVIDER_ID)
          expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")
          await closePalette(testSetup)

          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  ls -la") && testSetup.active.process === null, { tries: 160 })
          // The activated turn: one fresh private preflight GET, then one POST.
          expect(fixture.hits).toEqual([
            { method: "GET", path: "/v1/models" },
            { method: "GET", path: "/v1/models" },
            { method: "POST", path: "/v1/chat/completions" },
          ])
          expect(fixture.posts).toHaveLength(1)
          expect(fixture.posts[0].model).toBe("qwen3-coder-30b-a3b-instruct")
          expect(fixture.posts[0].stream).toBe(true)
          expect(fixture.posts[0].response_format.json_schema.name).toBe("shellq_command_v1")
          // Review-only: the candidate is displayed, never executed, and the
          // parent's result file is still untouched.
          expect(readFileSync(testSetup.resultPath, "utf8")).toBe(resultAuthority)
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    60_000,
  )

  // Reaches "activated, request in flight against a deliberately stubborn
  // adapter". The adapter itself already traps and honours every signal (its
  // own suite proves that); this installs one that does NOT, which is the only
  // way to observe whether the PARENT escalates or merely asks.
  const startStubbornLocalTurn = async (
    fixture: LocalFixture,
    root: string,
  ) => {
    const stubborn = join(root, "stubborn-adapter.zsh")
    const ready = join(root, "stubborn-ready")
    // `exec`s itself into a single process, exactly as the real shim does, so
    // no intermediate shell can survive holding the stdout pipe open — then
    // ignores every termination signal and reports readiness through a file so
    // the test can wait for the handlers instead of racing them.
    const stubbornBody = [
      "process.on(\"SIGTERM\", () => {});",
      "process.on(\"SIGINT\", () => {});",
      "process.on(\"SIGHUP\", () => {});",
      `await Bun.write(${JSON.stringify(ready)}, "1");`,
      "await Bun.stdin.text();",
      "await new Promise((resolve) => setTimeout(resolve, 60000));",
    ].join(" ")
    writeFileSync(stubborn, `#!/bin/sh\nexec bun -e '${stubbornBody}'\n`, { mode: 0o700 })
    chmodSync(stubborn, 0o700)
    const session = localSession()
    const testSetup = await mountWorkbench({
      height: 8,
      session,
      trustedWorkdir: root,
      width: 100,
    })
    await testSetup.mockInput.typeText("list files")
    await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))
    testSetup.mockInput.pressKey("x", { ctrl: true })
    testSetup.mockInput.pressKey("s")
    await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
    await testSetup.mockInput.typeText("check local")
    await pumpUntilFrame(testSetup, (frame) => frame.includes("Check local models"))
    testSetup.mockInput.pressEnter()
    await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), { tries: 120 })
    await testSetup.mockInput.typeText("a3b")
    await pumpUntilFrame(testSetup, (frame) => frame.includes("qwen3-coder-30b-a3b-instruct"))
    testSetup.mockInput.pressEnter()
    await pumpUntilFrame(testSetup, (frame) => frame.includes("Applied Local/qwen3"))
    await closePalette(testSetup)
    // Swap in the stubborn adapter for the submitted turn only; discovery and
    // activation above ran against the real shim.
    session.provider = [stubborn]
    testSetup.mockInput.pressEnter()
    await pumpUntilFrame(testSetup, () => testSetup.active.process !== null, { tries: 120 })
    const child = testSetup.active.process as unknown as { pid: number }
    expect(child.pid).toBeGreaterThan(0)
    await pumpUntilFrame(testSetup, () => existsSync(ready), { tries: 200, delayMs: 25 })
    return { child, testSetup }
  }

  const processIsGone = (pid: number) => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
      throw error
    }
  }

  test(
    "Escape force-kills an adapter that ignores the graceful signal and awaits its exit",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const { child, testSetup } = await startStubbornLocalTurn(fixture, root)
        try {
          const started = Date.now()
          testSetup.mockInput.pressEscape()
          // `active.process` is only cleared in the request's `finally`, which
          // runs after the child has actually exited — so this frame cannot be
          // reached by a merely-requested termination.
          await pumpUntilFrame(
            testSetup,
            () => testSetup.active.process === null,
            { tries: 200, delayMs: 50 },
          )
          expect(Date.now() - started).toBeGreaterThanOrEqual(LOCAL_TERMINATION_GRACE_MS)
          expect(processIsGone(child.pid)).toBe(true)
          expect(fixture.posts).toEqual([])
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    60_000,
  )

  test(
    "teardown's cancel-then-await-closing contract reaps a stubborn adapter",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const { child, testSetup } = await startStubbornLocalTurn(fixture, root)
        try {
          // Exactly what `run()`'s renderer `onDestroy` does, followed by the
          // `await active.closing` it performs once the renderer is destroyed.
          testSetup.active.cancel?.()
          testSetup.active.process?.kill()
          expect(testSetup.active.closing).not.toBeNull()
          await testSetup.active.closing
          expect(processIsGone(child.pid)).toBe(true)
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    60_000,
  )

  for (const cancellation of ["Ctrl-C", "terminal hangup"] as const) {
    test(`real terminal ${cancellation} reaps a stubborn local adapter and its socket`, async () => {
      const tmuxPath = Bun.which("tmux")
      expect(tmuxPath).not.toBeNull()
      await withLocalEnvironment(async (fixture, root) => {
        const socketPath = join(root, "terminal.sock")
        const sessionFile = join(root, "terminal-session.json")
        const resultFile = join(root, "terminal-result.json")
        const parentFile = join(root, "terminal-parent.pid")
        const childFile = join(root, "terminal-child.pid")
        const preload = join(root, "terminal-preload.ts")
        const stubborn = join(root, "terminal-stubborn.ts")
        writeFileSync(stubborn, `
          import { createConnection } from "node:net";
          import { writeFileSync } from "node:fs";
          for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
          const socket = createConnection({ host: "127.0.0.1", port: ${new URL(fixture.endpoint).port} });
          socket.on("connect", () => writeFileSync(${JSON.stringify(childFile)}, String(process.pid)));
          await Bun.stdin.text();
          await new Promise(resolve => setTimeout(resolve, 60000));
        `)
        writeFileSync(preload, `
          import { spyOn } from "bun:test";
          import { writeFileSync } from "node:fs";
          writeFileSync(${JSON.stringify(parentFile)}, String(process.pid));
          const spawn = Bun.spawn;
          spyOn(Bun, "spawn").mockImplementation((cmd, options) => spawn(
            cmd[0] === ${JSON.stringify(LOCAL_ADAPTER)} && options?.env?.SHELLQ_LOCAL_OPENAI_MODEL
              ? [process.execPath, ${JSON.stringify(stubborn)}] : cmd, options));
        `)
        writeFileSync(sessionFile, JSON.stringify(localSession({ models: ["pending"], model: "pending" })))
        const tmux = (...args: string[]) => Bun.spawnSync([tmuxPath!, "-S", socketPath, "-f", "/dev/null", ...args], { env: { ...process.env, TMUX: "" }, stdout: "pipe", stderr: "pipe" })
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
        const workbenchCommand = "exec " + [process.execPath, "--preload", preload, join(import.meta.dir, "../src", "workbench.ts"), sessionFile, resultFile, root].map(quote).join(" ")
        const command = [
          `PATH=${quote(join(root, "bin"))}`,
          `SHELLQ_STATE_DIR=${quote(join(root, "state"))}`,
          `SHELLQ_LOCAL_OPENAI_ENDPOINT=${quote(fixture.endpoint)}`,
          "exec /bin/sh -c",
          quote(`exec ${Bun.which("zsh")} -df -c ${quote(workbenchCommand)}`),
        ].join(" ")
        const screen = () => tmux("capture-pane", "-p", "-t", "shellq:0.0").stdout.toString()
        const wait = async (predicate: () => boolean) => {
          for (let i = 0; i < 400 && !predicate(); i++) await Bun.sleep(25)
          if (!predicate()) throw new Error(`terminal predicate timed out; screen:\n${screen()}`)
        }
        const keys = (...values: string[]) => expect(tmux("send-keys", "-t", "shellq:0.0", ...values).exitCode).toBe(0)
        let parentPid = 0
        let childPid = 0
        try {
          const started = tmux("new-session", "-d", "-x", "100", "-y", "24", "-s", "shellq", command)
          expect(started.stderr.toString()).toBe("")
          expect(started.exitCode).toBe(0)
          await wait(() => screen().includes("Describe the command"))
          parentPid = Number(readFileSync(parentFile, "utf8"))
          keys("list files", "C-x", "s")
          await wait(() => screen().includes("Search All:"))
          keys("check local", "Enter")
          await wait(() => screen().includes("2 local models"))
          keys("a3b", "Enter")
          await wait(() => screen().includes("Search Effort:"))
          keys("Enter")
          await wait(() => !screen().includes("Search Effort:"))
          keys("Enter")
          await wait(() => existsSync(childFile))
          childPid = Number(readFileSync(childFile, "utf8"))
          await wait(() => fixture.sockets.size === 1)
          const cancellingAt = Date.now()
          if (cancellation === "Ctrl-C") keys("C-c")
          else expect(tmux("kill-pane", "-t", "shellq:0.0").exitCode).toBe(0)
          await wait(() => processIsGone(childPid) && processIsGone(parentPid) && fixture.sockets.size === 0)
          expect(Date.now() - cancellingAt).toBeGreaterThanOrEqual(LOCAL_TERMINATION_GRACE_MS)
          expect(existsSync(resultFile)).toBe(false)
          expect(fixture.posts).toEqual([])
        } finally {
          tmux("kill-server")
          for (const pid of [childPid, parentPid]) if (pid > 0 && !processIsGone(pid)) { try { process.kill(pid, "SIGKILL") } catch {} }
        }
      })
    }, 40_000)
  }

  test(
    "a fresh catalog publication preserves the active local selection",
    async () => {
      await withLocalEnvironment(async (fixture, root) => {
        const session = localSession()
        const testSetup = await mountWorkbench({
          height: 8,
          session,
          trustedWorkdir: root,
          width: 100,
        })
        try {
          await testSetup.mockInput.typeText("list files")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))
          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("s")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
          await testSetup.mockInput.typeText("check local")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Check local models"))
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), {
            tries: 120,
          })
          await chooseLocalModel(testSetup)
          expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")

          // A second check republishes the catalog. Clause 5: catalog publication
          // preserves local preference and does not clear activation.
          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("s")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
          await testSetup.mockInput.typeText("check local")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("Check local models"))
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), {
            tries: 120,
          })
          await closePalette(testSetup)
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  ls -la") && testSetup.active.process === null, { tries: 160 })
          expect(fixture.posts).toHaveLength(1)
          expect(fixture.posts[0].model).toBe("qwen3-coder-30b-a3b-instruct")
        } finally {
          testSetup.renderer.destroy()
        }
      })
    },
    60_000,
  )

  test("picker with bun missing from PATH fails the local scan quietly while Codex discovery still runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-codex-picker-test-"))
    const bin = join(root, "bin")
    const codexMarker = join(root, "codex-started")
    mkdirSync(bin)
    const fakeCodex = join(bin, "codex")
    writeFileSync(fakeCodex, `#!/bin/sh
printf called > ${codexMarker}
`, { mode: 0o700 })
    const previous = {
      endpoint: process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT,
      path: process.env.PATH,
      stateDir: process.env.SHELLQ_STATE_DIR,
    }
    delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
    process.env.PATH = bin
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const session = fixtureSession({
      initial_intent: "generate",
      provider: ["codex"],
      provider_id: "codex",
      provider_source: "default",
      codex_ask_engine: "exec",
      model: "gpt-5.6-luna",
      reasoning: "low",
      models: ["gpt-5.6-luna"],
      reasoning_levels: ["low"],
    })
    // The local adapter's shebang chain needs bun, which this PATH lacks: the
    // scan is still attempted, its process exits, and the failure stays quiet
    // while Codex discovery runs through the isolated shim.
    const recorded: Array<{ exited: Promise<number> }> = []
    const previousSpawn = Bun.spawn
    Bun.spawn = ((...args: any[]) => {
      const child = previousSpawn(...(args as Parameters<typeof Bun.spawn>))
      if (Array.isArray(args[0]) && String(args[0][0]).includes("local-openai-provider")) {
        recorded.push({ exited: child.exited })
      }
      return child
    }) as typeof Bun.spawn
    const testSetup = await mountWorkbench({
      height: 8,
      session,
      trustedWorkdir: root,
      width: 100,
    })
    try {
      testSetup.mockInput.pressKey("x", { ctrl: true })
      testSetup.mockInput.pressKey("s")
      await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
      await pumpUntilFrame(testSetup, () => recorded.length > 0 && testSetup.active.discoveryProcess === null, { tries: 160 })
      for (const child of recorded) {
        const code = await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("scan process survived close")), 3_000)),
        ])
        expect(typeof code).toBe("number")
      }
      // A freshly written script can take a moment to first exec on macOS.
      for (let i = 0; i < 100 && !existsSync(codexMarker); i++) await Bun.sleep(50)
      expect(existsSync(codexMarker)).toBe(true)
      expect(readPersistedInferenceDocument()).toBeNull()
    } finally {
      Bun.spawn = previousSpawn
      testSetup.renderer.destroy()
      if (previous.endpoint === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      else process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = previous.endpoint
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.stateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = previous.stateDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reopening the palette refreshes a changed local catalog", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
      const testSetup = await mountWorkbench({
        height: 8,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        let held: ServerResponse | null = null
        fixture.onModels = (res) => { held = res }

        // Open picker: auto-refresh triggers and is in-flight.
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await pumpUntilFrame(testSetup, () => testSetup.active.discoveryProcess !== null)
        await pumpUntilFrame(testSetup, () => fixture.hits.length === 1)
        expect(fixture.hits.length).toBe(1)

        // Close picker while discovery is in-flight: this cancels the in-flight attempt.
        await closePalette(testSetup)
        await pumpUntilFrame(testSetup, () => testSetup.active.discoveryProcess === null)
        if (held) {
          try { (held as ServerResponse).end(JSON.stringify({ object: "list", data: [] })) } catch {}
          held = null
        }

        // Reopening triggers a new refresh after cancellation.
        fixture.onModels = undefined
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await pumpUntilFrame(testSetup, () => fixture.hits.length === 2 && testSetup.active.discoveryProcess === null, { tries: 120 })
        expect(fixture.hits.length).toBe(2)

        await closePalette(testSetup)
        fixture.catalog = ["new-local-model"]
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await pumpUntilFrame(testSetup, () => fixture.hits.length === 3 && testSetup.active.discoveryProcess === null, { tries: 120 })
        await testSetup.mockInput.typeText("new-local-model")
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Search All: new-local-model") &&
          focusedSelectionLine(testSetup)?.spans.some((span) => span.text.includes("new-local-model")) === true,
        )
        expect(fixture.hits.length).toBe(3)
        await closePalette(testSetup)
      } finally {
        testSetup.renderer.destroy()
        await testSetup.active.discoveryClosing
      }
    })
  })

  test("Local-Codex-Local transition roundtrips without catalog", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      writePersistedInferenceSettings("qwen3-coder-30b-a3b-instruct", "endpoint default", process.env, LOCAL_PROVIDER_ID)
      writeFileSync(join(root, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
      let heldResponse: ServerResponse | null = null
      fixture.onModels = (res) => { heldResponse = res }

      const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
      const testSetup = await mountWorkbench({
        height: 8,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        expect(session.provider_id).toBe(LOCAL_PROVIDER_ID)
        expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")

        // Switch to Codex while local discovery is held / not published
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await testSetup.mockInput.typeText("Codex")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All: Codex"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, () => session.provider_id === "codex")
        await closePalette(testSetup)

        // Switch back to Local without catalog
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await testSetup.mockInput.typeText("Local")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All: Local"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, () => session.provider_id === LOCAL_PROVIDER_ID)
        expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")
        // Assert discovery response was never consumed for catalog publication
        expect(testSetup.captureCharFrame()).not.toContain("2 local models")
      } finally {
        if (heldResponse) {
          try { (heldResponse as ServerResponse).end(JSON.stringify({ object: "list", data: [] })) } catch {}
        }
        testSetup.renderer.destroy()
        await testSetup.active.discoveryClosing
      }
    })
  })

  test("exit 70 MODEL_GONE retains preference and writes no settings", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      writePersistedInferenceSettings("qwen3-coder-30b-a3b-instruct", "endpoint default", process.env, LOCAL_PROVIDER_ID)
      const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
      const testSetup = await mountWorkbench({
        height: 8,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        // Preflight returns empty list, meaning model is gone -> exit 70
        fixture.onModels = (res) => {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ object: "list", data: [] }))
        }
        await testSetup.mockInput.typeText("list files")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("local model is gone"),
        )
        // Preference retained
        expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")
        expect(readPersistedInferenceSettings(process.env, LOCAL_PROVIDER_ID)?.model)
          .toBe("qwen3-coder-30b-a3b-instruct")
      } finally {
        testSetup.renderer.destroy()
      }
    })
  })

  test("stubborn discovery retirement cannot delay Codex request", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const fakeCodex = join(root, "fake-codex-provider.zsh")
      writeFileSync(fakeCodex, "#!/bin/sh\nexec bun -e 'const req = JSON.parse(await Bun.stdin.text()); const item = { tldr: \"codex fixture\", corrected_command: \"echo codex\", confidence: 0.8, risk: \"low\" }; console.log(JSON.stringify((req.candidate_count ?? 1) > 1 ? { candidates: [item] } : item))'\n", { mode: 0o700 })
      writeFileSync(join(root, "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
      const stubbornDiscovery = join(root, "stubborn-discovery.zsh")
      const readyFile = join(root, "stubborn-discovery-ready")
      const stubbornBody = [
        "process.on(\"SIGTERM\", () => {});",
        "process.on(\"SIGINT\", () => {});",
        "process.on(\"SIGHUP\", () => {});",
        `await Bun.write(${JSON.stringify(readyFile)}, "1");`,
        "await new Promise((resolve) => setTimeout(resolve, 60000));",
      ].join(" ")
      writeFileSync(stubbornDiscovery, `#!/bin/sh\nexec bun -e '${stubbornBody}'\n`, { mode: 0o700 })
      chmodSync(stubbornDiscovery, 0o700)
      const realAdapterPath = adapterPath
      const adapterSpy = spyOn(workbenchBindings, "adapterPath").mockImplementation((descriptor) =>
        descriptor.id === LOCAL_PROVIDER_ID ? stubbornDiscovery
          : descriptor.id === "codex" ? fakeCodex
          : realAdapterPath(descriptor),
      )

      const session = localSession({ model: "qwen3-coder-30b-a3b-instruct", codex_ask_engine: "exec" })
      const testSetup = await mountWorkbench({
        height: 8,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        await beginLocalCheck(testSetup)
        await pumpUntilFrame(testSetup, () => existsSync(readyFile), { tries: 100, delayMs: 25 })
        expect(testSetup.active.discoveryProcess).not.toBeNull()

        // Switch to Codex
        const start = Date.now()
        await testSetup.mockInput.typeText("Codex")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All: Codex"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, () => session.provider_id === "codex")
        expect(testSetup.active.discoveryClosing).toBeInstanceOf(Promise)
        await closePalette(testSetup)
        await testSetup.mockInput.typeText("list files")
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  echo codex") && testSetup.active.process === null, { tries: 160 })
        expect(Date.now() - start).toBeLessThan(LOCAL_TERMINATION_GRACE_MS)
        expect(fixture.posts).toEqual([])
      } finally {
        testSetup.renderer.destroy()
        await testSetup.active.discoveryClosing
        adapterSpy.mockRestore()
      }
    })
  })

  test("automatic refresh keeps exit 71/74 blocks and explicit refresh clears them", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
      const testSetup = await mountWorkbench({
        height: 8,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        await testSetup.mockInput.typeText("trigger rejection")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("trigger rejection"))

        // Simulate exit 71 (model rejected request)
        fixture.onCompletion = (res) => {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { message: "model rejected" } }))
        }
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("local model rejected request"),
        )

        // Blocked model: submit spawns nothing
        const hitsBefore = fixture.hits.length
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("no local model is active"),
        )
        expect(fixture.hits.length).toBe(hitsBefore)

        // Restore normal completion
        fixture.onCompletion = undefined

        // Automatic refresh on picker open does NOT clear the block
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), { tries: 120 })
        await closePalette(testSetup)

        // Model is still blocked!
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("no local model is active"),
        )
        expect(fixture.hits.length).toBe(hitsBefore + 1) // +1 for the auto-refresh GET

        // Successful EXPLICIT refresh ("Check local models") clears the block!
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await testSetup.mockInput.typeText("check local")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Check local models"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), { tries: 120 })
        await closePalette(testSetup)

        // Now submit succeeds!
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  ls -la") && testSetup.active.process === null, { tries: 160 })
        expect(fixture.posts.length).toBe(2)
      } finally {
        testSetup.renderer.destroy()
      }
    })
  })

  test("same-ID endpoint change retains preference and directs submit to new endpoint", async () => {
    await withLocalEnvironment(async (fixture1, root) => {
      const fixture2 = await startLocalFixture()
      try {
        delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
        writePersistedLocalEndpoint(fixture1.endpoint, LOCAL_PROVIDER_ID)
        writePersistedInferenceSettings("qwen3-coder-30b-a3b-instruct", "endpoint default", process.env, LOCAL_PROVIDER_ID)
        const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
        const testSetup = await mountWorkbench({
          height: 8,
          session,
          trustedWorkdir: root,
          width: 140,
        })
        try {
          // Change endpoint to fixture2 (which has identical model IDs)
          await openEndpoint(testSetup)
          await replaceEndpoint(testSetup, fixture2.endpoint)
          testSetup.mockInput.pressKey("x", { ctrl: true })
          testSetup.mockInput.pressKey("w")
          await pumpUntilFrame(testSetup, (frame) => !frame.includes("Local endpoint /"))

          // Preference is retained!
          expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")

          // Explicit Submit targets fixture2 directly with fresh preflight GET and POST
          await testSetup.mockInput.typeText("list files")
          await pumpUntilFrame(testSetup, (frame) => frame.includes("list files"))
          testSetup.mockInput.pressEnter()
          await pumpUntilFrame(testSetup, (frame) => frame.includes("› 1  ls -la") && testSetup.active.process === null, { tries: 160 })
          expect(fixture2.posts).toHaveLength(1)
          expect(fixture2.posts[0].model).toBe("qwen3-coder-30b-a3b-instruct")
        } finally {
          testSetup.renderer.destroy()
        }
      } finally {
        await fixture2.close()
      }
    })
  })

  test("failed refresh updates stale/unavailable status without overwriting Codex status", async () => {
    await withLocalEnvironment(async (fixture, root) => {
      const session = localSession({ model: "qwen3-coder-30b-a3b-instruct" })
      const testSetup = await mountWorkbench({
        height: 8,
        session,
        trustedWorkdir: root,
        width: 100,
      })
      try {
        // First successful check publishes valid models
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await pumpUntilFrame(testSetup, (frame) => frame.includes("2 local models"), { tries: 120 })
        await closePalette(testSetup)

        // Now endpoint fails with 503
        fixture.onModels = (res) => {
          res.writeHead(503)
          res.end("server error")
        }

        // Trigger explicit refresh on failed endpoint
        testSetup.mockInput.pressKey("x", { ctrl: true })
        testSetup.mockInput.pressKey("s")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Search All:"))
        await testSetup.mockInput.typeText("check local")
        await pumpUntilFrame(testSetup, (frame) => frame.includes("Check local models"))
        testSetup.mockInput.pressEnter()
        await pumpUntilFrame(testSetup, (frame) => frame.includes("local server failed"), { tries: 160 })

        // Model is now marked unavailable rather than remaining apparently valid
        await testSetup.mockInput.typeText("qwen3")
        const frame = await pumpUntilFrame(testSetup, (frame) =>
          frame.includes("Search All: qwen3") && frame.includes("unavailable"),
        )
        expect(frame).toContain("unavailable")
      } finally {
        testSetup.renderer.destroy()
      }
    })
  })



})

// ---------------------------------------------------------------------------
// SPIKE(local-stream-ask): one mounted check for streamed local Ask —
// preview-before-completion, labeled thinking, stepped growth 8/12/16,
// ceiling scrolling, no shrink, and the widened footer receipt gates.
// ---------------------------------------------------------------------------

describe("mounted workbench: streamed local Ask (spike)", () => {
  const saveCapture = (setup: Awaited<ReturnType<typeof mountWorkbench>>, name: string, width: number) => {
    if (!process.env.SHELLQ_POLISH_CAPTURE_DIR) return
    const frame=setup.captureSpans()
    const color=(c: {r:number;g:number;b:number;a:number}) => [c.r,c.g,c.b,c.a]
    writeFileSync(join(process.env.SHELLQ_POLISH_CAPTURE_DIR, `${name}-${width}.json`), JSON.stringify({...frame,lines:frame.lines.map(line=>({spans:line.spans.map(span=>({...span,fg:color(span.fg),bg:color(span.bg)}))}))}))
  }
  const LOCAL_ADAPTER = adapterPath(descriptorForProvider(LOCAL_PROVIDER_ID))
  const SPIKE_MODEL = "qwen3-coder-30b-a3b-instruct"

  type SseFixture = {
    endpoint: string
    posts: Array<Record<string, any>>
    close: () => Promise<void>
    onCompletion: ((response: ServerResponse) => void) | null
  }

  const startSseFixture = (): Promise<SseFixture> =>
    new Promise((resolve) => {
      const sockets = new Set<Socket>()
      const posts: Array<Record<string, any>> = []
      let fixture: SseFixture
      const server = createServer((req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ object: "list", data: [{ id: SPIKE_MODEL }] }))
          return
        }
        if (req.url === "/props") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ chat_template: "{% if enable_thinking %}" }))
          return
        }
        let body = ""
        req.on("data", (chunk) => {
          body += chunk
        })
        req.on("end", () => {
          try {
            posts.push(JSON.parse(body))
          } catch {}
          if (fixture.onCompletion) return fixture.onCompletion(res)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end("{}")
        })
      })
      server.on("connection", (socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("no port")
        fixture = {
          endpoint: `http://127.0.0.1:${address.port}/v1`,
          posts,
          onCompletion: null,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done())
              for (const socket of sockets) socket.destroy()
            }),
        }
        resolve(fixture)
      })
    })

  const withSpikeEnvironment = async (
    body: (fixture: SseFixture, root: string) => Promise<void>,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "shellq-local-stream-spike-"))
    const bin = join(root, "bin")
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, "bun"))
    for (const zsh of ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]) {
      if (existsSync(zsh)) {
        symlinkSync(zsh, join(bin, "zsh"))
        break
      }
    }
    const fixture = await startSseFixture()
    const previous = {
      endpoint: process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT,
      path: process.env.PATH,
      stateDir: process.env.SHELLQ_STATE_DIR,
    }
    process.env.PATH = bin
    process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = fixture.endpoint
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    try {
      await body(fixture, root)
    } finally {
      if (previous.endpoint === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      else process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = previous.endpoint
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.stateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = previous.stateDir
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const spikeSession = (overrides: Partial<WorkbenchSession> = {}) =>
    fixtureSession({
      initial_intent: "ask",
      provider: [LOCAL_ADAPTER],
      provider_id: LOCAL_PROVIDER_ID,
      provider_source: "default",
      model: SPIKE_MODEL,
      reasoning: "endpoint default",
      models: [SPIKE_MODEL],
      reasoning_levels: ["endpoint default"],
      ...overrides,
    })


  for (const intent of ["generate", "correct"] as const) {
    test(`streamed local ${intent}: preview before seal, no partial insertion and cancel restores choices`, async () => {
      await withSpikeEnvironment(async (fixture, root) => {
        const pending: {current: ServerResponse | null} = {current:null}
        fixture.onCompletion = response => {response.writeHead(200,{"Content-Type":"text/event-stream"});pending.current=response}
        const send=(delta:unknown)=>pending.current!.write(`data: ${JSON.stringify({choices:[{index:0,delta}]})}\n\n`)
        const setup=await mountWorkbench({width:80,height:24,trustedWorkdir:root,session:spikeSession({initial_intent:intent,actionable_failure:intent==="correct"})})
        const response={tldr:"Lists visible entries here, oldest first.",corrected_command:"ls -tr",confidence:0.9,risk:"Low; read-only"}
        try {
          setup.mockInput.pressKey("u",{ctrl:true});await setup.mockInput.typeText("list files");setup.mockInput.pressEnter()
          await pumpUntilFrame(setup,()=>pending.current!==null)
          expect(fixture.posts[0].stream).toBe(true)
          send({reasoning_content:"Compare the directory scope."})
          await pumpUntilFrame(setup,f=>f.includes("Compare the directory scope."))
          send({content:'{"candidates":[{"tldr":"Lists visible entries here'})
          const preview=await pumpUntilFrame(setup,f=>f.includes("Lists visible entries here"))
          expect(preview).toContain("You: list files")
          expect(preview).not.toContain('"candidates"')
          expect(preview).not.toContain("Choices · selected")
          expect(setup.active.process).not.toBeNull()
          setup.mockInput.pressEnter();await setup.renderOnce()
          expect(existsSync(setup.resultPath)).toBe(false)
          send({content:', oldest first.","corrected_command":"ls -tr","confidence":0.9,"risk":"Low; read-only"}]}'})
          pending.current!.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n');pending.current=null
          await pumpUntilFrame(setup,f=>f.includes("› 1  ls -tr")&&setup.active.process===null)
          setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
          await pumpUntilFrame(setup,()=>pending.current!==null)
          send({content:'{"tldr":"A different unfinished approach'})
          await pumpUntilFrame(setup,f=>f.includes("different unfinished approach"))
          setup.mockInput.pressEscape()
          await pumpUntilFrame(setup,f=>f.includes("› 1  ls -tr")&&setup.active.process===null)
          expect(setup.captureCharFrame()).not.toContain("unfinished approach")
          expect(existsSync(setup.resultPath)).toBe(false)
          setup.mockInput.pressEnter()
          await pumpUntilFrame(setup,()=>existsSync(setup.resultPath))
          expect(JSON.parse(readFileSync(setup.resultPath,"utf8"))).toEqual(response)
        } finally { pending.current?.end();setup.renderer.destroy() }
      })
    })
  }

  for (const intent of ["generate", "correct"] as const) {
    test(`local thinking controls in ${intent}: keyboard, pointer and next-request persistence`, async () => {
      await withSpikeEnvironment(async (fixture, root) => {
        const pending: {current: ServerResponse | null} = {current:null}
        fixture.onCompletion = response => { response.writeHead(200,{"Content-Type":"text/event-stream"}); pending.current = response }
        const session = spikeSession({initial_intent:intent, actionable_failure:intent==="correct"})
        const setup = await mountWorkbench({width:100,height:24,trustedWorkdir:root,session})
        const finish = (command:string, batch:boolean) => {
          const response={tldr:"Inspect the current directory.",corrected_command:command,confidence:0.9,risk:"read only"}
          pending.current!.end("data: "+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(batch?{candidates:[response]}:response)},finish_reason:"stop"}]})+"\n\ndata: [DONE]\n\n")
          pending.current=null
        }
        try {
          expect(setup.captureCharFrame()).toContain("^T thinking default")
          setup.mockInput.pressKey("t",{ctrl:true})
          await pumpUntilFrame(setup,frame=>frame.includes("^T thinking off"))
          expect(fixture.posts).toHaveLength(0)
          await setup.mockInput.typeText("list files");setup.mockInput.pressEnter()
          await pumpUntilFrame(setup,()=>fixture.posts.length===1)
          expect(fixture.posts[0].chat_template_kwargs).toEqual({enable_thinking:false})
          const frame=await pumpUntilFrame(setup,frame=>frame.includes("^T thinking off · next"))
          const footer=frame.trimEnd().split("\n").at(-1)!
          await setup.mockMouse.click(footer.indexOf("^T thinking")+3,footerRenderOffset(setup.renderer)+setup.renderer.footerHeight-1,MouseButtons.LEFT)
          await pumpUntilFrame(setup,frame=>frame.includes("^T thinking on · next"))
          expect(fixture.posts).toHaveLength(1)
          expect(fixture.posts[0].chat_template_kwargs).toEqual({enable_thinking:false})
          finish("ls -a",true)
          await pumpUntilFrame(setup,frame=>frame.includes("› 1  ls -a")&&setup.active.process===null)
          expect(setup.captureCharFrame()).not.toContain("^T thinking")
          setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
          await pumpUntilFrame(setup,()=>fixture.posts.length===2)
          expect(fixture.posts[1].chat_template_kwargs).toEqual({enable_thinking:true})
          finish("find . -maxdepth 1",false)
          await pumpUntilFrame(setup,frame=>frame.includes("find . -maxdepth 1")&&setup.active.process===null)
          expect(existsSync(setup.resultPath)).toBe(false)
        } finally {pending.current?.end();setup.renderer.destroy()}
        const reopened=await mountWorkbench({width:100,height:24,trustedWorkdir:root,session:spikeSession({initial_intent:intent==="generate"?"correct":"generate"})})
        try {
          expect(reopened.captureCharFrame()).toContain("^T thinking on")
          expect(fixture.posts).toHaveLength(2)
        } finally {reopened.renderer.destroy()}
      })
    })
  }

  test("streamed local Ask: preview before completion, labeled thinking, stepped growth, ceiling scroll, no shrink, receipt accepts 16", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      seedStateRoot(join(root, "state"), { maxFooterRows: 16 })
      const session = spikeSession()
      const setup = await mountWorkbench({ width: 100, height: 24, trustedWorkdir: root, session })
      const sse: { current: ServerResponse | null } = { current: null }
      const send = (payload: unknown) =>
        sse.current!.write(`data: ${JSON.stringify(payload)}\n\n`)
      fixture.onCompletion = (response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        sse.current = response
      }
      const answerLine = (index: number) => `spike answer line ${String(index).padStart(2, "0")}`
      try {
        expect(setup.renderer.footerHeight).toBe(3)
        await setup.mockInput.typeText("spike question")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, () => sse !== null && fixture.posts.length > 0, { tries: 160 })
        expect(fixture.posts[0].stream).toBe(true)
        expect(fixture.posts[0].response_format.json_schema.name).toBe("shellq_ask_v1")

        // 1. Model thinking alone: shown separately labeled, request still
        //    in flight, footer stays at the eight-row reader promotion.
        send({ choices: [{ index: 0, delta: { reasoning_content: "private spike reasoning" } }] })
        const thinking = await pumpUntilFrame(setup, (frame) =>
          frame.includes("private spike reasoning"),
        )
        expect(thinking).toContain("You: ")
        expect(setup.renderer.footerHeight).toBe(8)
        expect(thinking).toContain("Esc cancel")

        // 2. First answer text crosses the boundary before the stream is
        //    finished, with no envelope punctuation in the preview.
        send({ choices: [{ index: 0, delta: { content: '{"answer":"' } }] })
        send({ choices: [{ index: 0, delta: { content: "short answer text" } }] })
        const short = await pumpUntilFrame(setup, (frame) => frame.includes("short answer text"))
        expect(short).toContain("Thinking")
        expect(short).not.toContain('"answer"')
        expect(setup.active.process).not.toBeNull()
        expect(setup.renderer.footerHeight).toBe(8)

        // 3. Longer content grows the envelope in steps — first to twelve.
        send({
          choices: [{
            index: 0, delta: { content: [1, 2, 3, 4].map((index) => `\\n${answerLine(index)}`).join("") },
          }],
        })
        await pumpUntilFrame(
          setup,
          (frame) => frame.includes(answerLine(4)) && setup.renderer.footerHeight === 12,
          { tries: 160 },
        )

        // 4. Then to the sixteen-row ceiling, which is the receipt's maximum.
        send({
          choices: [{
            index: 0, delta: { content: [5, 6, 7, 8].map((index) => `\\n${answerLine(index)}`).join("") },
          }],
        })
        await pumpUntilFrame(
          setup,
          (frame) => frame.includes(answerLine(8)) && setup.renderer.footerHeight === 16,
          { tries: 160 },
        )
        const pluginSource = readFileSync(join(import.meta.dir, "..", "shellq.plugin.zsh"), "utf8")
        expect(pluginSource).toMatch(/peak_height <= 16/)

        // 5. Completing the stream validates the final and never shrinks.
        send({ choices: [{ index: 0, delta: { content: '"}' } }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        sse.current!.write("data: [DONE]\n\n")
        sse.current!.end()
        const answered = await pumpUntilFrame(
          setup,
          (frame) => frame.includes("Ask a local question") && setup.active.process === null,
          { tries: 160 },
        )
        expect(answered).toContain(answerLine(8))
        expect(setup.renderer.footerHeight).toBe(16)

        // 6. A second turn streams, then Escape cancels: no child survives,
        //    no provisional output is accepted, the validated answer stays.
        await setup.mockInput.typeText("second spike question")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, () => sse !== null && fixture.posts.length > 1, { tries: 160 })
        send({ choices: [{ index: 0, delta: { reasoning_content: "second turn reasoning" } }] })
        await pumpUntilFrame(setup, (frame) => frame.includes("second turn reasoning"))
        setup.mockInput.pressEscape()
        const cancelled = await pumpUntilFrame(setup, (frame) =>
          frame.includes("the workbench stayed open"),
        )
        expect(cancelled).toContain("short answer text")
        expect(cancelled).not.toContain("second turn reasoning")
        await pumpUntilFrame(setup, () => setup.active.process === null, { tries: 160 })
        expect(existsSync(setup.resultPath)).toBe(false)
      } finally {
        try { sse.current?.end() } catch {}
        setup.renderer.destroy()
      }
    })
  }, 40_000)

  test("a small terminal caps the envelope and the streaming view scrolls past it", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      const setup = await mountWorkbench({
        width: 100,
        height: 13,
        trustedWorkdir: root,
        session: spikeSession(),
      })
      const sse: { current: ServerResponse | null } = { current: null }
      const send = (payload: unknown) =>
        sse.current!.write(`data: ${JSON.stringify(payload)}\n\n`)
      fixture.onCompletion = (response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        sse.current = response
      }
      try {
        await setup.mockInput.typeText("long question")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, () => sse !== null && fixture.posts.length > 0, { tries: 160 })
        // Far more content than any envelope: growth must stop at
        // min(16, physical rows - 1) = 12, and while streaming the view must
        // follow the tail — early lines scroll past the ceiling.
        const lines = Array.from({ length: 30 }, (_, index) => `\\nceiling line ${String(index).padStart(2, "0")}`)
        send({ choices: [{ index: 0, delta: { content: `{"answer":"head${lines.join("")}` } }] })
        const streaming = await pumpUntilFrame(
          setup,
          (frame) => frame.includes("ceiling line 29") && setup.renderer.footerHeight === 12,
          { tries: 160 },
        )
        const streamBar=setup.renderer.root.findDescendantById("ask-stream-scrollbar") as ReaderScrollbar
        expect(streamBar).toBeDefined()
        expect(streamBar.scrollPosition).toBeGreaterThan(0)
        expect(streaming).not.toContain("ceiling line 00")
        expect(streaming).not.toContain('"answer"')
        setup.mockInput.pressKey("\u001b[5~")
        const scrolled = await pumpUntilFrame(setup, frame => !frame.includes("ceiling line 29"))
        expect(scrolled).toContain("ceiling line")
        expect(fixture.posts.length).toBe(1)
        expect(setup.active.process).not.toBeNull()
        setup.mockInput.pressKey("\u001b[6~")
        await pumpUntilFrame(setup, frame => frame.includes("ceiling line 29"))


        // Completing the stream validates the final; the capped envelope
        // never shrinks and the completed answer stays at its tail.
        send({ choices: [{ index: 0, delta: { content: '"}' } }] })
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        sse.current!.write("data: [DONE]\n\n")
        sse.current!.end()
        const answered = await pumpUntilFrame(
          setup,
          (frame) => frame.includes("Ask a local question") && setup.active.process === null,
          { tries: 160 },
        )
        expect(answered).toContain("ceiling line 29")
        const bar=setup.renderer.root.findDescendantById("ask-conversation-scrollbar") as ReaderScrollbar
        expect(bar).toBeDefined()
        const tail=bar.scrollPosition
        setup.mockInput.pressKey("\u001b[5~")
        await pumpUntilFrame(setup, frame => !frame.includes("ceiling line 29"))
        expect(bar.scrollPosition).toBeLessThan(tail)
        saveCapture(setup,"scrollbar",80)
        await setup.mockMouse.click(bar.x, footerRenderOffset(setup.renderer)+bar.y, MouseButtons.LEFT)
        await pumpUntilFrame(setup, frame => frame.includes("You: long question"))
        expect(fixture.posts.length).toBe(1)
        expect(setup.renderer.footerHeight).toBe(12)
        expect(existsSync(setup.resultPath)).toBe(false)
      } finally {
        try { sse.current?.end() } catch {}
        setup.renderer.destroy()
      }
    })
  }, 40_000)

  test("scrollbar uses live limits after growth and resize, and settings errors outrank timing", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      const setup=await mountWorkbench({width:100,height:13,trustedWorkdir:root,session:spikeSession()})
      const stream: {current:ServerResponse|null}={current:null}
      fixture.onCompletion=res=>{res.writeHead(200,{"Content-Type":"text/event-stream"});stream.current=res}
      const send=(delta:Record<string,unknown>,finish_reason:string|null=null)=>stream.current!.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`)
      try {
        await setup.mockInput.typeText("scroll regression")
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup,()=>fixture.posts.length===1)
        send({content:'{"answer":"'+Array.from({length:20},(_,n)=>`row ${n} ${"x".repeat(70)}`).join("\\n")})
        await pumpUntilFrame(setup,frame=>frame.includes("row 19"))
        const bar=setup.renderer.root.findDescendantById("ask-stream-scrollbar") as ReaderScrollbar
        const oldMax=bar.scrollSize-bar.viewportSize
        send({content:"\\n"+Array.from({length:40},(_,n)=>`row ${n+20} ${"x".repeat(70)}`).join("\\n")})
        await pumpUntilFrame(setup,frame=>frame.includes("row 59"))
        await setup.mockMouse.click(bar.x,footerRenderOffset(setup.renderer)+bar.y+Math.floor(bar.height*0.65),MouseButtons.LEFT)
        await setup.renderOnce()
        expect(bar.scrollPosition).toBeGreaterThan(oldMax)
        expect(bar.scrollPosition).toBeLessThan(bar.scrollSize-bar.viewportSize)
        mkdirSync(join(root,"state"),{recursive:true})
        writeFileSync(inferenceSettingsFile(),"invalid settings")
        setup.mockInput.pressKey("t",{ctrl:true})
        await pumpUntilFrame(setup,frame=>frame.includes("thinking choice not"))
        send({content:'"}'});send({},"stop");stream.current!.end("data: [DONE]\n\n")
        await pumpUntilFrame(setup,()=>setup.active.process===null)
        expect(setup.captureCharFrame()).toContain("thinking choice not")
        const completed=setup.renderer.root.findDescendantById("ask-conversation-scrollbar") as ReaderScrollbar
        setup.renderer.resize(45,10)
        await setup.flush()
        await setup.renderOnce()
        const target=completed.scrollSize-completed.viewportSize-1
        completed.slider.value=target
        await setup.renderOnce()
        expect(completed.scrollPosition).toBe(target)
        expect(fixture.posts).toHaveLength(1)
      } finally { stream.current?.end();setup.renderer.destroy() }
    })
  })

  for (const width of [80, 140]) {
    test(`refined local reader at ${width} columns`, async () => {
      await withSpikeEnvironment(async (fixture, root) => {
        seedStateRoot(join(root, "state"), { maxFooterRows: 16 })
        const setup = await mountWorkbench({ width, height: 24, trustedWorkdir: root, session: spikeSession() })
        const stream: { current: ServerResponse | null } = { current: null }
        fixture.onCompletion = response => { response.writeHead(200, {"Content-Type":"text/event-stream"}); stream.current=response }
        const send = (delta: Record<string, unknown>, finish_reason: string | null = null) => stream.current!.write(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason}]})}\n\n`)
        const finish = () => { stream.current!.write(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}],timings:{predicted_n:84,predicted_per_second:40}})}\n\n`); stream.current!.end("data: [DONE]\n\n") }
        const capture = (name: string) => saveCapture(setup, name, width)
        try {
          await setup.mockInput.typeText("How do I list large files?")
          setup.mockInput.pressEnter()
          await pumpUntilFrame(setup, ()=>fixture.posts.length===1)
          send({reasoning_content:"Checking the command and its flags."})
          await pumpUntilFrame(setup, frame=>frame.includes("Checking the command"))
          const peak=setup.renderer.footerHeight
          const thinkingSpans=setup.captureSpans().lines.flatMap(line=>line.spans).filter(span=>span.text.includes("Checking the command"))
          expect(thinkingSpans.length).toBeGreaterThan(0)
          expect(thinkingSpans.every(span=>(span.attributes & TextAttributes.ITALIC)!==0)).toBe(true)
          expect(thinkingSpans[0]!.fg.r).toBeCloseTo(156/255,2)
          await setup.mockMouse.click(INTERIOR_ORIGIN_X+4, footerRenderOffset(setup.renderer)+2, MouseButtons.LEFT)
          await pumpUntilFrame(setup, frame=>frame.includes("Thinking hidden")&&!frame.includes("Checking the command"))
          expect(setup.renderer.footerHeight).toBe(peak)
          capture("hidden")
          await setup.mockMouse.click(INTERIOR_ORIGIN_X+4, footerRenderOffset(setup.renderer)+2, MouseButtons.LEFT)
          await pumpUntilFrame(setup, frame=>frame.includes("Checking the command"))
          const footer = setup.captureCharFrame().trimEnd().split("\n").at(-1)!
          const thinkingX = footer.indexOf("^T thinking")
          await setup.mockMouse.click(thinkingX + 3, footerRenderOffset(setup.renderer) + setup.renderer.footerHeight - 1, MouseButtons.LEFT)
          await pumpUntilFrame(setup, frame => frame.includes("thinking off"))
          expect(setup.captureCharFrame()).toContain("Checking the command")
          expect(fixture.posts[0]!.chat_template_kwargs).toBeUndefined()
          setup.mockInput.pressKey("t", { ctrl: true })
          await pumpUntilFrame(setup, frame => frame.includes("thinking on"))
          expect(setup.captureCharFrame()).toContain("Checking the command")
          setup.mockInput.pressEnter()
          setup.mockInput.pressKey("k",{ctrl:true})
          await setup.renderOnce()
          expect(fixture.posts.length).toBe(1)
          send({content:JSON.stringify({answer:"Use ls -lhS to sort files by size."})})
          await pumpUntilFrame(setup, frame=>frame.includes("Use ls -lhS"))
          capture("streaming")
          send({reasoning_content:"\n" + Array.from({length:20}, (_, index) => `Checking detail ${index}`).join("\n")})
          await pumpUntilFrame(setup, () => setup.renderer.footerHeight === 16)
          finish()
          await pumpUntilFrame(setup, frame=>frame.includes("Ask a local question") && setup.active.process === null)
          await setup.mockInput.typeText("And hidden files?")
          setup.mockInput.pressEnter()
          await pumpUntilFrame(setup, ()=>fixture.posts.length===2)
          expect(fixture.posts[1]!.chat_template_kwargs).toEqual({enable_thinking:true})
          send({content:JSON.stringify({answer:"Add -a: ls -lahS."})});finish()
          const answered=await pumpUntilFrame(setup, frame=>frame.includes("Add -a: ls -lahS.")&&frame.includes("Ask a local question") && setup.active.process === null)
          expect(answered.indexOf("How do I list")).toBeLessThan(answered.indexOf("And hidden files?"))
          expect(answered).not.toContain("endpoint default")
          expect(answered).not.toContain("Checking the command")
          expect(JSON.stringify(fixture.posts[1])).not.toContain("How do I list")
          const question=setup.captureSpans().lines.flatMap(line=>line.spans).find(span=>span.text.includes("And hidden files?"))!
          expect(question.attributes & TextAttributes.BOLD).not.toBe(0)
          expect(question.bg.r).toBeCloseTo(55/255,2)
          const finalLines = answered.trimEnd().split("\n")
          const answerRow = finalLines.findIndex(line => line.includes("Add -a: ls -lahS."))
          expect(finalLines[answerRow + 1]).toContain("Ask a local question")
          expect(setup.renderer.footerHeight).toBe(16)
          expect(answered).not.toContain("answer ready")
          expect(answered).not.toContain("local questions are independent")
          const expanded=await pumpUntilFrame(setup, frame => frame.includes("84 tokens"))
          expect(expanded).toContain("40.0 tok/s")
          capture("metrics")
          await setup.mockMouse.click(TITLE_ORIGIN_X + 2, footerRenderOffset(setup.renderer)+setup.renderer.footerHeight-1, MouseButtons.LEFT)
          await pumpUntilFrame(setup, frame => !frame.includes("84 tokens"))
          capture("conversation")
          await setup.mockInput.typeText("Third independent question")
          setup.mockInput.pressKey("\u0014\r")
          await pumpUntilFrame(setup, () => fixture.posts.length === 3)
          expect(fixture.posts[2]!.chat_template_kwargs).toEqual({enable_thinking:false})
          send({content:JSON.stringify({answer:"Third answer."})});finish()
          const third=await pumpUntilFrame(setup, frame => frame.includes("Third answer.") && setup.active.process===null)
          expect(third).not.toContain("84 tokens")
          setup.renderer.destroy()
          const reopened = await mountWorkbench({width, height:24, trustedWorkdir:root, session:spikeSession()})
          try {
            expect(reopened.captureCharFrame()).toContain("thinking off")
            reopened.mockInput.pressKey("\u0014\u0014")
            await reopened.renderOnce()
            expect(reopened.captureCharFrame()).toContain("thinking off")
            reopened.mockInput.pressKey("x", {ctrl:true})
            reopened.mockInput.pressKey("r")
            await pumpUntilFrame(reopened, frame => frame.includes("endpoint default"))
            reopened.mockInput.pressEnter()
            await pumpUntilFrame(reopened, frame => frame.includes("^T thinking default"))
            await reopened.mockInput.typeText("A new opening")
            reopened.mockInput.pressEnter()
            await pumpUntilFrame(reopened,()=>fixture.posts.length===4)
            send({content:JSON.stringify({answer:"Reopened answer."})});finish()
            const restored=await pumpUntilFrame(reopened,frame=>frame.includes("Reopened answer.")&&reopened.active.process===null)
            expect(restored).not.toContain("84 tokens")
            await reopened.mockMouse.click(TITLE_ORIGIN_X+2,footerRenderOffset(reopened.renderer)+reopened.renderer.footerHeight-1,MouseButtons.LEFT)
            await pumpUntilFrame(reopened,frame=>frame.includes("84 tokens"))
          }
          finally { reopened.renderer.destroy() }
        } finally { stream.current?.end();setup.renderer.destroy() }
      })
    })
  }

})

for (const width of [80, 100, 140, 42]) {
  test(`SQ-10 ranked review, scrolling, edit and acceptance at ${width} columns`, async () => {
    const previousUnicode = process.env.NO_UNICODE
    if (width === 100) process.env.NO_UNICODE = "1"
    const marker = width === 100 ? ">" : "›"
    const root = mkdtempSync(join(tmpdir(), "shellq-sq10-"))
    const previousStateDir = process.env.SHELLQ_STATE_DIR
    seedStateRoot(join(root, "state"), { maxFooterRows: 16 })
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    const log = join(root, "requests.jsonl")
    const responses = [0.8, 0.95, 0.7, 0.8, 0.6].map((confidence, index) => ({
      corrected_command: `echo choice-${index}\necho continuation-${index}`,
      confidence, risk: "read only",
      tldr: "Same explanation. " + "This is a long explanation for scrolling. ".repeat(10),
    }))
    const provider = ["bun", "-e", `
      const {appendFileSync, readFileSync, existsSync} = require('node:fs');
      const req = JSON.parse(await Bun.stdin.text());
      const file = ${JSON.stringify(log)};
      const index = existsSync(file) ? readFileSync(file,'utf8').trim().split('\\n').length : 0;
      appendFileSync(file,JSON.stringify(req)+'\\n');
      console.log(JSON.stringify(${JSON.stringify(responses)}[index]));
    `]
    const setup = await mountWorkbench({width, height:24, trustedWorkdir:root, session:fixtureSession({provider})})
    const requestCount = () => existsSync(log) ? readFileSync(log,"utf8").trim().split("\n").length : 0
    const reader = () => setup.renderer.root.findDescendantById("candidate-description") as any
    const capture = (name:string) => {
      if (!process.env.SHELLQ_POLISH_CAPTURE_DIR) return
      const frame = setup.captureSpans()
      const color = (c:any) => [c.r,c.g,c.b,c.a]
      writeFileSync(join(process.env.SHELLQ_POLISH_CAPTURE_DIR,`${name}-${width}.json`), JSON.stringify({...frame,lines:frame.lines.map(line=>({spans:line.spans.map(span=>({...span,fg:color(span.fg),bg:color(span.bg)}))}))}))
    }
    const more = async (count:number, selected:string) => {
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
      return pumpUntilFrame(setup,frame=>requestCount()===count && setup.active.process===null && frame.includes(selected) && frame.includes("Risk:"))
    }
    try {
      await setup.mockInput.typeText("show choices");setup.mockInput.pressEnter()
      // The reader grows one frame after the first choice paints.
      let frame = await pumpUntilFrame(setup,frame=>frame.includes(`${marker} 1  echo choice-0`) && frame.includes("Risk:") && setup.active.process===null)
      expect(frame).toContain("Risk: read only")
      expect(frame).toContain("Confidence: 80%")
      expect(frame).toContain("Choices · selected 1 of 1")
      expect(frame).not.toContain("good echo")
      capture("sq10-one")
      await setup.mockMouse.scroll(INTERIOR_ORIGIN_X+8,footerRenderOffset(setup.renderer)+2,"down")
      await pumpUntilFrame(setup,()=>reader().scrollHeight <= reader().height ? reader().scrollTop === 0 : reader().scrollTop > 0)
      frame = await more(2,`${marker} 1  echo choice-1`)
      expect(reader().scrollTop).toBe(0)
      expect(frame.indexOf("choice-1")).toBeLessThan(frame.indexOf("choice-0"))
      const continuationRow = frame.split("\n").findIndex(line=>line.includes("echo continuation-1"))
      expect(continuationRow).toBeGreaterThan(0)
      await setup.mockMouse.click(INTERIOR_ORIGIN_X+8,footerRenderOffset(setup.renderer)+continuationRow,MouseButtons.LEFT)
      await setup.renderOnce()
      expect(setup.captureCharFrame()).toContain(`${marker} 1  echo choice-1`)
      expect(requestCount()).toBe(2)
      expect(existsSync(setup.resultPath)).toBe(false)
      frame = await more(3,`${marker} 3  echo choice-2`)
      expect(frame.indexOf("choice-0")).toBeLessThan(frame.indexOf("choice-2"))
      await more(4,`${marker} 3  echo choice-3`)
      frame = await more(5,`${marker} 5  echo choice-4`)
      expect(setup.renderer.footerHeight).toBe(16)
      expect(frame).toContain("Risk: read only")
      expect(frame).toContain("Same explanation.")
      capture("sq10-five")
      setup.mockInput.pressKey("\u001b[6~")
      await pumpUntilFrame(setup,()=>reader().scrollHeight <= reader().height ? reader().scrollTop === 0 : reader().scrollTop > 0)
      setup.mockInput.pressKey("\u001b[5~")
      await pumpUntilFrame(setup,()=>reader().scrollTop===0)
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
      await pumpUntilFrame(setup, frame=>frame.includes("echo choice-4") && !frame.includes("Actions ·"))
      expect(requestCount()).toBe(5)
      // Clicking another rank selects it without sending or accepting.
      frame = setup.captureCharFrame()
      const row = frame.split("\n").findIndex(line=>line.includes("echo choice-0"))
      await setup.mockMouse.click(INTERIOR_ORIGIN_X+8,footerRenderOffset(setup.renderer)+row,MouseButtons.LEFT)
      await pumpUntilFrame(setup,frame=>frame.includes(`${marker} 2  echo choice-0`))
      expect(requestCount()).toBe(5)
      expect(existsSync(setup.resultPath)).toBe(false)
      await setup.mockMouse.scroll(INTERIOR_ORIGIN_X+8,footerRenderOffset(setup.renderer)+2,"down")
      await pumpUntilFrame(setup,()=>reader().scrollHeight <= reader().height ? reader().scrollTop === 0 : reader().scrollTop > 0)
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("e")
      await pumpUntilFrame(setup,frame=>frame.includes("^X W save"))
      // The native editor receives an actual end-of-buffer edit, including trailing newlines.
      setup.mockInput.pressKey("\u001b[1;5F")
      setup.mockInput.pressEnter();setup.mockInput.pressEnter()
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("w")
      await pumpUntilFrame(setup,frame=>frame.includes("Edited; not reassessed"))
      expect(reader().scrollTop).toBe(0)
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup,()=>existsSync(setup.resultPath))
      const accepted = JSON.parse(readFileSync(setup.resultPath,"utf8"))
      expect(accepted.corrected_command).toBe(responses[0]!.corrected_command+"\n\n")
      expect(Object.keys(accepted).sort()).toEqual(["confidence","corrected_command","risk","tldr"])
      expect(requestCount()).toBe(5)
    } finally {
      setup.renderer.destroy();rmSync(root,{recursive:true,force:true})
      if (previousStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = previousStateDir
      if (previousUnicode === undefined) delete process.env.NO_UNICODE
      else process.env.NO_UNICODE = previousUnicode
    }
  }, 15_000)
}

test("SQ-10 edited assessment survives reversion, duplicate, null Fix, failure and sorting", async () => {
  const root = mkdtempSync(join(tmpdir(),"shellq-sq10-rejections-"))
  const log = join(root,"requests.jsonl")
  const first = {corrected_command:"echo original", confidence:0.8, risk:"read only", tldr:"Original assessment"}
  const responses = [first, {...first, confidence:1}, {...first, corrected_command:null}, {...first,tldr:"x".repeat(501)}, {...first,corrected_command:"echo better",confidence:0.95}, {...first,corrected_command:null}]
  const provider = ["bun","-e",`
    const fs = require('node:fs');const file=${JSON.stringify(log)};
    const req=JSON.parse(await Bun.stdin.text());
    const index=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').length:0;
    fs.appendFileSync(file,JSON.stringify(req)+'\\n');
    console.log(JSON.stringify(${JSON.stringify(responses)}[index]));
  `]
  const setup = await mountWorkbench({width:100,height:24,trustedWorkdir:root,session:fixtureSession({provider,initial_intent:"correct",actionable_failure:true})})
  const requests=()=>readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line))
  const edit=async(remove:boolean)=>{
    setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("e")
    await pumpUntilFrame(setup,frame=>frame.includes("^X W save"))
    setup.mockInput.pressKey("\u001b[1;5F")
    if(remove) setup.mockInput.pressBackspace()
    else setup.mockInput.pressEnter()
    setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("w")
    await pumpUntilFrame(setup,frame=>frame.includes("Edited; not reassessed"))
  }
  try {
    await setup.mockInput.typeText("fix it");setup.mockInput.pressEnter()
    await pumpUntilFrame(setup,frame=>frame.includes("› 1  echo original")&&setup.active.process===null)
    await edit(false)
    await edit(true)
    for(let count=2;count<=5;count++) {
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
      // The provider logs and exits before the result is painted; wait for the settled frame.
      await pumpUntilFrame(setup,frame=>requests().length===count&&setup.active.process===null&&!frame.includes("Actions ·")&&!frame.includes("Waiting ·"))
      expect(requests().at(-1).input.avoid_commands).toEqual(["echo original"])
      if(count<5) {
        expect(setup.captureCharFrame()).toContain("› 1  echo original")
        expect(setup.captureCharFrame()).toContain("Edited; not reassessed")
      }
    }
    expect(setup.captureCharFrame()).toContain("› 1  echo better")
    setup.mockInput.pressArrow("down")
    await pumpUntilFrame(setup,frame=>frame.includes("› 2  echo original")&&frame.includes("Edited; not reassessed"))
    await edit(false)
    setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
    await pumpUntilFrame(setup,frame=>requests().length===6&&setup.active.process===null&&!frame.includes("Actions ·")&&!frame.includes("Waiting ·"))
    expect(requests().at(-1).input.avoid_commands).toEqual(["echo better","echo original\n"])
    expect(setup.captureCharFrame()).toContain("› 2  echo original")
    setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("h")
    await pumpUntilFrame(setup,frame=>frame.includes("Esc back"))
    for (let step=0; step<20 && !setup.captureCharFrame().includes("edited; not reassessed"); step++) {
      setup.mockInput.pressArrow("down")
      await setup.renderOnce()
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    expect(setup.captureCharFrame()).toContain("edited; not reassessed")
    setup.mockInput.pressEscape()
    await pumpUntilFrame(setup,frame=>frame.includes("› 2  echo original"))
    setup.mockInput.pressEnter()
    await pumpUntilFrame(setup,()=>existsSync(setup.resultPath))
    expect(JSON.parse(readFileSync(setup.resultPath,"utf8"))).toEqual({...first,corrected_command:"echo original\n"})
  } finally {setup.renderer.destroy();rmSync(root,{recursive:true,force:true})}
},15_000)


for (const intent of ["generate", "correct"] as const) {
  test(`batch candidates through Codex wrapper: ${intent}, ranking, add, limit and insertion`, async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-batch-ui-"))
    const oldPath = process.env.PATH
    const oldZdotdir = process.env.ZDOTDIR
    process.env.ZDOTDIR = root
    const log = join(root, "requests.jsonl")
    const executable = join(root, "codex")
    writeFileSync(executable, `#!/usr/bin/env bun
      import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
      const args=process.argv.slice(2);
      const prompt=args.at(-1);
      const file=prompt.match(/^Read (.+) and return only/)[1];
      const request=JSON.parse(readFileSync(file,'utf8'));
      appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
      const item=(n,confidence)=>({corrected_command:'echo choice-'+n+'\\necho tail-'+n+'\\n',confidence,risk:'read only',tldr:'Use this approach to inspect files. The flags limit output.'});
      const response=request.candidate_count===3 ? {candidates:[item(0,0.8),item(1,0.95),item(2,0.8)]} : item(request.input.avoid_commands.length,0.5);
      writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(response));
    `)
    chmodSync(executable,0o700)
    process.env.PATH = root + ":" + oldPath
    const setup = await mountWorkbench({width:100,height:24,trustedWorkdir:root,session:fixtureSession({
      provider:[BUNDLED_CODEX_PROVIDER], initial_intent:intent, actionable_failure:intent==="correct",
    })})
    const requests = () => existsSync(log) ? readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line)) : []
    try {
      await setup.mockInput.typeText("list files");setup.mockInput.pressEnter()
      // The list grows one frame after the first choice paints.
      let frame = await pumpUntilFrame(setup,frame=>frame.includes("› 1  echo choice-1")&&frame.includes("choice-0")&&frame.includes("choice-2")&&setup.active.process===null)
      expect(requests()).toHaveLength(1)
      expect(requests()[0].candidate_count).toBe(3)
      expect(frame).toContain("Enter insert (never runs)")
      expect(frame.indexOf("choice-1")).toBeLessThan(frame.indexOf("choice-0"))
      expect(frame.indexOf("choice-0")).toBeLessThan(frame.indexOf("choice-2"))
      expect(existsSync(setup.resultPath)).toBe(false)
      for (const count of [4,5]) {
        setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
        frame=await pumpUntilFrame(setup,frame=>frame.includes(`› ${count}  echo choice-${count-1}`)&&setup.active.process===null)
        expect(frame).toContain("Enter insert (never runs)")
        expect(requests().at(-1).candidate_count).toBeUndefined()
        expect(requests().at(-1).input.avoid_commands).toHaveLength(count-1)
      }
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
      await pumpUntilFrame(setup,frame=>frame.includes("five suggestions") || frame.includes("unknown ctrl-x chord"))
      expect(requests()).toHaveLength(3)
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup,()=>existsSync(setup.resultPath))
      expect(JSON.parse(readFileSync(setup.resultPath,"utf8"))).toEqual({
        corrected_command:"echo choice-4\necho tail-4\n", confidence:0.5, risk:"read only",
        tldr:"Use this approach to inspect files. The flags limit output.",
      })
    } finally {
      setup.renderer.destroy();process.env.PATH=oldPath;
      if (oldZdotdir === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR=oldZdotdir;rmSync(root,{recursive:true,force:true})
    }
  })
}

for (const [confidence, risk, riskColor, confidenceColor] of [
  [0.9, "High; deletes files", "#EF4444", "#10B981"],
  [0.899, "Medium; changes files", "#F59E0B", "#F59E0B"],
  [0.7, "Low; read-only", "#10B981", "#F59E0B"],
  [0.699, "unknown", "#FFFFFF", "#EF4444"],
] as const) {
  test(`result assessment colors stay independent at ${confidence} confidence and ${risk}`, async () => {
    const response = {corrected_command:"printf 'review only'", tldr:"Read the command before inserting it.", confidence, risk}
    const setup = await mountWorkbench({width:42,height:24,session:fixtureSession({provider:["bun","-e",`await Bun.stdin.text();console.log(${JSON.stringify(JSON.stringify(response))})`]})})
    try {
      await setup.mockInput.typeText("example");setup.mockInput.pressEnter()
      const frame = await pumpUntilFrame(setup, f=>f.includes("Confidence:") && !setup.active.process)
      expect(frame).not.toContain("Model")
      const line=setup.captureSpans().lines.find(l=>l.spans.some(s=>s.text.includes("Confidence:")))!
      const hex=(c:any)=>"#"+[c.r,c.g,c.b].map(n=>Math.round(n*255).toString(16).padStart(2,"0")).join("").toUpperCase()
      const percent=`${Math.floor(confidence*100)}%`
      expect(hex(line.spans.find(s=>s.text===percent)!.fg)).toBe(confidenceColor)
      expect(hex(line.spans.find(s=>s.text===risk.split(";")[0])!.fg)).toBe(riskColor)
      expect(frame).toContain("Choices · selected 1 of 1")
      expect(existsSync(setup.resultPath)).toBe(false)
      await setup.mockMouse.click(INTERIOR_ORIGIN_X+20,footerRenderOffset(setup.renderer)+1,MouseButtons.LEFT)
      await pumpUntilFrame(setup,f=>f.includes("› confidence") && f.includes("Provider"))
      expect(existsSync(setup.resultPath)).toBe(false)
    } finally { setup.renderer.destroy() }
  })
}

test("short terminal keeps the selected fifth command visible and highlights trailing cells", async () => {
  const root=mkdtempSync(join(tmpdir(),"shellq-short-review-"))
  const log=join(root,"count")
  const provider=["bun","-e",`const fs=require('node:fs');await Bun.stdin.text();const n=fs.existsSync(${JSON.stringify(log)})?Number(fs.readFileSync(${JSON.stringify(log)},'utf8'))+1:1;fs.writeFileSync(${JSON.stringify(log)},String(n));console.log(JSON.stringify({corrected_command:'echo '+n,tldr:'Inspect this command.',confidence:1-n/10,risk:'Low'}))`]
  const setup=await mountWorkbench({width:80,height:9,trustedWorkdir:root,session:fixtureSession({provider})})
  try {
    await setup.mockInput.typeText("example");setup.mockInput.pressEnter()
    await pumpUntilFrame(setup,f=>f.includes("› 1  echo 1")&&!setup.active.process)
    for (let n=2;n<=5;n++) {
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("a")
      await pumpUntilFrame(setup,f=>f.includes(`› ${n}  echo ${n}`)&&!setup.active.process)
    }
    const frame=setup.captureSpans()
    const selected=frame.lines.find(l=>l.spans.some(s=>s.text.includes("› 5  echo 5")))!
    const span=selected.spans.find(s=>s.text.includes("› 5  echo 5"))!
    expect(span.text.trimEnd()).toBe("› 5  echo 5")
    expect(span.width).toBe(frameLayout(80).interior)
    expect(span.bg.a).toBe(1)
    expect(existsSync(setup.resultPath)).toBe(false)
    setup.mockInput.pressEnter()
    await pumpUntilFrame(setup,()=>existsSync(setup.resultPath))
    expect(JSON.parse(readFileSync(setup.resultPath,"utf8")).corrected_command).toBe("echo 5")
  } finally {setup.renderer.destroy();rmSync(root,{recursive:true,force:true})}
})

for (const intent of ["generate","correct"] as const) {
  test(`App Server ${intent} projects structured preview before its final seal`, async () => {
    const root=mkdtempSync(join(tmpdir(),"shellq-app-preview-"))
    const saved={PATH:process.env.PATH,SHELLQ_STATE_DIR:process.env.SHELLQ_STATE_DIR,SHELLQ_APP_SERVER_REUSE:process.env.SHELLQ_APP_SERVER_REUSE,FAKE_LOG:process.env.FAKE_LOG}
    const reply={tldr:"Preview before the final seal.",corrected_command:"echo app-server",confidence:0.9,risk:"Low"}
    const fake=REUSE_UI_FAKE.replace('JSON.stringify({ tldr: "fixture suggestion", corrected_command: "echo app-server", confidence: 0.8, risk: "low" })',`JSON.stringify(${JSON.stringify({candidates:[reply]})})`).replace('send({ method: "item/completed", params:', 'await Bun.sleep(500); send({ method: "item/completed", params:')
    writeFileSync(join(root,"codex"),fake,{mode:0o700})
    process.env.PATH=root+":"+saved.PATH;process.env.SHELLQ_STATE_DIR=join(root,"state");process.env.SHELLQ_APP_SERVER_REUSE="1";process.env.FAKE_LOG=join(root,"log")
    let setup:Awaited<ReturnType<typeof mountWorkbench>>|null=null
    try {
      setup=await mountWorkbench({width:80,height:24,trustedWorkdir:root,session:fixtureSession({provider:[BUNDLED_CODEX_PROVIDER],provider_source:"default",codex_ask_engine:"app-server",initial_intent:intent,actionable_failure:intent==="correct"})})
      setup.mockInput.pressKey("u",{ctrl:true});await setup.mockInput.typeText("test preview");setup.mockInput.pressEnter()
      const preview=await pumpUntilFrame(setup,f=>f.includes("Preview before the final seal."))
      expect(preview).toContain("Generating · preview only")
      expect(preview).not.toContain('"candidates"')
      expect(preview).not.toContain("Choices · selected")
      setup.mockInput.pressEnter();await setup.renderOnce()
      expect(existsSync(setup.resultPath)).toBe(false)
      await pumpUntilFrame(setup,f=>f.includes("› 1  echo app-server"))
      setup.mockInput.pressEnter()
      await pumpUntilFrame(setup,()=>existsSync(setup!.resultPath))
      expect(JSON.parse(readFileSync(setup.resultPath,"utf8"))).toEqual(reply)
    } finally {
      setup?.renderer.destroy();await setup?.active.closing
      for(const [key,value] of Object.entries(saved)) if(value===undefined) delete process.env[key];else process.env[key]=value
      rmSync(root,{recursive:true,force:true})
    }
  })
}

for (const width of [42, 100]) {
  test(`choices stay above the footer and risk appears once at ${width} columns`, async () => {
    const response = {corrected_command: "ls -t", tldr: "List files, newest first.", confidence: 0.95, risk: "Low: read-only listing"}
    const setup = await mountWorkbench({width, height: 24, session: fixtureSession({provider: ["bun", "-e", `await Bun.stdin.text();console.log(${JSON.stringify(JSON.stringify(response))})`]})})
    try {
      await setup.mockInput.typeText("list files"); setup.mockInput.pressEnter()
      await pumpUntilFrame(setup, f => f.includes("› 1  ls -t") && !setup.active.process)
      setup.mockInput.pressKey("x", {ctrl: true}); setup.mockInput.pressKey("h")
      await pumpUntilFrame(setup, f => f.includes("Esc back"))
      setup.mockInput.pressEscape()
      const frame = await pumpUntilFrame(setup, f => f.includes("› 1  ls -t"))
      const lines = frame.trimEnd().split("\n")
      expect(lines.at(-2)).toContain("› 1  ls -t")
      expect(frame.match(/Risk:/g)).toHaveLength(1)
      expect(frame.match(/read-only listing/g)).toHaveLength(1)
      expect(frame).toContain("List files, newest first.")
      expect(lines.find(line => line.includes("Confidence:"))).not.toContain("Impact:")
      const spans = setup.captureSpans().lines.flatMap(line => line.spans)
      const impactLabel = spans.find(span => span.text === "Impact:")!
      const riskLabel = spans.find(span => span.text === "Risk: ")!
      expect(impactLabel.fg).toEqual(riskLabel.fg)
      const consequence = spans.find(span => span.text.includes("read-only listing"))!
      expect(consequence.fg).not.toEqual(impactLabel.fg)
      expect(frame).toContain("Impact: read-only listing")
      expect(lines.at(-1)).not.toContain("thinking")
      expect(lines.at(-1)).not.toContain("Attach output")
      if (width === 100) expect(lines.at(-1)).toContain("Enter insert (never runs)")
      const reader = setup.renderer.root.findDescendantById("candidate-description") as any
      setup.mockInput.pressKey("\u001b[6~")
      await setup.renderOnce()
      expect(reader.scrollTop).toBe(0)
      expect(reader.verticalScrollBar.visible).toBe(false)
      expect(existsSync(setup.resultPath)).toBe(false)
      if (process.env.SHELLQ_POLISH_CAPTURE_DIR) writeFileSync(join(process.env.SHELLQ_POLISH_CAPTURE_DIR, `anchored-${width}.txt`), setup.captureCharFrame())
    } finally { setup.renderer.destroy() }
  })
}

test("initial choices menu persists across reopening and controls bundled requests", async () => {
  const root=mkdtempSync(join(tmpdir(),"shellq-count-menu-"))
  const saved={PATH:process.env.PATH,ZDOTDIR:process.env.ZDOTDIR,SHELLQ_STATE_DIR:process.env.SHELLQ_STATE_DIR}
  const log=join(root,"requests.jsonl")
  writeFileSync(join(root,"codex"),`#!/usr/bin/env bun
    import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
    const args=process.argv.slice(2);const path=args.at(-1).match(/^Read (.+) and return only/)[1];
    const request=JSON.parse(readFileSync(path,'utf8'));appendFileSync(${JSON.stringify(log)},JSON.stringify(request)+'\\n');
    const count=request.candidate_count??1;const candidates=Array.from({length:count},(_,n)=>({corrected_command:'echo '+n,tldr:'Print the number.',risk:'Low: output only',confidence:0.95-n/10}));
    writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(count===1?candidates[0]:{candidates}));
  `,{mode:0o700})
  process.env.PATH=root+":"+saved.PATH;process.env.ZDOTDIR=root;process.env.SHELLQ_STATE_DIR=join(root,"state")
  const create=()=>mountWorkbench({width:100,height:24,trustedWorkdir:root,session:fixtureSession({provider:[BUNDLED_CODEX_PROVIDER]})})
  let setup:Awaited<ReturnType<typeof create>>|null=null
  try {
    for(const count of [5,2,1]) {
      setup=await create()
      setup.mockInput.pressKey("x",{ctrl:true});setup.mockInput.pressKey("s")
      await pumpUntilFrame(setup,f=>f.includes("Initial choices"))
      await setup.mockInput.typeText(`${count} initial`)
      await pumpUntilFrame(setup,f=>f.includes(`${count} initial choice`))
      if (count === 5) {
        const frame = setup.captureCharFrame()
        const row = frame.split("\n").findIndex(line => line.includes("5 initial choices"))
        expect(row).toBeGreaterThan(0)
        await setup.mockMouse.click(INTERIOR_ORIGIN_X+5,footerRenderOffset(setup.renderer)+row,MouseButtons.LEFT)
      } else setup.mockInput.pressEnter()
      await pumpUntilFrame(setup,()=>existsSync(join(root,"state/settings.json"))&&JSON.parse(readFileSync(join(root,"state/settings.json"),"utf8")).initialChoices===count)
      expect(existsSync(log)).toBe(count!==5)
      setup.renderer.destroy();await setup.active.closing;setup=null
      setup=await create()
      await setup.mockInput.typeText("print number");setup.mockInput.pressEnter()
      const frame=await pumpUntilFrame(setup,f=>f.includes(`selected 1 of ${count}`)&&!setup!.active.process)
      const requests=readFileSync(log,"utf8").trim().split("\n").map(s=>JSON.parse(s))
      expect(requests.at(-1).candidate_count??1).toBe(count)
      expect(frame).toContain("› 1  echo 0")
      expect(existsSync(setup.resultPath)).toBe(false)
      setup.renderer.destroy();await setup.active.closing;setup=null
    }
  } finally {
    setup?.renderer.destroy();await setup?.active.closing
    for(const [key,value] of Object.entries(saved)) if(value===undefined) delete process.env[key];else process.env[key]=value
    rmSync(root,{recursive:true,force:true})
  }

})

test("a long final description grows the frame beyond the compact preview ceiling", async () => {
  const response={corrected_command:"ls",tldr:"Inspect files carefully. ".repeat(18),confidence:0.95,risk:"High: irreversible effects across the directory tree"}
  const previousStateDir = process.env.SHELLQ_STATE_DIR
  const stateDir = mkdtempSync(join(tmpdir(), "shellq-sq11-max16-"))
  seedStateRoot(stateDir, { maxFooterRows: 16 })
  process.env.SHELLQ_STATE_DIR = stateDir
  const setup=await mountWorkbench({width:42,height:24,session:fixtureSession({provider:["bun","-e",`await Bun.stdin.text();console.log(${JSON.stringify(JSON.stringify(response))})`]})})
  try {
    await setup.mockInput.typeText("inspect");setup.mockInput.pressEnter()
    await pumpUntilFrame(setup,f=>f.includes("› 1  ls")&&!setup.active.process)
    expect(setup.renderer.footerHeight).toBe(16)
    expect(setup.captureCharFrame().trimEnd().split("\n").at(-2)).toContain("› 1  ls")
    expect(existsSync(setup.resultPath)).toBe(false)
  } finally {
    setup.renderer.destroy()
    if (previousStateDir === undefined) delete process.env.SHELLQ_STATE_DIR
    else process.env.SHELLQ_STATE_DIR = previousStateDir
    rmSync(stateDir,{recursive:true,force:true})
  }
})

/* Focused mounted checks for bounded endpoint discovery and endpoint-aware
 * selection. Every probe runs against disposable loopback fixtures on ports
 * pinned through SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS — never the real fixed
 * ports, the developer's own server, or any saved user endpoint. */
describe("mounted workbench: local endpoint discovery scan", () => {
  const LOCAL_ADAPTER = adapterPath(descriptorForProvider(LOCAL_PROVIDER_ID))

  type ScanFixture = {
    port: number
    endpoint: string
    hits: Array<{ method: string; path: string }>
    posts: Array<Record<string, any>>
    catalog: string[]
    hold: (value: boolean) => void
    release: () => void
    close: () => Promise<void>
  }

  const startScanFixture = (catalog: string[]): Promise<ScanFixture> =>
    new Promise((resolve) => {
      const hits: Array<{ method: string; path: string }> = []
      const posts: Array<Record<string, any>> = []
      const sockets = new Set<Socket>()
      let holdModels = false
      const held: Array<() => void> = []
      let fixture: ScanFixture
      const server = createServer((req, res) => {
        // Foreign loopback probes carry a User-Agent; the adapter never does.
        if (req.headers["user-agent"]) {
          res.writeHead(404)
          res.end()
          return
        }
        hits.push({ method: req.method ?? "", path: req.url ?? "" })
        if (req.url === "/v1/models") {
          const respond = () => {
            if (res.destroyed) return
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ object: "list", data: fixture.catalog.map((id) => ({ id })) }))
          }
          if (holdModels) {
            // The GET arrived but is never answered until release(); the
            // socket may already be gone by then, which is the point.
            res.on("error", () => {})
            held.push(respond)
          } else {
            respond()
          }
          return
        }
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", () => {
          let request: Record<string, any> = {}
          try { request = JSON.parse(body) } catch {}
          posts.push(request)
          // Mirror the adapter's schema contract: a candidates schema gets the
          // wrapped shape, everything else the single flat candidate.
          const wantsCandidates = Boolean(
            request?.response_format?.json_schema?.schema?.properties?.candidates,
          )
          const candidate = {
            tldr: "lists the files", corrected_command: "ls -la", confidence: 0.9, risk: "Low: reads a directory listing",
          }
          const content = JSON.stringify(wantsCandidates ? { candidates: [candidate] } : candidate)
          if (request.stream === true) {
            // Streaming contract: a content delta carrying the schema-correct
            // response JSON, a stop finish_reason, then [DONE].
            res.writeHead(200, { "Content-Type": "text/event-stream" })
            const event = (delta: Record<string, unknown>, finish?: string) =>
              `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
            res.end(event({ role: "assistant", content }) + event({}, "stop") + "data: [DONE]\n\n")
            return
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          }))
        })
      })
      server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("no port")
        fixture = {
          port: address.port,
          endpoint: `http://127.0.0.1:${address.port}/v1`,
          hits, posts, catalog: [...catalog],
          hold: (value) => { holdModels = value },
          release: () => {
            holdModels = false
            for (const respond of held.splice(0)) respond()
          },
          close: () => new Promise<void>((done) => { server.close(() => done()); for (const s of sockets) s.destroy() }),
        }
        resolve(fixture)
      })
    })

  // Minimal PATH (bun for the adapter shim, zsh for its shebang), an isolated
  // state dir, and pinned scan ports; the saved endpoint is fixture A, so the
  // default port 8000 is never probed by these tests.
  const withScanEnvironment = async (
    body: (a: ScanFixture, b: ScanFixture, root: string) => Promise<void>,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "shellq-scan-ui-test-"))
    const bin = join(root, "bin")
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, "bun"))
    for (const zsh of ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]) {
      if (existsSync(zsh)) { symlinkSync(zsh, join(bin, "zsh")); break }
    }
    const a = await startScanFixture(["fixture-alpha"])
    const b = await startScanFixture(["fixture-alpha"])
    const previous = {
      path: process.env.PATH,
      stateDir: process.env.SHELLQ_STATE_DIR,
      scanPorts: process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS,
      endpoint: process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT,
    }
    process.env.PATH = bin
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS = `${a.port},${b.port}`
    delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
    writePersistedLocalEndpoint(a.endpoint, "codex")
    try {
      await body(a, b, root)
    } finally {
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path
      if (previous.stateDir === undefined) delete process.env.SHELLQ_STATE_DIR; else process.env.SHELLQ_STATE_DIR = previous.stateDir
      if (previous.scanPorts === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS; else process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS = previous.scanPorts
      if (previous.endpoint === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT; else process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = previous.endpoint
      await a.close()
      await b.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const codexSession = () =>
    fixtureSession({
      provider: [BUNDLED_CODEX_PROVIDER],
      provider_id: "codex",
      provider_source: "default",
      codex_ask_engine: null,
    })

  const localSession = (overrides: Partial<WorkbenchSession> = {}) =>
    fixtureSession({
      initial_intent: "generate",
      provider: [LOCAL_ADAPTER],
      provider_id: LOCAL_PROVIDER_ID,
      provider_source: "default",
      model: "",
      reasoning: "endpoint default",
      models: [],
      reasoning_levels: ["endpoint default"],
      ...overrides,
    })

  const openPalette = async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("s")
    await pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
  }

  const focusedRowIncludes = (setup: Awaited<ReturnType<typeof mountWorkbench>>, needle: string) =>
    focusedSelectionLine(setup)?.spans.some((span) => "text" in span && String(span.text).includes(needle)) ?? false

  test("opening settings with Codex active discovers local models without touching provider or draft, and reopening refreshes", async () => {
    await withScanEnvironment(async (a, b, root) => {
      const setup = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
      try {
        await setup.mockInput.typeText("keep this draft")
        await openPalette(setup)
        // The root palette shows navigation; typing surfaces the live scan's
        // model leaves even while Codex is active. The typed query also matches
        // the search input, so wait for the highlighted model row itself.
        await setup.mockInput.typeText("fixture-alpha")
        await pumpUntilFrame(setup, () =>
          focusedSelectionLine(setup)?.spans.some((span) => "text" in span && String(span.text).includes("fixture-alpha")) ?? false,
        { tries: 160 })
        expect(a.hits.length).toBeGreaterThan(0)
        expect(b.hits.length).toBeGreaterThan(0)
        expect(a.posts).toEqual([])
        expect(b.posts).toEqual([])
        expect([...a.hits, ...b.hits].every((hit) => hit.method === "GET" && hit.path === "/v1/models")).toBe(true)
        await closePalette(setup)
        // The palette hides the composer, so the surviving draft is asserted
        // after close, alongside the untouched provider selection.
        expect(setup.captureCharFrame()).toContain("keep this draft")
        expect(readPersistedInferenceDocument()?.provider).toBe("codex")
        expect(readPersistedInferenceDocument()?.providers[LOCAL_PROVIDER_ID]).toBeUndefined()

        // A changed catalog is picked up on the next opening.
        a.catalog = ["fixture-beta"]
        await openPalette(setup)
        await setup.mockInput.typeText("fixture-beta")
        await pumpUntilFrame(setup, () =>
          focusedSelectionLine(setup)?.spans.some((span) => "text" in span && String(span.text).includes("fixture-beta")) ?? false,
        { tries: 160 })
        expect(setup.captureCharFrame()).not.toContain("fixture-alpha")
        await closePalette(setup)
        expect(setup.captureCharFrame()).toContain("keep this draft")
      } finally { setup.renderer.destroy() }
    })
  })

  test("the same model on two endpoints is two choices; selecting one persists its exact URL and submits only there", async () => {
    await withScanEnvironment(async (a, b, root) => {
      const setup = await mountWorkbench({ width: 80, height: 24, session: localSession(), trustedWorkdir: root })
      try {
        await openPalette(setup)
        await setup.mockInput.typeText("fixture-alpha")
        // Both endpoint rows for the same ID render, distinguished by port.
        await pumpUntilFrame(
          setup,
          (frame) => frame.includes(`fixture-alpha :${a.port}`) && frame.includes(`fixture-alpha :${b.port}`),
          { tries: 160 },
        )
        // Step focus to endpoint B and wait for the highlighted row itself to
        // change — the typed query string alone never identifies a row.
        const focusedSpanHas = (needle: string) =>
          focusedSelectionLine(setup)?.spans.some((span) => "text" in span && String(span.text).includes(needle)) ?? false
        let guard = 0
        while (!focusedSpanHas(`:${b.port}`)) {
          if (guard++ > 6) throw new Error(`endpoint B row never focused\n${setup.captureCharFrame()}`)
          setup.mockInput.pressArrow("down")
          try {
            await pumpUntilFrame(setup, () => focusedSpanHas(`:${b.port}`), { tries: 4, delayMs: 20 })
          } catch {}
        }
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("Search Effort:"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Search All:") && !frame.includes("Search Effort:"))

        const document = readPersistedInferenceDocument()
        expect(document?.provider).toBe(LOCAL_PROVIDER_ID)
        expect(document?.localEndpoint).toBe(b.endpoint)
        expect(document?.providers[LOCAL_PROVIDER_ID]).toEqual({ model: "fixture-alpha", reasoning: "endpoint default" })
        const aPostsBeforeTurn = a.posts.length
        const aHitsBeforeTurn = a.hits.length
        const bPostsBeforeTurn = b.posts.length
        const bHitsBeforeTurn = b.hits.length
        await closePalette(setup)

        // Reopening restores the saved pair exactly like the real session
        // loader: prepareProviderSession re-reads the persisted document and
        // resolves the saved endpoint before mounting, so the fresh workbench
        // preflights and posts only to endpoint B, and endpoint A never sees
        // the turn.
        const restored = localSession()
        prepareProviderSession(restored)
        expect(restored.model).toBe("fixture-alpha")
        expect(restored.localEndpoint?.endpoint).toBe(b.endpoint)
        const second = await mountWorkbench({
          width: 80,
          height: 24,
          session: restored,
          trustedWorkdir: root,
        })
        try {
          await second.mockInput.typeText("ls")
          await pumpUntilFrame(second, (frame) => frame.includes("ls"), { tries: 40 })
          second.mockInput.pressEnter()
          await pumpUntilFrame(second, (frame) => frame.includes("› 1  ls -la") && second.active.process === null, { tries: 160 })
          expect(b.hits.length).toBeGreaterThan(bHitsBeforeTurn)
          expect(b.posts.length).toBeGreaterThan(bPostsBeforeTurn)
          expect(b.posts.at(-1)?.model).toBe("fixture-alpha")
          expect(a.hits.length).toBe(aHitsBeforeTurn)
          expect(a.posts.length).toBe(aPostsBeforeTurn)
          // The request must be fully finished before acceptance, and the
          // rail must actually offer insertion — the streamed preview can
          // show the command before the candidate phase begins.
          await pumpUntilFrame(second, () => second.active.process === null, { tries: 160 })
          await pumpUntilFrame(second, (frame) => frame.includes("Enter insert (never runs)"), { tries: 160 })
          second.mockInput.pressEnter()
          expect(second.active.process).toBeNull()
          let resultText = ""
          for (let pass = 0; pass < 40; pass += 1) {
            resultText = existsSync(second.resultPath) ? readFileSync(second.resultPath, "utf8") : ""
            if (resultText.includes("ls -la")) break
            await second.renderOnce()
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          expect(resultText).toContain("ls -la")
        } finally { second.renderer.destroy() }
      } finally { setup.renderer.destroy() }
    })
  })

  test("a valid override restricts probes to it; an invalid override sends no traffic", async () => {
    await withScanEnvironment(async (a, b, root) => {
      // The environment is fixed for a real invocation, so each phase mounts
      // a fresh workbench instead of mutating a live one's override.
      process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = b.endpoint
      const valid = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
      try {
        const aHitsBeforeValid = a.hits.length
        await openPalette(valid)
        await valid.mockInput.typeText("fixture-alpha")
        // One endpoint in play, so the leaf carries no port hint; wait for the
        // highlighted row itself, never the query text.
        await pumpUntilFrame(valid, () => focusedRowIncludes(valid, "fixture-alpha"), { tries: 160 })
        expect(a.hits.length).toBe(aHitsBeforeValid)
        expect(b.hits.length).toBeGreaterThan(0)
        expect(b.hits.every((hit) => hit.method === "GET" && hit.path === "/v1/models")).toBe(true)
        await closePalette(valid)
        await pumpUntilFrame(valid, () => valid.active.discoveryProcess === null, { tries: 80 })
      } finally { valid.renderer.destroy() }

      // An invalid override cannot be probed: no new fixture HTTP and no scan
      // process at all.
      process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = "http://localhost:9/v1"
      const recorded: Array<{ exited: Promise<number> }> = []
      const previousSpawn = Bun.spawn
      Bun.spawn = ((...args: any[]) => {
        const child = previousSpawn(...(args as Parameters<typeof Bun.spawn>))
        if (Array.isArray(args[0]) && String(args[0][0]).includes("local-openai-provider")) {
          recorded.push({ exited: child.exited })
        }
        return child
      }) as typeof Bun.spawn
      const aHitsBeforeInvalid = a.hits.length
      const bHitsBeforeInvalid = b.hits.length
      try {
        const invalid = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
        try {
          await openPalette(invalid)
          await invalid.mockInput.typeText("fixture-alpha")
          await new Promise((resolve) => setTimeout(resolve, 300))
          expect(invalid.captureCharFrame()).not.toContain("fixture-alpha :")
          expect(a.hits.length).toBe(aHitsBeforeInvalid)
          expect(b.hits.length).toBe(bHitsBeforeInvalid)
          expect(recorded).toEqual([])
          expect(invalid.active.discoveryProcess).toBeNull()
          await closePalette(invalid)
        } finally { invalid.renderer.destroy() }
      } finally { Bun.spawn = previousSpawn }
    })
  })

  test("closing the palette cancels the scan, reaps its process, and blocks late publication", async () => {
    await withScanEnvironment(async (a, _b, root) => {
      const recorded: Array<{ exited: Promise<number> }> = []
      const previousSpawn = Bun.spawn
      Bun.spawn = ((...args: any[]) => {
        const child = previousSpawn(...(args as Parameters<typeof Bun.spawn>))
        if (Array.isArray(args[0]) && String(args[0][0]).includes("local-openai-provider")) {
          recorded.push({ exited: child.exited })
        }
        return child
      }) as typeof Bun.spawn
      const setup = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
      try {
        // Hold A's real models GET so the scan is genuinely in flight at the
        // close: B may finish, A cannot answer, so nothing can publish first.
        a.hold(true)
        await openPalette(setup)
        await pumpUntilFrame(setup, () =>
          recorded.length > 0 &&
          setup.active.discoveryProcess !== null &&
          a.hits.some((hit) => hit.method === "GET" && hit.path === "/v1/models"),
        { tries: 160 })
        await closePalette(setup)
        for (const child of recorded) {
          const code = await Promise.race([
            child.exited,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("scan process survived close")), 3_000)),
          ])
          expect(typeof code).toBe("number")
        }
        expect(setup.active.discoveryProcess).toBeNull()
        // The held response is released only after the child is gone, so the
        // late response cannot publish; the changed catalog surfaces through
        // a fresh scan on reopen, waited on as an actual model row.
        a.catalog = ["fixture-late"]
        a.release()
        await new Promise((resolve) => setTimeout(resolve, 200))
        await openPalette(setup)
        await setup.mockInput.typeText("fixture-late")
        await pumpUntilFrame(setup, () => focusedRowIncludes(setup, "fixture-late"), { tries: 160 })
        await closePalette(setup)
      } finally {
        Bun.spawn = previousSpawn
        a.release()
        setup.renderer.destroy()
      }
    })
  })

  test("Setup probes GET-only while Doctor and the main mount stay silent, and config changes gate discovery", async () => {
    await withScanEnvironment(async (a, b, root) => {
      // Third disposable listener on a custom port that is NOT in the pinned
      // scan list, so only an explicit saved endpoint can reach it.
      const c = await startScanFixture(["fixture-custom"])
      const settingsPath = inferenceSettingsFile(process.env)
      const previousSpawn = Bun.spawn
      let spawned = 0
      const recordSpawns = () => {
        Bun.spawn = ((...args: any[]) => {
          if (Array.isArray(args[0]) && String(args[0][0]).includes("local-openai-provider")) spawned += 1
          return previousSpawn(...(args as Parameters<typeof Bun.spawn>))
        }) as typeof Bun.spawn
      }
      const restoreSpawn = () => { Bun.spawn = previousSpawn }
      try {
        // The main mount itself performs zero local HTTP.
        const setup = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
        try {
          expect(a.hits.length + b.hits.length + c.hits.length).toBe(0)
          // Provider Setup entry (Ctrl-X P) discovers with models GETs only
          // and never switches provider or selects a model.
          const bHitsBeforeSetup = b.hits.length
          setup.mockInput.pressKey("x", { ctrl: true })
          setup.mockInput.pressKey("p")
          await pumpUntilFrame(setup, (frame) => frame.includes("Provider Setup"))
          await pumpUntilFrame(setup, () => b.hits.length > bHitsBeforeSetup, { tries: 160 })
          expect([...a.hits, ...b.hits].every((hit) => hit.method === "GET" && hit.path === "/v1/models")).toBe(true)
          expect([...a.posts, ...b.posts, ...c.posts]).toEqual([])
          expect(readPersistedInferenceDocument()?.provider).toBe("codex")
          expect(readPersistedInferenceDocument()?.providers[LOCAL_PROVIDER_ID]).toBeUndefined()
          // Setup is not the picker, so it closes on Escape, not closePalette.
          setup.mockInput.pressEscape()
          await pumpUntilFrame(setup, (frame) => !frame.includes("Provider Setup"), { tries: 40 })
          await pumpUntilFrame(setup, () => setup.active.discoveryProcess === null, { tries: 80 })

          // Doctor itself remains free of local HTTP.
          const hitsBeforeDoctor = a.hits.length + b.hits.length + c.hits.length
          await openDoctorViaAction(setup)
          expect(a.hits.length + b.hits.length + c.hits.length).toBe(hitsBeforeDoctor)
        } finally { setup.renderer.destroy() }

        // A direct external settings.json edit repoints the saved endpoint at
        // the custom fixture; the mount predates the edit, so settings entry
        // must reread the change and discover the custom fixture's unique
        // model there, leaving the rest of the document intact.
        recordSpawns()
        const external = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
        try {
          const handEdited = JSON.parse(readFileSync(settingsPath, "utf8"))
          handEdited.localEndpoint = c.endpoint
          writeFileSync(settingsPath, JSON.stringify(handEdited, null, 2))
          await openPalette(external)
          await external.mockInput.typeText("fixture-custom")
          await pumpUntilFrame(external, () => focusedRowIncludes(external, "fixture-custom"), { tries: 160 })
          expect(external.captureCharFrame()).toContain(`fixture-custom :${c.port}`)
          expect(c.hits.length).toBeGreaterThan(0)
          expect(c.hits.every((hit) => hit.method === "GET" && hit.path === "/v1/models")).toBe(true)
          expect(c.posts).toEqual([])
          await closePalette(external)
          await pumpUntilFrame(external, () => external.active.discoveryProcess === null, { tries: 80 })
        } finally { external.renderer.destroy() }
        const externalDocument = readPersistedInferenceDocument()
        expect(externalDocument?.provider).toBe("codex")
        expect(externalDocument?.localEndpoint).toBe(c.endpoint)

        // Malformed settings before a fresh mount block all discovery: no
        // scan process, no fixture traffic, and no implicit repair.
        writeFileSync(settingsPath, "{ not json")
        const blockedBefore = { a: a.hits.length, b: b.hits.length, c: c.hits.length }
        spawned = 0
        const blocked = await mountWorkbench({ width: 80, height: 24, session: codexSession(), trustedWorkdir: root })
        try {
          await openPalette(blocked)
          await blocked.mockInput.typeText("fixture-alpha")
          await new Promise((resolve) => setTimeout(resolve, 300))
          expect(blocked.captureCharFrame()).not.toContain("fixture-alpha :")
          expect(a.hits.length).toBe(blockedBefore.a)
          expect(b.hits.length).toBe(blockedBefore.b)
          expect(c.hits.length).toBe(blockedBefore.c)
          expect(spawned).toBe(0)
          expect(blocked.active.discoveryProcess).toBeNull()
          expect(readFileSync(settingsPath, "utf8")).toBe("{ not json")
          await closePalette(blocked)
        } finally { blocked.renderer.destroy() }
      } finally {
        restoreSpawn()
        await c.close()
      }
    })
  }, 30_000)

  test("endpoint hints stay readable at 80 and 140 columns and pointer focus works", async () => {
    await withScanEnvironment(async (a, b, root) => {
      for (const width of [80, 140]) {
        const setup = await mountWorkbench({ width, height: 24, session: codexSession(), trustedWorkdir: root })
        try {
          await openPalette(setup)
          await setup.mockInput.typeText("fixture-alpha")
          await pumpUntilFrame(setup, (frame) => frame.includes(`fixture-alpha :${b.port}`), { tries: 160 })
          const frame = setup.captureCharFrame()
          expect(frame).toContain(`fixture-alpha :${a.port}`)
          const lines = frame.trimEnd().split("\n")
          const row = lines.findIndex((line) => line.includes(`:${b.port}`))
          expect(row).toBeGreaterThanOrEqual(0)
          // The captured frame is the footer band itself, so a frame line index
          // is band-relative; the raw mock click adds the band's screen offset.
          const y = footerRenderOffset(setup.renderer) + row
          await setup.mockMouse.click(lines[row].indexOf(`:${b.port}`), y, MouseButtons.LEFT)
          // A click APPLIES the model leaf: the exact pair is persisted and the
          // palette advances to Effort; focus need not remain on the row.
          await pumpUntilFrame(setup, (frame) => frame.includes("Search Effort:"), { tries: 80 })
          const document = readPersistedInferenceDocument()
          expect(document?.localEndpoint).toBe(b.endpoint)
          expect(document?.providers[LOCAL_PROVIDER_ID]).toEqual({ model: "fixture-alpha", reasoning: "endpoint default" })
          await closePalette(setup)
        } finally { setup.renderer.destroy() }
      }
    })
  })
})

// ---------------------------------------------------------------------------
// SQ-11 adaptive frame height: the configured maximum bounds every surface
// ---------------------------------------------------------------------------

describe("SQ-11 adaptive frame height", () => {
  const LOCAL_ADAPTER = adapterPath(descriptorForProvider(LOCAL_PROVIDER_ID))
  const SPIKE_MODEL = "qwen3-coder-30b-a3b-instruct"

  type SseFixture = {
    endpoint: string
    posts: Array<Record<string, any>>
    close: () => Promise<void>
    onCompletion: ((response: ServerResponse) => void) | null
  }

  const startSseFixture = (): Promise<SseFixture> =>
    new Promise((resolve) => {
      const sockets = new Set<Socket>()
      const posts: Array<Record<string, any>> = []
      let fixture: SseFixture
      const server = createServer((req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ object: "list", data: [{ id: SPIKE_MODEL }] }))
          return
        }
        if (req.url === "/props") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ chat_template: "{% if enable_thinking %}" }))
          return
        }
        let body = ""
        req.on("data", (chunk) => {
          body += chunk
        })
        req.on("end", () => {
          try {
            posts.push(JSON.parse(body))
          } catch {}
          if (fixture.onCompletion) return fixture.onCompletion(res)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end("{}")
        })
      })
      server.on("connection", (socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
      })
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("no port")
        fixture = {
          endpoint: `http://127.0.0.1:${address.port}/v1`,
          posts,
          onCompletion: null,
          close: () =>
            new Promise<void>((done) => {
              server.close(() => done())
              for (const socket of sockets) socket.destroy()
            }),
        }
        resolve(fixture)
      })
    })

  const withSpikeEnvironment = async (
    body: (fixture: SseFixture, root: string) => Promise<void>,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "shellq-sq11-height-"))
    const bin = join(root, "bin")
    mkdirSync(bin)
    symlinkSync(process.execPath, join(bin, "bun"))
    for (const zsh of ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"]) {
      if (existsSync(zsh)) {
        symlinkSync(zsh, join(bin, "zsh"))
        break
      }
    }
    const fixture = await startSseFixture()
    const previous = {
      endpoint: process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT,
      path: process.env.PATH,
      stateDir: process.env.SHELLQ_STATE_DIR,
    }
    process.env.PATH = bin
    process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = fixture.endpoint
    process.env.SHELLQ_STATE_DIR = join(root, "state")
    try {
      await body(fixture, root)
    } finally {
      if (previous.endpoint === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT
      else process.env.SHELLQ_LOCAL_OPENAI_ENDPOINT = previous.endpoint
      if (previous.path === undefined) delete process.env.PATH
      else process.env.PATH = previous.path
      if (previous.stateDir === undefined) delete process.env.SHELLQ_STATE_DIR
      else process.env.SHELLQ_STATE_DIR = previous.stateDir
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const spikeSession = (overrides: Partial<WorkbenchSession> = {}) =>
    fixtureSession({
      initial_intent: "ask",
      provider: [LOCAL_ADAPTER],
      provider_id: LOCAL_PROVIDER_ID,
      provider_source: "default",
      model: SPIKE_MODEL,
      reasoning: "endpoint default",
      models: [SPIKE_MODEL],
      reasoning_levels: ["endpoint default"],
      ...overrides,
    })

  // Ask answers stream as an incrementally valid JSON envelope; raw prose
  // would sit unparsed in the adapter's buffer and never reach the reader.
  const streamAnswerChunk = (send: (payload: unknown) => void, fragment: string) =>
    send({ choices: [{ index: 0, delta: { content: fragment } }] })
  const answerLine = (index: number) => `line ${String(index).padStart(2, "0")}`
  const escapedLine = (index: number) => `\\n${answerLine(index)}`

  const openSettingsPalette = async (setup: Awaited<ReturnType<typeof mountWorkbench>>) => {
    setup.mockInput.pressKey("x", { ctrl: true })
    setup.mockInput.pressKey("s")
    return pumpUntilFrame(setup, (frame) => frame.includes("Search All:"))
  }

  // Under renderer pressure the reopened sheet can lose the focus handoff;
  // the first attempt stays immediate and a miss recovers by reopening the
  // sheet, which always starts a clean query.
  const typePickerQuery = async (setup: Awaited<ReturnType<typeof mountWorkbench>>, text: string) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) {
        setup.mockInput.pressEscape()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Search All:"))
        await new Promise((resolve) => setTimeout(resolve, 150))
        await openSettingsPalette(setup)
      }
      await setup.mockInput.typeText(text)
      await setup.renderOnce()
      if (setup.captureCharFrame().includes(`Search All: ${text}`)) return
    }
    throw new Error(`picker query did not accept: ${text}`)
  }

  const mountStreamingAsk = async (root: string) => {
    const setup = await mountWorkbench({ width: 100, height: 24, trustedWorkdir: root, session: spikeSession() })
    await setup.mockInput.typeText("list everything")
    setup.mockInput.pressEnter()
    return setup
  }

  test("default maximum stops growth at twelve and keeps the reader scrollable", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      const sse: { current: ServerResponse | null } = { current: null }
      const send = (payload: unknown) => sse.current!.write(`data: ${JSON.stringify(payload)}\n\n`)
      fixture.onCompletion = (response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        sse.current = response
      }
      const setup = await mountStreamingAsk(root)
      try {
        await pumpUntilFrame(setup, () => sse.current !== null, { tries: 160 })
        streamAnswerChunk(send, '{"answer":"' + escapedLine(0))
        await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(0)), { tries: 160 })
        expect(setup.renderer.footerHeight).toBeLessThanOrEqual(12)
        for (let first = 1; first < 30; first += 6) {
          streamAnswerChunk(send, [0, 1, 2, 3, 4, 5].map((offset) => escapedLine(first + offset)).join(""))
          await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(Math.min(first + 5, 29))), { tries: 160 })
          expect(setup.renderer.footerHeight).toBeLessThanOrEqual(12)
        }
        expect(setup.renderer.footerHeight).toBe(12)
        const streamBar = setup.renderer.root.findDescendantById("ask-stream-scrollbar") as ReaderScrollbar
        expect(streamBar).not.toBeNull()
        streamAnswerChunk(send, '"}')
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        ;sse.current!.end("data: [DONE]\n\n")
        await pumpUntilFrame(setup, (frame) => frame.includes("Ask a local question") && setup.active.process === null, { tries: 160 })
        expect(setup.renderer.footerHeight).toBe(12)
      } finally {
        try { sse.current?.end() } catch {}
        setup.renderer.destroy()
      }
    })
  }, 40_000)

  test("cap eight stops growth and bounds Doctor", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      seedStateRoot(join(root, "state"), { maxFooterRows: 8 })
      const sse: { current: ServerResponse | null } = { current: null }
      const send = (payload: unknown) => sse.current!.write(`data: ${JSON.stringify(payload)}\n\n`)
      fixture.onCompletion = (response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        sse.current = response
      }
      const setup = await mountStreamingAsk(root)
      try {
        await pumpUntilFrame(setup, () => sse.current !== null, { tries: 160 })
        streamAnswerChunk(send, '{"answer":"' + escapedLine(0))
        await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(0)), { tries: 160 })
        for (let first = 1; first < 24; first += 6) {
          streamAnswerChunk(send, [0, 1, 2, 3, 4, 5].map((offset) => escapedLine(first + offset)).join(""))
          await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(Math.min(first + 5, 23))), { tries: 160 })
          expect(setup.renderer.footerHeight).toBeLessThanOrEqual(8)
        }
        expect(setup.renderer.footerHeight).toBe(8)
        streamAnswerChunk(send, '"}')
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        ;sse.current!.end("data: [DONE]\n\n")
        await pumpUntilFrame(setup, (frame) => frame.includes("Ask a local question") && setup.active.process === null, { tries: 160 })
        // Overflow content stays reachable: page back to the first line.
        for (let page = 0; page < 6; page += 1) setup.mockInput.pressKey("\u001b[5~")
        await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(0)), { tries: 160 })
        setup.mockInput.pressKey("x", { ctrl: true })
        setup.mockInput.pressKey("d")
        const doctor = await pumpUntilFrame(setup, (frame) => frame.includes("PASS cwd") && setup.renderer.footerHeight === 8, { tries: 160 })
        expect(doctor).toContain("PASS provider")
        setup.mockInput.pressEscape()
        await pumpUntilFrame(setup, (frame) => frame.includes("Ask a local question"))
      } finally {
        try { sse.current?.end() } catch {}
        setup.renderer.destroy()
      }
    })
  }, 40_000)

  test("a mid-session save freezes the open band and applies after reopening", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      seedStateRoot(join(root, "state"), { maxFooterRows: 8 })
      const sse: { current: ServerResponse | null } = { current: null }
      const send = (payload: unknown) => sse.current!.write(`data: ${JSON.stringify(payload)}\n\n`)
      fixture.onCompletion = (response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        sse.current = response
      }
      const setup = await mountStreamingAsk(root)
      try {
        await pumpUntilFrame(setup, () => sse.current !== null, { tries: 160 })
        streamAnswerChunk(send, '{"answer":"' + escapedLine(0))
        await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(0)), { tries: 160 })
        for (let first = 1; first < 12; first += 6) {
          streamAnswerChunk(send, [0, 1, 2, 3, 4, 5].map((offset) => escapedLine(first + offset)).join(""))
          await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(Math.min(first + 5, 11))), { tries: 160 })
        }
        expect(setup.renderer.footerHeight).toBe(8)
        // A mid-session save must not move the open band even when content
        // arrives that would need the new maximum.
        workbenchBindings.writePersistedMaxFooterRows(16)
        for (let first = 12; first < 30; first += 6) {
          streamAnswerChunk(send, [0, 1, 2, 3, 4, 5].map((offset) => escapedLine(first + offset)).join(""))
          await pumpUntilFrame(setup, (frame) => frame.includes(answerLine(Math.min(first + 5, 29))), { tries: 160 })
          expect(setup.renderer.footerHeight).toBe(8)
        }
        setup.renderer.destroy()
        // The next invocation applies the saved maximum. Drop the dead
        // response first: the reopened turn must bind to its own stream.
        sse.current = null
        const reopened = await mountStreamingAsk(root)
        try {
          await pumpUntilFrame(reopened, () => sse.current !== null, { tries: 160 })
          streamAnswerChunk(send, '{"answer":"' + escapedLine(0))
          await pumpUntilFrame(reopened, (frame) => frame.includes(answerLine(0)), { tries: 160 })
          for (let first = 1; first < 30; first += 6) {
            streamAnswerChunk(send, [0, 1, 2, 3, 4, 5].map((offset) => escapedLine(first + offset)).join(""))
            await pumpUntilFrame(reopened, (frame) => frame.includes(answerLine(Math.min(first + 5, 29))), { tries: 160 })
          }
          expect(reopened.renderer.footerHeight).toBe(16)
        } finally {
          reopened.renderer.destroy()
        }
      } finally {
        try { sse.current?.end() } catch {}
        setup.renderer.destroy()
      }
    })
  }, 60_000)

  test("a failed picker save leaves file, marker, and frame unchanged", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      seedStateRoot(join(root, "state"), {})
      const settingsPath = join(root, "state", "settings.json")
      // An unreadable settings file puts the persisted state into the
      // operational-error branch, so the picker's write must fail.
      chmodSync(settingsPath, 0o000)
      const setup = await mountWorkbench({ width: 80, height: 24, trustedWorkdir: root, session: spikeSession() })
      try {
        await openSettingsPalette(setup)
        await typePickerQuery(setup, "max height")
        await pumpUntilFrame(setup, (frame) => frame.includes("Max height 8 rows"))
        // Select the 8 leaf (not the already-ranked 12): a failed save must
        // leave the marker where it was, which only shows when the failed
        // selection differed from it.
        setup.mockInput.pressKey("\u001b[B")
        // The palette itself promotes the band (grow-only); the failed save
        // must not change it further.
        const before = setup.renderer.footerHeight
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("max height not saved"), { tries: 160 })
        expect(setup.renderer.footerHeight).toBe(before)
        // The marker keeps the default ranking and the file is untouched.
        const frame = setup.captureCharFrame()
        expect(frame.indexOf("Max height 12 rows (default)")).toBeLessThan(frame.indexOf("Max height 8 rows"))
        chmodSync(settingsPath, 0o600)
        expect(readFileSync(settingsPath, "utf8")).not.toContain("maxFooterRows")
      } finally {
        chmodSync(settingsPath, 0o600)
        setup.renderer.destroy()
      }
    })
  }, 40_000)

  test("max height leaves save, rank the saved value first, and stay ASCII", async () => {
    await withSpikeEnvironment(async (fixture, root) => {
      const sse: { current: ServerResponse | null } = { current: null }
      const send = (payload: unknown) => sse.current!.write(`data: ${JSON.stringify(payload)}\n\n`)
      fixture.onCompletion = (response) => {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        sse.current = response
      }
      const setup = await mountStreamingAsk(root)
      try {
        await pumpUntilFrame(setup, () => sse.current !== null, { tries: 160 })
        streamAnswerChunk(send, '{"answer":"' + escapedLine(0) + '"}')
        send({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        ;sse.current!.end("data: [DONE]\n\n")
        await pumpUntilFrame(setup, (frame) => frame.includes("Ask a local question") && setup.active.process === null, { tries: 160 })
        const before = setup.renderer.footerHeight
        await openSettingsPalette(setup)
        await typePickerQuery(setup, "max height")
        const listed = await pumpUntilFrame(setup, (frame) =>
          frame.includes("Max height 8 rows") && frame.includes("Max height 12 rows (default)") && frame.includes("Max height 16 rows"))
        expect(listed.indexOf("Max height 12 rows (default)")).toBeLessThan(listed.indexOf("Max height 16 rows"))
        // Arrows move the query caret and Esc closes the sheet, so narrow to
        // the unique 8 leaf by appending to the query.
        await setup.mockInput.typeText(" 8")
        await setup.renderOnce()
        await pumpUntilFrame(setup, (frame) => frame.includes("Max height 8 rows") && !frame.includes("Max height 16 rows"))
        setup.mockInput.pressEnter()
        await pumpUntilFrame(setup, (frame) => frame.includes("max height 8 rows saved"))
        expect(setup.renderer.footerHeight).toBe(before)
        expect(JSON.parse(readFileSync(join(root, "state", "settings.json"), "utf8")).maxFooterRows).toBe(8)
        // Close the sheet before tearing down: the test renderer shares
        // module state across mounts, and an open sheet at destroy leaks
        // into the next mount.
        setup.mockInput.pressEscape()
        await pumpUntilFrame(setup, (frame) => !frame.includes("Search All:"))
        setup.renderer.destroy()
        // A fresh invocation reads the saved marker: its picker ranks the
        // saved value first.
        const reopened = await mountWorkbench({ width: 80, height: 24, trustedWorkdir: root, session: spikeSession() })
        try {
          await openSettingsPalette(reopened)
          await typePickerQuery(reopened, "max height")
          const ranked = await pumpUntilFrame(reopened, (frame) => frame.includes("Max height 8 rows"))
          expect(ranked.indexOf("Max height 8 rows")).toBeLessThan(ranked.indexOf("Max height 12 rows (default)"))
          reopened.mockInput.pressEscape()
          // No Unicode, same words.
          const previousUnicode = process.env.NO_UNICODE
          process.env.NO_UNICODE = "1"
          try {
            const ascii = await mountWorkbench({ width: 80, height: 24, trustedWorkdir: root, session: spikeSession() })
            try {
              await openSettingsPalette(ascii)
              await typePickerQuery(ascii, "max height")
              const asciiFrame = await pumpUntilFrame(ascii, (frame) => frame.includes("Max height 8 rows"))
              expect(asciiFrame).toContain("Max height 12 rows (default)")
            } finally { ascii.renderer.destroy() }
          } finally {
            if (previousUnicode === undefined) delete process.env.NO_UNICODE
            else process.env.NO_UNICODE = previousUnicode
          }
        } finally { reopened.renderer.destroy() }
      } finally {
        setup.renderer.destroy()
      }
    })
  }, 60_000)
})
