import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { claudeArgs, claudeSandboxAvailable, readClaudeStream } from "../src/claude-stream-provider"
import { StructuredPreviewProjector } from "../src/structured-preview"
import { parseAskResponse, readAskStream } from "../src/workbench"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const sessionId = "11111111-1111-4111-8111-111111111111"
const stream = (
  cwd: string,
  model = "claude-sonnet-5",
  result = "fast answer",
  id = sessionId,
) =>
  [
    { type: "system", subtype: "init", cwd, session_id: id, tools: ["Glob", "Grep", "Read"], mcp_servers: [], model, slash_commands: [], skills: [] },
    { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_start" } },
    { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fast " } } },
    { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } } },
    { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", session_id: id, parent_tool_use_id: null, event: { type: "message_stop" } },
    { type: "result", subtype: "success", is_error: false, session_id: id, result },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n"

// The Claude spike provider refuses to run without macOS sandbox-exec.
const macOnly = test.skipIf(process.platform !== "darwin")

describe("Claude streaming spike", () => {
  test("projects fragmented structured fields without exposing JSON framing", () => {
    const value = JSON.stringify({ candidates: [
      { tldr: 'Use printf for "safe" output.', corrected_command: "printf '%s' ok" },
      { tldr: "Use echo for a short message.", corrected_command: "echo ok" },
    ] })
    const projector = new StructuredPreviewProjector("generate", 3)
    const events = []
    for (let index = 0; index < value.length; index += 3) events.push(...projector.push(value.slice(index, index + 3)))
    expect(events.map(event => event.text).join("")).toContain('Choice 1\nExplanation: Use printf for "safe" output.')
    expect(events.map(event => event.text).join("")).toContain("Choice 2\nExplanation: Use echo for a short message.\nCommand: echo ok")
    expect(events.every(event => !/[{}\[\]]/u.test(event.text))).toBe(true)
  })

  test("labels a command-first choice and separates every later choice", () => {
    const projector = new StructuredPreviewProjector("generate", 3)
    const raw = JSON.stringify({ candidates: [
      { corrected_command: "echo first", tldr: "First approach." },
      { corrected_command: "echo second", tldr: "Second approach." },
    ] })
    const text = Array.from({ length: raw.length }, (_, index) => projector.push(raw[index]!)).flat().map(event => event.text).join("")
    expect(text).toContain("Choice 1\nCommand: echo first\nExplanation: First approach.")
    expect(text).toContain("\nChoice 2\nCommand: echo second\nExplanation: Second approach.")
  })

  test("withholds malformed or truncated structured values", () => {
    const projector = new StructuredPreviewProjector("correct")
    expect(projector.push('{"tldr":"valid')).toEqual([{ t: "answer", text: "Explanation: valid" }])
    expect(projector.push('\\uD83D')).toEqual([])
    expect(projector.push('\\uZZZZ"}')).toEqual([])
  })

  macOnly("requires the native macOS sandbox before provider execution", () => {
    expect(claudeSandboxAvailable()).toBe(true)
  })

  test("pins the isolation boundary in argv", () => {
    const args = claudeArgs("/tmp/project", "claude-sonnet-5", "low", "question")
    expect(args).toContain("--safe-mode")
    expect(args).not.toContain("--no-session-persistence")
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("manual")
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep")
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: ["/tmp/project"] },
      },
    })
  })

  test("streams only correlated text and keeps the result authoritative", async () => {
    const deltas: string[] = []
    const answer = await readClaudeStream(
      new Response(stream("/tmp/project")).body!,
      (text) => deltas.push(text),
      { cwd: "/tmp/project", model: "claude-sonnet-5" },
    )
    expect(deltas).toEqual(["fast ", "answer"])
    expect(answer).toBe("fast answer")

    await expect(readClaudeStream(
      new Response(stream("/tmp/foreign")).body!,
      () => {},
      { cwd: "/tmp/project", model: "claude-sonnet-5" },
    )).rejects.toThrow("provider failed (65)")
  })

  test("rejects failed, non-success, duplicate, and cross-session finals", async () => {
    const valid = stream("/tmp/project")
    const cases = [
      (lines: string[]) => { const value = JSON.parse(lines.at(-1)!) ; value.is_error = true; lines[lines.length - 1] = JSON.stringify(value) },
      (lines: string[]) => { const value = JSON.parse(lines.at(-1)!) ; value.subtype = "error"; lines[lines.length - 1] = JSON.stringify(value) },
      (lines: string[]) => { lines.push(lines.at(-1)!) },
    ]
    for (const mutate of cases) {
      const lines = valid.trimEnd().split("\n")
      mutate(lines)
      await expect(readClaudeStream(
        new Response(lines.join("\n") + "\n").body!,
        () => {},
        { cwd: "/tmp/project", model: "claude-sonnet-5" },
      )).rejects.toThrow("provider failed (67)")
    }
    await expect(readClaudeStream(
      new Response(valid).body!,
      () => {},
      { cwd: "/tmp/project", model: "claude-sonnet-5" },
      undefined,
      "ask",
      "22222222-2222-4222-8222-222222222222",
    )).rejects.toThrow("provider failed (65)")
  })

  test("accepts null Fix results but rejects null Generate results", async () => {
    const response = JSON.stringify({
      tldr: "no safe correction",
      corrected_command: null,
      confidence: 0.2,
      risk: "unknown",
    })
    for (const [mode, accepted] of [["correct", true], ["generate", false]] as const) {
      const result = stream("/tmp/project", "claude-sonnet-5", response)
      const promise = readClaudeStream(
        new Response(result).body!,
        () => {},
        { cwd: "/tmp/project", model: "claude-sonnet-5" },
        undefined,
        mode,
      )
      if (accepted) expect(await promise).toBe(response)
      else await expect(promise).rejects.toThrow("provider failed (67)")
    }
  })

  test("batch candidates accept Command and reject mixed-null Fix", async () => {
    const candidates = JSON.stringify({ candidates: [
      { tldr: "Use find for a recursive search; choose it when depth control matters.", corrected_command: "find . -type f", confidence: 0.8, risk: "low" },
      { tldr: "Use rg for a fast source search; choose it when matching file contents.", corrected_command: "rg --files", confidence: 0.7, risk: "low" },
    ] })
    expect(await readClaudeStream(
      new Response(stream("/tmp/project", "claude-sonnet-5", candidates)).body!,
      () => {},
      { cwd: "/tmp/project", model: "claude-sonnet-5" },
      undefined,
      "generate",
      undefined,
      5,
    )).toBe(candidates)

    const mixedNull = JSON.stringify({ candidates: [
      { tldr: "No safe correction.", corrected_command: null, confidence: 0.2, risk: "unknown" },
      { tldr: "Use a bounded correction.", corrected_command: "echo fixed", confidence: 0.8, risk: "low" },
    ] })
    await expect(readClaudeStream(
      new Response(stream("/tmp/project", "claude-sonnet-5", mixedNull)).body!,
      () => {},
      { cwd: "/tmp/project", model: "claude-sonnet-5" },
      undefined,
      "correct",
      undefined,
      5,
    )).rejects.toThrow("provider failed (67)")
  })

  macOnly("preserves ShellQ preview and final framing end to end", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-claude-spike-"))
    roots.push(root)
    const fake = join(root, "claude")
    const capture = join(root, "capture.json")
    writeFileSync(fake, `#!/usr/bin/env bun
const args = process.argv.slice(2)
const value = ${JSON.stringify(stream(root))}
await Bun.write(process.env.FAKE_CAPTURE, JSON.stringify({ args, stdin: await Bun.stdin.text() }))
process.stdout.write(value)
`, { mode: 0o700 })
    chmodSync(fake, 0o700)

    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src", "claude-stream-provider.ts")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        FAKE_CAPTURE: capture,
        SHELLQ_CLAUDE_MODEL: "claude-sonnet-5",
        SHELLQ_CLAUDE_REASONING: "max",
        SHELLQ_CLAUDE_WORKDIR: root,
        SHELLQ_STREAM_PREVIEW: "1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(JSON.stringify({ mode: "ask", input: { query: "Question?", captured_output: "" } }))
    child.stdin.end()
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    expect(exitCode).toBe(0)
    const previews: unknown[] = []
    expect(parseAskResponse(await readAskStream(
      new Response(stdout).body!,
      (event) => previews.push(event),
    ))).toEqual({ answer: "fast answer" })
    expect(previews).toEqual([
      { t: "delta", text: "fast " },
      { t: "delta", text: "answer" },
    ])
    const captured = JSON.parse(readFileSync(capture, "utf8")) as { args: string[]; stdin: string }
    expect(captured.stdin).toBe("")
    expect(captured.args.slice(captured.args.indexOf("--effort"), captured.args.indexOf("--effort") + 2))
      .toEqual(["--effort", "max"])
  })

  macOnly("emits the command schema directly from Generate and Fix", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-claude-structured-"))
    roots.push(root)
    const fake = join(root, "claude")
    const capture = join(root, "capture.json")
    const response = JSON.stringify({
      tldr: "use echo",
      corrected_command: "echo fixed",
      confidence: 0.9,
      risk: "low",
    })
    const fakeScript = `#!/usr/bin/env bun
const value = ${JSON.stringify(stream(realpathSync(tmpdir()), "claude-sonnet-5", response))}
await Bun.write(process.env.FAKE_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), stdin: await Bun.stdin.text() }))
process.stdout.write(value)
`
    writeFileSync(fake, fakeScript, { mode: 0o700 })
    chmodSync(fake, 0o700)
    for (const mode of ["generate", "correct"] as const) {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src", "claude-stream-provider.ts")], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ""}`,
          FAKE_CAPTURE: capture,
          SHELLQ_CLAUDE_MODEL: "claude-sonnet-5",
          SHELLQ_CLAUDE_REASONING: "low",
          SHELLQ_CLAUDE_WORKDIR: "/definitely/not-the-command-cwd",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      child.stdin.write(JSON.stringify({
        mode,
        instructions: "Return JSON.",
        input: { command: "echo input", captured_output: "" },
        response_schema: { type: "object" },
      }))
      child.stdin.end()
      expect(await child.exited).toBe(0)
      expect(JSON.parse(await new Response(child.stdout).text())).toEqual(JSON.parse(response))
      expect(realpathSync(JSON.parse(readFileSync(capture, "utf8")).cwd)).toBe(realpathSync(tmpdir()))
      expect(JSON.parse(readFileSync(capture, "utf8")).args).not.toContain("--resume")
    }
  })

  macOnly("uses the submit-time Claude resume ID without rereading the pointer", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-claude-resume-"))
    roots.push(root)
    const fake = join(root, "claude")
    const pointer = join(root, "session.json")
    const capture = join(root, "capture.json")
    const explicitId = "22222222-2222-4222-8222-222222222222"
    writeFileSync(pointer, JSON.stringify({
      provider: "claude",
      cwd: root,
      session_id: "33333333-3333-4333-8333-333333333333",
    }), { mode: 0o600 })
    const fakeScript = `#!/usr/bin/env bun
await Bun.write(process.env.FAKE_CAPTURE, JSON.stringify({ args: process.argv.slice(2) }))
process.stdout.write(${JSON.stringify(stream(root, "claude-sonnet-5", "resumed", explicitId))})
`
    writeFileSync(fake, fakeScript, { mode: 0o700 })
    chmodSync(fake, 0o700)
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src", "claude-stream-provider.ts")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        FAKE_CAPTURE: capture,
        SHELLQ_CLAUDE_MODEL: "claude-sonnet-5",
        SHELLQ_CLAUDE_REASONING: "low",
        SHELLQ_CLAUDE_WORKDIR: root,
        SHELLQ_CLAUDE_SESSION_FILE: pointer,
        SHELLQ_CLAUDE_SESSION_ID: explicitId,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(JSON.stringify({ mode: "ask", input: { query: "resume", captured_output: "" } }))
    child.stdin.end()
    expect(await child.exited).toBe(0)
    const args = JSON.parse(readFileSync(capture, "utf8")).args as string[]
    expect(args[args.indexOf("--resume") + 1]).toBe(explicitId)
    expect(JSON.parse(readFileSync(pointer, "utf8")).session_id).toBe(
      "33333333-3333-4333-8333-333333333333",
    )
  })

  macOnly("terminates the Claude child when ShellQ cancels", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-claude-cancel-"))
    roots.push(root)
    const fake = join(root, "claude")
    const pidFile = join(root, "pid")
    writeFileSync(fake, `#!/usr/bin/env bun
await Bun.write(process.env.FAKE_PID, String(process.pid))
await new Promise(() => {})
`, { mode: 0o700 })
    chmodSync(fake, 0o700)
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src", "claude-stream-provider.ts")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ""}`,
        FAKE_PID: pidFile,
        SHELLQ_CLAUDE_MODEL: "claude-sonnet-5",
        SHELLQ_CLAUDE_REASONING: "low",
        SHELLQ_CLAUDE_TIMEOUT_MS: "5000",
        SHELLQ_CLAUDE_WORKDIR: root,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(JSON.stringify({ mode: "ask", input: { query: "Wait", captured_output: "" } }))
    child.stdin.end()
    for (let index = 0; index < 100 && !existsSync(pidFile); index += 1) {
      await Bun.sleep(10)
    }
    expect(existsSync(pidFile)).toBe(true)
    child.kill("SIGTERM")
    expect(await child.exited).toBe(143)
    const pid = Number(readFileSync(pidFile, "utf8"))
    await Bun.sleep(50)
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

test("structured previews preserve JSON-like command text across the trusted reader", async () => {
  const {readAskStream}=await import("../src/workbench")
  const projector=new StructuredPreviewProjector("generate")
  const value={tldr:'Print a JSON object with "key": "value".',corrected_command:'printf \'{"key":"value"}\''}
  const events=projector.push(JSON.stringify(value))
  let displayed=""
  await readAskStream(new Response(events.map(e=>JSON.stringify(e)+"\n").join("")+JSON.stringify(value)).body!,e=>{displayed+=e.text},true)
  expect(displayed).toContain(value.tldr)
  expect(displayed).toContain(value.corrected_command)
})
