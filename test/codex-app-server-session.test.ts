import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  AppServerSession,
  validateAppServerSessionTurn,
} from "../src/codex-app-server-session"

const THREAD_ID = "019fd36e-a83f-7ad3-ba25-243ea233e1f3"
const TURN_IDS = [
  "019fd3fe-b1b0-71b0-9fba-38734709fed6",
  "019fd3fe-b1b0-71b0-9fba-38734709fed7",
  "019fd3fe-b1b0-71b0-9fba-38734709fed8",
  "019fd3fe-b1b0-71b0-9fba-38734709fed9",
]
const EPHEMERAL_IDS = [
  "019fd36e-a83f-7ad3-ba25-243ea233e1f4",
  "019fd36e-a83f-7ad3-ba25-243ea233e1f5",
]
const originalCodexHome = process.env.CODEX_HOME
const originalState = process.env.SHELLQ_STATE_DIR
const originalPath = process.env.PATH
let root = ""

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalCodexHome
  if (originalState === undefined) delete process.env.SHELLQ_STATE_DIR; else process.env.SHELLQ_STATE_DIR = originalState
  process.env.PATH = originalPath
  delete process.env.FAKE_LOG
  delete process.env.FAKE_MODE
  if (root) rmSync(root, { recursive: true, force: true })
  root = ""
})

const FAKE = `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const threadId = ${JSON.stringify(THREAD_ID)};
const turnIds = ${JSON.stringify(TURN_IDS)};
const ephemeralIds = ${JSON.stringify(EPHEMERAL_IDS)};
const mode = process.env.FAKE_MODE || "success";
const log = (value) => {
  appendFileSync(process.env.FAKE_LOG, value + "\\n");
};
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turn = 0;
let cwd = "";
let ephemeral = 0;
let lateEphemeralId = "";
let configReads = 0;
const threadCwds = new Map();
if (mode === "stderr-flood") process.stderr.write("x".repeat(256 * 1024));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line);
  if (message.method === "config/read") {
    configReads++;
    send({ method: "warning", params: { message: "routine preparation warning" } });
    send({ id: message.id, result: { config: (mode === "auth-policy" || (mode === "auth-policy-late" && configReads > 1)) ? { cli_auth_credentials_store: "keyring" } : mode === "enabled-mcp" ? { mcp_servers: { fixture: {} } } : {}, layers: [{ name: { type: "user", file: process.env.CODEX_HOME + "/config.toml", profile: null }, disabledReason: null }, ...(mode === "active-project" ? [{ name: { type: "project", dotCodexFolder: "/fixture/.codex" }, disabledReason: null }] : [])] } });
    continue;
  }
  if (message.method === "skills/list") {
    send({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], skills: [{ path: "/fixture/SKILL.md" }], errors: [] }] } });
    continue;
  }
  if (message.method === "initialize") {
    log("initialize");
    if (mode === "initialize-hold") continue;
    send({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } });
    if (mode === "account-update-malformed") {
      send({ method: "account/updated", params: { planType: "not-a-plan" } });
    }
    if (mode === "initialize-foreign") {
      send({ method: "thread/status/changed", params: { threadId: "119fd36e-a83f-7ad3-ba25-243ea233e1f3", status: { type: "idle" } } });
    }
    send({ id: message.id, result: {} });
    continue;
  }
  if (message.method === "initialized") continue;
  if (message.method === "model/list") {
    log("model/list:" + (message.params.cursor || "first"));
    send({ id: message.id, result: {
      data: message.params.cursor
        ? [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "Luna", description: "Luna", supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", isDefault: false }]
        : [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "Sol", description: "Sol", supportedReasoningEfforts: ["high", "ultra"], defaultReasoningEffort: "high", isDefault: true }],
      nextCursor: message.params.cursor ? null : "page-2",
    }});
    continue;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    const checkedPolicy = message.params.config;
    const featureNames = ["plugins", "apps", "hooks", "memories", "multi_agent", "browser_use", "computer_use", "image_generation", "skill_search"];
    if (!message.params.baseInstructions || checkedPolicy.tools.view_image !== false || checkedPolicy.tools.web_search !== false || featureNames.some((name) => checkedPolicy.features[name] !== false) || checkedPolicy.features.shell_tool !== !message.params.ephemeral || checkedPolicy.features.unified_exec !== !message.params.ephemeral || JSON.stringify(checkedPolicy.skills.config) !== JSON.stringify([{ path: "/fixture/SKILL.md", enabled: false }])) process.exit(91);

    let startedId = message.params.ephemeral ? ephemeralIds[ephemeral++] : threadId;
    if (mode === "collision-ask" && message.params.ephemeral) startedId = threadId;
    if (mode === "collision-recent" && message.params.ephemeral && ephemeral > 1) startedId = ephemeralIds[0];
    log(message.method + ":" + (message.params.ephemeral ? "ephemeral" : "persistent"));
    cwd = message.params.cwd;
    if (mode === "startup-foreign") {
      send({ method: "thread/started", params: { thread: { id: "119fd36e-a83f-7ad3-ba25-243ea233e1f3" } } });
    }
    if (mode === "resume-error" && message.method === "thread/resume") {
      send({ id: message.id, error: { code: -32000, message: "missing" } });
      continue;
    }
    if (mode === "late-ephemeral-mcp" && message.params.ephemeral && lateEphemeralId) {
      send({ method: "mcpServer/startupStatus/updated", params: {
        threadId: lateEphemeralId, name: "fixture", status: "ready", error: null, failureReason: null,
      }});
    }
    const response = { id: message.id, result: {
      thread: { id: startedId, cwd: message.params.cwd, ephemeral: Boolean(message.params.ephemeral) },
      cwd: message.params.cwd,
      approvalPolicy: "never",
      sandbox: { type: "readOnly", networkAccess: false },
      model: message.params.model,
      reasoningEffort: message.params.config.model_reasoning_effort,
      instructionSources: mode === "missing-instructions" ? undefined : mode === "inherited-instructions" ? [{ path: "/fixture/AGENTS.md" }] : [],
    }};
    const bufferedEphemeralForeign = mode === "buffered-ephemeral-foreign" && message.params.ephemeral;
    if (mode === "buffered-startup" || mode === "buffered-foreign" || bufferedEphemeralForeign) {
      const startupId = mode === "buffered-foreign"
        ? "119fd36e-a83f-7ad3-ba25-243ea233e1f3"
        : startedId;
      const mcpId = bufferedEphemeralForeign
        ? "119fd36e-a83f-7ad3-ba25-243ea233e1f3"
        : startupId;
      process.stdout.write([
        response,
        { method: "thread/started", params: { thread: { id: startupId } } },
        ...(mode === "buffered-startup" ? [] : [{ method: "mcpServer/startupStatus/updated", params: {
          threadId: mcpId, name: "fixture", status: "starting", error: null, failureReason: null,
        }}]),
      ].map((value) => JSON.stringify(value)).join("\\n") + "\\n");
    } else {
      send(response);
    }
    threadCwds.set(startedId, message.params.cwd);
    continue;
  }
  if (message.method === "turn/start") {
    const activeThreadId = message.params.threadId;
    const turnId = turnIds[turn];
    const answer = "answer-" + (turn + 1);
    turn += 1;
    log("turn/start:" + activeThreadId + ":" + message.params.cwd);
    if (mode === "early-flood") {
      for (let index = 0; index < 129; index += 1) {
        send({ method: "turn/started", params: { threadId: activeThreadId, turn: { id: turnId } } });
      }
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (mode === "turn-hold") continue;
    const base = { threadId: activeThreadId, turnId };
    send({ method: "account/updated", params: { authMode: null, planType: null } });
    if (mode === "background-ask-mcp" && activeThreadId !== threadId) {
      send({ method: "mcpServer/startupStatus/updated", params: {
        threadId, name: "fixture", status: "ready", error: null, failureReason: null,
      }});
    }
    if (mode === "command-execution" && activeThreadId !== threadId) {
      send({ method: "item/started", params: { ...base, item: { id: "command", type: "commandExecution" } } });
      continue;
    }
    if (mode === "post-start-flood") {
      for (let index = 0; index < 129; index += 1) {
        send({ method: "item/started", params: { ...base, item: { id: "reasoning-" + index, type: "reasoning" } } });
      }
      continue;
    }
    if (mode === "phase-unknown-commentary") {
      send({ method: "item/started", params: { ...base, item: { id: "hidden", type: "agentMessage" } } });
      send({ method: "item/agentMessage/delta", params: { ...base, itemId: "hidden", delta: "secret commentary" } });
      send({ method: "item/completed", params: { ...base, item: { id: "hidden", type: "agentMessage", phase: "commentary", text: "secret commentary" } } });
    }
    send({ method: "item/started", params: { ...base, item: { id: "agent-" + turn, type: "agentMessage", phase: "final_answer" } } });
    if (mode === "fragmented") {
      send({ method: "item/agentMessage/delta", params: { ...base, itemId: "agent-" + turn, delta: "answer" } });
      await Bun.sleep(80);
      send({ method: "item/agentMessage/delta", params: { ...base, itemId: "agent-" + turn, delta: "-" + turn } });
      await Bun.sleep(80);
    } else {
      send({ method: "item/agentMessage/delta", params: { ...base, itemId: "agent-" + turn, delta: answer } });
    }
    send({ method: "item/completed", params: { ...base, item: { id: "agent-" + turn, type: "agentMessage", phase: "final_answer", text: answer } } });
    send({ method: "turn/completed", params: { threadId: activeThreadId, turn: { id: turnId, status: "completed" } } });
    continue;
  }
  if (message.method === "thread/read") {
    log("thread/read");
    const readThreadId = message.params.threadId;
    if (mode === "late-ephemeral-mcp" && readThreadId !== threadId) lateEphemeralId = readThreadId;
    if (mode === "post-terminal-unknown") {
      send({ method: "turn/mystery", params: { threadId, turnId: turnIds[turn - 1] } });
    }
    send({ id: message.id, result: { thread: {
      id: mode === "seal-foreign" ? "119fd36e-a83f-7ad3-ba25-243ea233e1f3" : readThreadId,
      cwd: mode === "seal-cwd" ? threadCwds.get(readThreadId) + "/other" : threadCwds.get(readThreadId),
      status: { type: mode === "seal-active" ? "active" : "idle" },
    }}});
    if (mode === "seal-eof") process.stdout.end(() => process.exit(0));
    continue;
  }
  if (message.method === "turn/interrupt") {
    log("turn/interrupt:" + message.params.threadId + ":" + message.params.turnId);
  }
}
`

function setup(mode = "success") {
  root = mkdtempSync(join(tmpdir(), "shellq-app-session-"))
  const bin = join(root, "codex")
  const log = join(root, "events.log")
  mkdirSync(join(root, "native"))
  writeFileSync(join(root, "native", "auth.json"), "{}", { mode: 0o600 })
  process.env.CODEX_HOME = join(root, "native")
  process.env.SHELLQ_STATE_DIR = join(root, "isolated")
  writeFileSync(bin, FAKE.replaceAll("process.env.FAKE_MODE", JSON.stringify(mode)).replaceAll("process.env.FAKE_LOG", JSON.stringify(log)))
  chmodSync(bin, 0o700)
  writeFileSync(log, "")
  process.env.PATH = root
  process.env.FAKE_LOG = log
  process.env.FAKE_MODE = mode
  const sessionFile = join(root, "state", "chat.json")
  return { log, sessionFile, candidate: `${sessionFile}.pending-test` }
}

function prebufferedLineStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const source = stream.getReader()
  return new ReadableStream({
    async start(controller) {
      let pending = new Uint8Array()
      try {
        while (true) {
          const result = await source.read()
          if (result.done) {
            if (pending.byteLength) controller.enqueue(pending)
            controller.close()
            return
          }
          const joined = new Uint8Array(pending.byteLength + result.value.byteLength)
          joined.set(pending)
          joined.set(result.value, pending.byteLength)
          pending = joined
          while (true) {
            const newline = pending.indexOf(10)
            if (newline < 0) break
            controller.enqueue(pending.slice(0, newline + 1))
            pending = pending.slice(newline + 1)
          }
        }
      } catch (error) {
        controller.error(error)
      } finally {
        source.releaseLock()
      }
    },
  })
}

async function withPrebufferedStdout<T>(operation: () => Promise<T>): Promise<T> {
  const originalSpawn = Bun.spawn
  Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = originalSpawn(...args)
    } finally {
      Bun.spawn = originalSpawn
    }
    const command = args[0]
    if (!Array.isArray(command) || command[0] !== "codex") return child
    if (!(child.stdout instanceof ReadableStream)) return child
    Object.defineProperty(child, "stdout", {
      value: prebufferedLineStream(child.stdout),
    })
    return child
  }) as typeof Bun.spawn
  try {
    return await operation()
  } finally {
    Bun.spawn = originalSpawn
  }
}

const request = (query: string) => ({
  mode: "ask",
  input: { query, captured_output: "" },
})

const structuredRequest = (mode: "generate" | "correct") => ({
  mode,
  instructions: "Return JSON.",
  input: { command: "echo ok", captured_output: "" },
  response_schema: { type: "object" },
})

describe("persistent App Server session", () => {
  test("rejects malformed account updates during initialization", async () => {
    const { sessionFile } = setup("account-update-malformed")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    try {
      await expect(session.ready(new AbortController().signal)).rejects.toMatchObject({ code: 66 })
    } finally {
      await session.dispose()
    }
  })

  test("accepts startup notifications in pre-buffered chunks after the thread response", async () => {
    const { sessionFile, candidate } = setup("buffered-startup")
    await withPrebufferedStdout(async () => {
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      const signal = new AbortController().signal
      try {
        await session.ready(signal)
        await expect(
          session.runTurn(request("buffered startup"), {
            candidateFile: candidate,
            onPreview: () => {},
            signal,
          }),
        ).resolves.toEqual({ answer: "answer-1" })
      } finally {
        await session.dispose()
      }
    })
  })

  test("rejects foreign startup identity in pre-buffered chunks", async () => {
    const { sessionFile } = setup("buffered-foreign")
    await withPrebufferedStdout(async () => {
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      try {
        await expect(session.ready(new AbortController().signal)).rejects.toMatchObject({ code: 66 })
      } finally {
        await session.dispose()
      }
    })
  })

  test("rejects a foreign ephemeral startup before sending its turn", async () => {
    const { log, sessionFile } = setup("buffered-ephemeral-foreign")
    await withPrebufferedStdout(async () => {
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      const signal = new AbortController().signal
      try {
        await session.ready(signal)
        await expect(
          session.runTurn(structuredRequest("generate"), {
            mode: "generate",
            onPreview: () => {},
            signal,
          }),
        ).rejects.toMatchObject({ code: 66 })
      } finally {
        await session.dispose()
      }
    })
    expect(readFileSync(log, "utf8")).not.toContain("turn/start:")
  })

  test("seals two turns over one initialized process", async () => {
    const { log, sessionFile, candidate } = setup()
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    const signal = new AbortController().signal
    await session.ready(signal)
    expect(session.matches({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: undefined,
      sessionFile,
    })).toBe(false)
    expect(session.matches({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: THREAD_ID,
      sessionFile,
    })).toBe(true)
    expect(session.matches({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "medium",
      threadId: THREAD_ID,
      sessionFile,
    })).toBe(false)
    const previews: string[] = []
    expect(
      await session.runTurn(request("one"), {
        candidateFile: candidate,
        onPreview: (event) => previews.push(event.text),
        signal,
      }),
    ).toEqual({ answer: "answer-1" })
    expect(existsSync(candidate)).toBe(true)
    session.discardStagedPointer(`${candidate}-other`)
    expect(session.matches({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })).toBe(false)
    expect(
      await session.runTurn(request("two"), {
        onPreview: (event) => previews.push(event.text),
        signal,
      }),
    ).toEqual({ answer: "answer-2" })
    await session.dispose()
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "initialize",
      "thread/start:persistent",
      `turn/start:${THREAD_ID}:${root}`,
      "thread/read",
      `turn/start:${THREAD_ID}:${root}`,
      "thread/read",
    ])
    expect(previews).toEqual(["answer-1", "answer-2"])
  })

  test("keeps Ask persistent while Command and Fix use sealed ephemeral threads", async () => {
    const { log, sessionFile, candidate } = setup("success")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    const signal = new AbortController().signal
    const pid = session.pid
    await session.ready(signal)
    await session.runTurn(request("one"), {
      candidateFile: candidate,
      onPreview: () => {},
      signal,
    })
    await session.runTurn(structuredRequest("generate"), {
      mode: "generate",
      onPreview: () => {},
      signal,
    })
    await session.runTurn(structuredRequest("correct"), {
      mode: "correct",
      onPreview: () => {},
      signal,
    })
    await session.runTurn(request("follow-up"), {
      onPreview: () => {},
      signal,
    })
    expect(session.pid).toBe(pid)
    expect(session.threadId).toBe(THREAD_ID)
    const events = readFileSync(log, "utf8").trim().split("\n")
    expect(events.filter((event) => event === "initialize")).toHaveLength(1)
    expect(events.filter((event) => event === "thread/start:persistent")).toHaveLength(1)
    expect(events.filter((event) => event === "thread/start:ephemeral")).toHaveLength(2)
    expect(events.filter((event) => event === "thread/read")).toHaveLength(4)
    expect(events.filter((event) => event.endsWith(`:${join(root, "isolated", "codex-home", "empty")}`))).toHaveLength(2)
    await session.dispose()
  })

  test("retires the process if Command or Fix starts a tool item", async () => {
    const { sessionFile } = setup("command-execution")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    await session.ready(new AbortController().signal)
    await expect(
      session.runTurn(structuredRequest("generate"), {
        mode: "generate",
        onPreview: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 66 })
    await session.dispose()
  })

  test("refuses late MCP startup before the next ephemeral turn", async () => {
    const { sessionFile } = setup("late-ephemeral-mcp")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    const signal = new AbortController().signal
    await session.ready(signal)
    await session.runTurn(structuredRequest("generate"), {
      mode: "generate",
      onPreview: () => {},
      signal,
    })
    await expect(
      session.runTurn(structuredRequest("correct"), {
        mode: "correct",
        onPreview: () => {},
        signal,
      }),
    ).rejects.toMatchObject({ code: 66 })
    await session.dispose()
  })

  test("rejects ephemeral thread identity collisions", async () => {
    for (const mode of ["collision-ask", "collision-recent"]) {
      const { sessionFile } = setup(mode)
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      const signal = new AbortController().signal
      await session.ready(signal)
      if (mode === "collision-recent") {
        await session.runTurn(structuredRequest("generate"), {
          mode: "generate",
          onPreview: () => {},
          signal,
        })
      }
      await expect(
        session.runTurn(structuredRequest("correct"), {
          mode: "correct",
          onPreview: () => {},
          signal,
        }),
      ).rejects.toMatchObject({ code: 66 })
      await session.dispose()
      rmSync(root, { recursive: true, force: true })
      root = ""
    }
  })

  test("matches an initialization-only session only before an Ask thread exists", async () => {
    const { log, sessionFile } = setup()
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: undefined,
      sessionFile,
    })
    await session.ready(new AbortController().signal)
    expect(session.matches({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: undefined,
      sessionFile,
    })).toBe(true)
    expect(readFileSync(log, "utf8").trim()).toBe("initialize")
    await session.dispose()
  })

  test("lists bounded model pages without starting a thread or turn", async () => {
    const { log, sessionFile } = setup("model-list")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: undefined,
      sessionFile,
    })
    await session.ready(new AbortController().signal)
    const models = await session.listModels(new AbortController().signal)
    expect(models).toHaveLength(2)
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "initialize",
      "model/list:first",
      "model/list:page-2",
    ])
    await session.dispose()
  })

  test("keeps Command and Fix available when the saved Ask thread cannot resume", async () => {
    const { sessionFile } = setup("resume-error")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: THREAD_ID,
      sessionFile,
    })
    const signal = new AbortController().signal
    await expect(session.ready(signal)).resolves.toBeUndefined()
    expect(session.matches({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: THREAD_ID,
      sessionFile,
    })).toBe(true)
    await expect(
      session.runTurn(structuredRequest("generate"), {
        mode: "generate",
        onPreview: () => {},
        signal,
      }),
    ).resolves.toEqual({ answer: "answer-1" })
    await expect(
      session.runTurn(request("resume"), {
        onPreview: () => {},
        signal,
      }),
    ).rejects.toMatchObject({ code: 69 })
    await session.dispose()
  })

  test("rejects post-terminal activity before the seal response", async () => {
    const { sessionFile, candidate } = setup("post-terminal-unknown")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    const signal = new AbortController().signal
    await session.ready(signal)
    await expect(
      session.runTurn(request("unsafe"), {
        candidateFile: candidate,
        onPreview: () => {},
        signal,
      }),
    ).rejects.toMatchObject({ code: 66 })
    expect(existsSync(candidate)).toBe(false)
    await session.dispose()
  })

  test("streams only explicit final-answer deltas and resets its coalescing timer", async () => {
    for (const mode of ["phase-unknown-commentary", "fragmented"]) {
      const { sessionFile, candidate } = setup(mode)
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      const previews: string[] = []
      await session.ready(new AbortController().signal)
      await session.runTurn(request(mode), {
        candidateFile: candidate,
        onPreview: (event) => {
          if (event.t === "answer") previews.push(event.text)
        },
        signal: new AbortController().signal,
      })
      expect(previews.join("")).toBe("answer-1")
      expect(previews.join("")).not.toContain("secret")
      if (mode === "fragmented") expect(previews).toEqual(["answer", "-1"])
      await session.dispose()
      rmSync(root, { recursive: true, force: true })
      root = ""
    }
  })

  test("rejects seal EOF, startup identity drift, and an early-message flood", async () => {
    for (const mode of [
      "seal-eof",
      "seal-foreign",
      "seal-cwd",
      "seal-active",
      "startup-foreign",
      "initialize-foreign",
      "early-flood",
      "post-start-flood",
    ]) {
      const { sessionFile, candidate } = setup(mode)
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      const signal = new AbortController().signal
      if (mode === "startup-foreign" || mode === "initialize-foreign") {
        await expect(session.ready(signal)).rejects.toMatchObject({ code: 66 })
      } else {
        await session.ready(signal)
        await expect(
          session.runTurn(request(mode), {
            candidateFile: candidate,
            onPreview: () => {},
            signal,
          }),
        ).rejects.toMatchObject({ code: 66 })
      }
      expect(existsSync(candidate)).toBe(false)
      await session.dispose()
      rmSync(root, { recursive: true, force: true })
      root = ""
    }
  })

  test("drains noisy stderr without delaying a valid turn", async () => {
    const { sessionFile, candidate } = setup("stderr-flood")
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    const signal = new AbortController().signal
    await session.ready(signal)
    await expect(
      session.runTurn(request("noisy"), {
        candidateFile: candidate,
        onPreview: () => {},
        signal,
      }),
    ).resolves.toEqual({ answer: "answer-1" })
    await session.dispose()
  })

  test("rejects invalid spawn and candidate settings", async () => {
    const { log, sessionFile } = setup()
    expect(() => new AppServerSession({
      workdir: "relative",
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })).toThrow()
    expect(() => validateAppServerSessionTurn(
      {
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      },
      request("bad candidate"),
      join(root, "other.pending-test"),
    )).toThrow()
    expect(readFileSync(log, "utf8")).toBe("")
    expect(() => new AppServerSession({
      workdir: root,
      model: "bad model",
      effort: "low",
      threadId: null,
      sessionFile,
    })).toThrow()
    const session = new AppServerSession({
      workdir: root,
      model: "gpt-5.6-luna",
      effort: "low",
      threadId: null,
      sessionFile,
    })
    const signal = new AbortController().signal
    await session.ready(signal)
    await expect(
      session.runTurn(request("bad candidate"), {
        candidateFile: join(root, "other.pending-test"),
        onPreview: () => {},
        signal,
      }),
    ).rejects.toMatchObject({ code: 64 })
    await session.dispose()
  })

  test("abort reaps sessions during startup and an active turn", async () => {
    for (const mode of ["initialize-hold", "turn-hold"]) {
      const { log, sessionFile, candidate } = setup(mode)
      const session = new AppServerSession({
        workdir: root,
        model: "gpt-5.6-luna",
        effort: "low",
        threadId: null,
        sessionFile,
      })
      const controller = new AbortController()
      if (mode === "turn-hold") await session.ready(controller.signal)
      const operation = mode === "initialize-hold"
        ? session.ready(controller.signal)
        : session.runTurn(request("cancel"), {
            candidateFile: candidate,
            onPreview: () => {},
            signal: controller.signal,
          })
      setTimeout(() => controller.abort(), 30)
      await expect(operation).rejects.toMatchObject({ code: 130 })
      await session.dispose()
      expect(existsSync(candidate)).toBe(false)
      if (mode === "turn-hold") {
        expect(readFileSync(log, "utf8")).toContain(
          `turn/interrupt:${THREAD_ID}:${TURN_IDS[0]}`,
        )
      }
      rmSync(root, { recursive: true, force: true })
      root = ""
    }
  })
})

test("rejects inherited configuration and instruction sources before inference", async () => {
  for (const mode of ["enabled-mcp", "active-project", "missing-instructions", "inherited-instructions"]) {
    const { log, sessionFile } = setup(mode)
    const session = new AppServerSession({ workdir: root, model: "gpt-5.6-luna", effort: "low", threadId: null, sessionFile })
    try {
      await expect(session.ready(new AbortController().signal)).rejects.toMatchObject({ code: 66 })
      expect(readFileSync(log, "utf8")).not.toContain("turn/start")
    } finally { await session.dispose(); rmSync(root, { recursive: true, force: true }) }
  }
})


test("preserves unsupported effective authentication diagnosis before any thread or turn", async () => {
  for (const mode of ["auth-policy", "auth-policy-late"]) {
    const { log, sessionFile } = setup(mode)
    const session = new AppServerSession({ workdir: root, model: "gpt-5.6-luna", effort: "low", sessionFile })
    const signal = new AbortController().signal
    try {
      if (mode === "auth-policy-late") await session.ready(signal)
      const operation = mode === "auth-policy"
        ? session.ready(signal)
        : session.runTurn(structuredRequest("generate"), { mode: "generate", onPreview: () => {}, signal })
      await expect(operation).rejects.toMatchObject({ code: 70 })
      expect(readFileSync(log, "utf8")).not.toContain("thread/start")
      expect(readFileSync(log, "utf8")).not.toContain("turn/start")
    } finally {
      await session.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }
})
