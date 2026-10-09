import { afterEach, describe, expect, test } from "bun:test"
import { type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { join } from "node:path"

import { AdapterFailure, peerIsTrusted, validateEndpoint } from "../src/local-openai-provider"
import { startRawTcpFixture } from "./raw-tcp-fixture"
import {
  readAskStream,
  buildAskRequest,
  buildProviderRequest,
  type WorkbenchSession,
} from "../src/workbench"

const ADAPTER = join(import.meta.dir, "../src", "local-openai-provider.ts")

// ---------------------------------------------------------------------------
// Fixture server helper
// ---------------------------------------------------------------------------

type Fixture = {
  port: number
  endpoint: string
  hits: { path: string; method: string }[]
  close: () => Promise<void>
}

const openFixtures: Fixture[] = []

function startFixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fixture> {
  const hits: { path: string; method: string }[] = []
  return startRawTcpFixture((req, res) => {
    hits.push({ path: req.url ?? "", method: req.method ?? "" })
    handler(req, res)
  }).then((raw) => {
    const fixture: Fixture = {
      port: raw.port,
      endpoint: `http://127.0.0.1:${raw.port}/v1`,
      hits,
      close: raw.close,
    }
    openFixtures.push(fixture)
    return fixture
  })
}

afterEach(async () => {
  while (openFixtures.length) {
    await openFixtures.pop()!.close()
  }
})

// ---------------------------------------------------------------------------
// Adapter spawn helper
// ---------------------------------------------------------------------------

type RunResult = { stdout: string; stderr: string; exitCode: number | null }

async function runAdapter(opts: {
  env: Record<string, string | undefined>
  stdin?: string
  signalAfterMs?: { signal: NodeJS.Signals; ms: number }
}): Promise<RunResult> {
  const child = Bun.spawn([process.execPath, ADAPTER], {
    env: { ...process.env, ...opts.env } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (opts.stdin !== undefined) child.stdin.write(opts.stdin)
  child.stdin.end()
  if (opts.signalAfterMs) {
    setTimeout(() => child.kill(opts.signalAfterMs!.signal), opts.signalAfterMs.ms)
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

// Short deadlines so timeout/stall/absolute-ceiling tests run in milliseconds
// instead of the real 3s/120s/900s ceilings, per the task capsule.
const FAST_DEADLINES = {
  SHELLQ_LOCAL_OPENAI_TEST_DISCOVERY_CONNECT_MS: "300",
  SHELLQ_LOCAL_OPENAI_TEST_DISCOVERY_ABSOLUTE_MS: "300",
  SHELLQ_LOCAL_OPENAI_TEST_POST_CONNECT_MS: "300",
  SHELLQ_LOCAL_OPENAI_TEST_POST_STALL_MS: "150",
  SHELLQ_LOCAL_OPENAI_TEST_POST_ABSOLUTE_MS: "600",
}

// ---------------------------------------------------------------------------
// Request/response fixtures matching the shellq.plugin.zsh wire shape
// ---------------------------------------------------------------------------

const askRequest = (query: string) =>
  JSON.stringify({
    version: 1,
    mode: "ask",
    instructions: "ignored by the adapter; it uses its own fixed system contract",
    response_schema: { answer: "string" },
    input: {
      query,
      environment: { cwd: "/tmp/project", shell: "zsh 5.9", platform: "darwin", identity: { shell_pid: 4242, sequence: 1 } },
      captured_output: "",
      captured_output_is_untrusted: true,
    },
  })

const commandRequest = (mode: "generate" | "correct", command: string) =>
  JSON.stringify({
    version: 1,
    mode,
    instructions: "ignored by the adapter",
    response_schema: {},
    input: {
      command,
      exit_status: mode === "correct" ? 127 : null,
      pipeline_statuses: mode === "correct" ? [127] : [],
      cwd: "/tmp/project",
      shell: "zsh 5.9",
      platform: "darwin",
      identity: { shell_pid: 4242, herdr_socket_path: "/tmp/herdr.sock", herdr_pane_id: "pane-1", sequence: 3 },
      captured_output: "bash: nope: command not found",
      captured_output_is_untrusted: true,
      captured_output_correlated_to_command: true,
    },
  })

const catalogBody = (ids: string[]) => JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) })

const askContent = (answer: string) => JSON.stringify({ answer })
const commandContent = (fields: Partial<{ tldr: string; corrected_command: string | null; confidence: number; risk: string }>) =>
  JSON.stringify({
    tldr: "runs the thing",
    corrected_command: "echo ok",
    confidence: 0.8,
    risk: "low",
    ...fields,
  })

const batchCommandContent = () => JSON.stringify({
  candidates: [
    JSON.parse(commandContent({ tldr: 'Use a literal brace string: {"mode":"safe"}.' })),
    JSON.parse(commandContent({ corrected_command: "printf '%s\\n' ok", tldr: "Use printf for predictable output; choose it when shell portability matters." })),
  ],
})

function chatCompletion(content: string, finishReason = "stop", role = "assistant"): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role, content }, finish_reason: finishReason }],
  })
}

// Ask completions stream: the adapter now sends `stream: true` for Ask, so an
// ask fixture answers with Server-Sent Events carrying the same content,
// split across event boundaries to exercise fragmented SSE handling.
function sseAskCompletion(content: string, finishReason = "stop"): string {
  const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  let body = ""
  const midpoint = Math.max(1, Math.floor(content.length / 2))
  for (const fragment of [content.slice(0, midpoint), content.slice(midpoint)]) {
    if (!fragment) continue
    body += event({ choices: [{ index: 0, delta: { content: fragment } }] })
  }
  body += event({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
  body += "data: [DONE]\n\n"
  return body
}

function jsonRoute(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(body)
}

// A streaming Ask stdout is preview records followed by the final object;
// the last line is the authoritative one, exactly as the workbench reads it.
function finalJson(stdout: string): unknown {
  const lines = stdout.trim().split("\n")
  return JSON.parse(lines[lines.length - 1])
}

// ---------------------------------------------------------------------------
// Pure unit tests: endpoint grammar and peer verification
// ---------------------------------------------------------------------------

describe("validateEndpoint", () => {
  test("accepts the literal IPv4 loopback base with an optional trailing slash", () => {
    expect(validateEndpoint("http://127.0.0.1:8000/v1").raw).toBe("http://127.0.0.1:8000/v1")
    expect(validateEndpoint("http://127.0.0.1:8000/v1/").raw).toBe("http://127.0.0.1:8000/v1")
    expect(validateEndpoint("http://127.0.0.1:1/v1").port).toBe(1)
    expect(validateEndpoint("http://127.0.0.1:65535/v1").port).toBe(65535)
  })

  test("accepts the literal IPv6 loopback base", () => {
    const endpoint = validateEndpoint("http://[::1]:8000/v1")
    expect(endpoint.family).toBe(6)
    expect(endpoint.peerLiteral).toBe("::1")
  })

  const rejected: Array<[string, string]> = [
    ["https scheme", "https://127.0.0.1:8000/v1"],
    ["DNS name", "http://example.com:8000/v1"],
    ["localhost", "http://localhost:8000/v1"],
    ["other 127/8 spelling", "http://127.0.0.2:8000/v1"],
    ["integer IPv4", "http://2130706433:8000/v1"],
    ["hex IPv4", "http://0x7f000001:8000/v1"],
    ["mapped IPv6", "http://[::ffff:127.0.0.1]:8000/v1"],
    ["zone id", "http://[::1%25en0]:8000/v1"],
    ["userinfo", "http://user:pass@127.0.0.1:8000/v1"],
    ["percent escape", "http://127.0.0.1:8000/v1%2e"],
    ["whitespace", "http://127.0.0.1:8000/v1 "],
    ["dot segment", "http://127.0.0.1:8000/v1/../v1"],
    ["query", "http://127.0.0.1:8000/v1?x=1"],
    ["fragment", "http://127.0.0.1:8000/v1#x"],
    ["alternate path", "http://127.0.0.1:8000/v2"],
    ["omitted port", "http://127.0.0.1/v1"],
    ["leading-zero port", "http://127.0.0.1:08000/v1"],
    ["zero port", "http://127.0.0.1:0/v1"],
    ["out-of-range port", "http://127.0.0.1:70000/v1"],
    ["non-numeric port", "http://127.0.0.1:abcd/v1"],
  ]
  for (const [label, raw] of rejected) {
    test(`rejects ${label}`, () => {
      expect(() => validateEndpoint(raw)).toThrow()
      try {
        validateEndpoint(raw)
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterFailure)
        expect((error as AdapterFailure).kind).toBe("INVALID_ENDPOINT")
      }
    })
  }
})

describe("peerIsTrusted", () => {
  test("accepts only the exact expected literal", () => {
    expect(peerIsTrusted("127.0.0.1", "127.0.0.1")).toBe(true)
    expect(peerIsTrusted("::1", "::1")).toBe(true)
  })
  test("rejects any other remote address, including undefined", () => {
    expect(peerIsTrusted("10.0.0.5", "127.0.0.1")).toBe(false)
    expect(peerIsTrusted("::ffff:127.0.0.1", "127.0.0.1")).toBe(false)
    expect(peerIsTrusted(undefined, "127.0.0.1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fixture-driven adapter behavior
// ---------------------------------------------------------------------------

describe("local-openai-provider discover mode", () => {
  test("absent, empty and invalid endpoint inputs fail before a socket without a default", async () => {
    for (const endpoint of [undefined, "", "private-invalid-endpoint"]) {
      const result = await runAdapter({ env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" } })
      expect(result).toEqual({ stdout: "", stderr: "local-openai: invalid endpoint\n", exitCode: 65 })
    }
  })

  test("shared endpoint grammar imports without signal or network side effects", async () => {
    const child = Bun.spawn([process.execPath, "-e", `
      const signals = ["SIGHUP", "SIGINT", "SIGTERM"];
      const before = signals.map(s => process.listenerCount(s));
      const { parseLocalEndpoint } = await import("./local-endpoint");
      if (signals.some((s, i) => process.listenerCount(s) !== before[i])) process.exit(1);
      if (parseLocalEndpoint("http://[::1]:1/v1/")?.raw !== "http://[::1]:1/v1") process.exit(2);
    `], { cwd: join(import.meta.dir, "../src"), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("")
    expect(await new Response(child.stderr).text()).toBe("")
  })

  test("counts only the header section when a large legal body shares one network chunk", async () => {
    const envelope = JSON.parse(chatCompletion(commandContent({}), "stop")) as Record<string, unknown>
    envelope.unused_envelope_field = "x".repeat(40_000)
    const body = JSON.stringify(envelope)
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const head = [
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n")
      req.socket.end(Buffer.from(head + body))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      tldr: "runs the thing",
      corrected_command: "echo ok",
      confidence: 0.8,
      risk: "low",
    })
  })

  test("rejects a genuinely oversized header section", async () => {
    const fixture = await startFixture((req) => {
      const head = [
        "HTTP/1.1 200 OK",
        `X-Fill: ${"x".repeat(16 * 1024)}`,
        "Content-Length: 0",
        "Connection: close",
        "",
        "",
      ].join("\r\n")
      req.socket.end(head)
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(69)
    expect(result.stderr.trim()).toBe("local-openai: malformed catalog")
  })

  test("admits a 9-entry catalog, including a non-chat entry, preserving order", async () => {
    const ids = ["chat-a", "chat-b", "embed-only", "chat-c", "chat-d", "chat-e", "chat-f", "chat-g", "chat-h"]
    const fixture = await startFixture((req, res) => {
      expect(req.method).toBe("GET")
      expect(req.url).toBe("/v1/models")
      expect(req.headers.accept).toBe("application/json")
      jsonRoute(res, 200, catalogBody(ids))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout) as { object: string; data: { id: string }[] }
    expect(parsed.object).toBe("list")
    expect(parsed.data.map((entry) => entry.id)).toEqual(ids)
    expect(fixture.hits.length).toBe(1)
  })

  test("treats an empty admitted list as EMPTY, not a failure", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 200, catalogBody([])))
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ object: "list", data: [] })
  })

  test("drops a non-conforming id without failing the catalog", async () => {
    const fixture = await startFixture((_req, res) =>
      jsonRoute(res, 200, JSON.stringify({ object: "list", data: [{ id: "ok-model" }, { id: "bad id with spaces" }, { id: 42 }] })),
    )
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).data).toEqual([{ id: "ok-model" }])
  })

  test("rejects duplicate admitted IDs as CATALOG_MALFORMED", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 200, catalogBody(["dup", "dup"])))
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(69)
    expect(result.stderr.trim()).toBe("local-openai: malformed catalog")
    expect(result.stdout).toBe("")
  })

  test("HTTP 401 on discovery is AUTH_REQUIRED", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 401, JSON.stringify({ error: "nope" })))
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(67)
    expect(result.stderr.trim()).toBe("local-openai: authentication required")
  })

  test("HTTP 405 with a distinct error body shape is PROTOCOL_MISMATCH and never leaks the body", async () => {
    const secretBody = JSON.stringify({ error: { type: "method_not_allowed", allowed: ["POST"] } })
    const fixture = await startFixture((_req, res) => jsonRoute(res, 405, secretBody, { Allow: "POST" }))
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(68)
    expect(result.stderr.trim()).toBe("local-openai: protocol mismatch")
    expect(result.stdout).not.toContain("method_not_allowed")
    expect(result.stderr).not.toContain("method_not_allowed")
  })

  test("a 307 on the models path is PROTOCOL_MISMATCH and follows nothing", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(307, { Location: "/v1/models/" })
      res.end()
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(68)
    expect(result.stderr.trim()).toBe("local-openai: protocol mismatch")
    expect(fixture.hits.length).toBe(1)
  })

  test("a redirect to a non-loopback host is PROTOCOL_MISMATCH with zero follow and zero POST", async () => {
    const fixture = await startFixture((_req, res) => {
      res.writeHead(302, { Location: "http://93.184.216.34/v1/models" })
      res.end()
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(68)
    expect(fixture.hits.length).toBe(1)
    expect(fixture.hits.every((hit) => hit.path === "/v1/models" && hit.method === "GET")).toBe(true)
  })

  test("invalid endpoint sends zero traffic", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 200, catalogBody(["should-not-be-hit"])))
    const badEndpoint = fixture.endpoint.replace("127.0.0.1", "localhost")
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: badEndpoint, SHELLQ_LOCAL_OPENAI_MODE: "discover" },
    })
    expect(result.exitCode).toBe(65)
    expect(result.stderr.trim()).toBe("local-openai: invalid endpoint")
    expect(fixture.hits.length).toBe(0)
  })
})

describe("local-openai-provider default mode: preflight + completion", () => {
  test("batch candidates reject Ask before discovery traffic", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 200, catalogBody(["target-model"])))
    const request = { ...JSON.parse(askRequest("what is going on")), candidate_count: 3 }
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: JSON.stringify(request),
    })
    expect(result.exitCode).toBe(64)
    expect(result.stderr.trim()).toBe("local-openai: invalid request")
    expect(fixture.hits).toEqual([])
  })

  test("batch candidates allow fewer safe Command responses with a strict envelope", async () => {
    let body: Record<string, any> | undefined
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () => {
        body = JSON.parse(raw)
        jsonRoute(res, 200, chatCompletion(batchCommandContent(), "stop"))
      })
    })
    const request = { ...JSON.parse(commandRequest("generate", "list files")), candidate_count: 5 }
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: JSON.stringify(request),
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      candidates: [
        { tldr: 'Use a literal brace string: {"mode":"safe"}.', corrected_command: "echo ok", confidence: 0.8, risk: "low" },
        { tldr: "Use printf for predictable output; choose it when shell portability matters.", corrected_command: "printf '%s\\n' ok", confidence: 0.8, risk: "low" },
      ],
    })
    expect(body?.n).toBe(1)
    expect(body?.max_tokens).toBeUndefined()
    expect(body?.max_completion_tokens).toBeUndefined()
    expect(fixture.hits.map(hit=>hit.path)).toEqual(["/v1/models","/v1/chat/completions"])
    expect(body?.temperature).toBe(0)
    expect(body?.stream).toBe(false)
    expect(body?.response_format?.json_schema?.schema?.properties?.candidates?.maxItems).toBe(5)
    expect(body?.messages?.[0]?.content).toContain("5 distinct useful approaches")
    for (const count of [2, 4]) {
      const additional = await runAdapter({
        env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
        stdin: JSON.stringify({ ...JSON.parse(commandRequest("generate", "list files")), candidate_count: count }),
      })
      expect(additional.exitCode).toBe(0)
      expect(JSON.parse(additional.stdout).candidates).toHaveLength(2)
      expect(body?.response_format?.json_schema?.schema?.properties?.candidates?.maxItems).toBe(count)
    }
  })

  test("batch candidates reject Fix mixing null with commands", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const content = JSON.stringify({ candidates: [
        JSON.parse(commandContent({ corrected_command: null })),
        JSON.parse(commandContent({ corrected_command: "echo fixed" })),
      ] })
      jsonRoute(res, 200, chatCompletion(content, "stop"))
    })
    const request = { ...JSON.parse(commandRequest("correct", "nope")), candidate_count: 3 }
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: JSON.stringify(request),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("an unknown model returning HTTP 404 whose body enumerates model names is MODEL_GONE, and no name leaks", async () => {
    const secretModelNames = ["totally-secret-internal-model-alpha", "totally-secret-internal-model-beta"]
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model", ...secretModelNames]))
      jsonRoute(res, 404, JSON.stringify({ error: `model not found; available: ${secretModelNames.join(", ")}` }))
    })
    const result = await runAdapter({
      env: {
        SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint,
        SHELLQ_LOCAL_OPENAI_MODEL: "target-model",
      },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(70)
    expect(result.stderr.trim()).toBe("local-openai: model no longer advertised")
    for (const name of secretModelNames) {
      expect(result.stdout).not.toContain(name)
      expect(result.stderr).not.toContain(name)
    }
  })

  test("an advertised model returning HTTP 409 on completion is REQUEST_REJECTED", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 409, JSON.stringify({ error: "model failed to load" }))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(71)
    expect(result.stderr.trim()).toBe("local-openai: request rejected")
  })

  test("a non-chat model that echoes the request while satisfying the envelope is still rejected", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["echo-model"]))
      let raw = ""
      req.on("data", (chunk) => (raw += chunk))
      req.on("end", () => {
        // Envelope-valid: one choice, assistant string content, stop finish
        // reason — but content is the echoed request body, not schema JSON.
        jsonRoute(res, 200, chatCompletion(raw, "stop"))
      })
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "echo-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("an accepted-but-invalid response_format returning HTTP 200 is COMPLETION_MALFORMED", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      // Missing "risk" and wrong type for confidence.
      const badContent = JSON.stringify({ tldr: "ok", corrected_command: "echo ok", confidence: "high" })
      jsonRoute(res, 200, chatCompletion(badContent, "stop"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("HTTP 200 with a whitespace-only completion body is malformed", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, "   \n\t  ")
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("HTTP 200 with an empty content-length completion is malformed", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      res.writeHead(200, { "Content-Length": "0" })
      res.end()
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("prematurely closed HTTP 200 completion remains a lost connection", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      req.socket.end("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{}")
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(77)
    expect(result.stderr.trim()).toBe("local-openai: connection lost")
  })

  test("valid required fields plus one extra content key is COMPLETION_MALFORMED", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const content = JSON.stringify({
        tldr: "ok",
        corrected_command: "echo ok",
        confidence: 0.9,
        risk: "low",
        injected: "extra",
      })
      jsonRoute(res, 200, chatCompletion(content, "stop"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("rejects duplicate content keys, including escaped-equivalent names", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const duplicate = '{"tldr":"first","corrected_command":"echo ok","confidence":0.8,"risk":"low","\\u0074ldr":"second"}'
      jsonRoute(res, 200, chatCompletion(duplicate, "stop"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("preserves valid whitespace and escaped values while parsing completion content", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const content = '{\n  "tldr": "say \\"ok\\"",\n  "corrected_command": "printf \\"ok\\"",\n  "confidence": 0.8,\n  "risk": "low"\n}'
      jsonRoute(res, 200, chatCompletion(content, "stop"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      tldr: 'say "ok"',
      corrected_command: 'printf "ok"',
      confidence: 0.8,
      risk: "low",
    })
  })

  test("rejects a completion whose message role is not assistant", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, chatCompletion(commandContent({}), "stop", "user"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("valid Command content with finish_reason length is rejected", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, chatCompletion(commandContent({}), "length"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("Ask rejects a truncated finish_reason even when the content is valid", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, sseAskCompletion(askContent("this is a complete answer"), "length"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: askRequest("what is going on"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("empty Ask content with finish_reason length is malformed, not a lost connection", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, sseAskCompletion("", "length"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: askRequest("what is going on"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("cleanly finished empty Ask content is malformed", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, sseAskCompletion("", "stop"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: askRequest("what is going on"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("Fix accepts a null corrected_command; Command rejects one", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      jsonRoute(res, 200, chatCompletion(commandContent({ corrected_command: null }), "stop"))
    })
    const fix = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("correct", "nope"),
    })
    expect(fix.exitCode).toBe(0)
    expect(JSON.parse(fix.stdout).corrected_command).toBeNull()

    const command = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(command.exitCode).toBe(74)
  })

  test("a successful Command completion reconstructs exactly the four allowlisted fields, stripping envelope extras", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const envelope = {
        id: "chatcmpl-extra",
        object: "chat.completion",
        system_fingerprint: "abc123",
        usage: { total_tokens: 512 },
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: commandContent({}), refusal: null },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      }
      jsonRoute(res, 200, JSON.stringify(envelope))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ tldr: "runs the thing", corrected_command: "echo ok", confidence: 0.8, risk: "low" })
  })

  for (const framing of ["content-length", "chunked"] as const) {
    test(`closes a completed ${framing} response socket before exiting`, async () => {
      let resolveClosed!: () => void
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve
      })
      const body = Buffer.from(chatCompletion(commandContent({}), "stop"))
      const fixture = await startFixture((req, res) => {
        if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
        req.socket.once("close", resolveClosed)
        const response =
          framing === "content-length"
            ? [
                "HTTP/1.1 200 OK",
                "Content-Type: application/json",
                `Content-Length: ${body.byteLength}`,
                "Connection: keep-alive",
                "",
                body.toString("utf8"),
              ].join("\r\n")
            : [
                "HTTP/1.1 200 OK",
                "Content-Type: application/json",
                "Transfer-Encoding: chunked",
                "Connection: keep-alive",
                "",
                body.byteLength.toString(16),
                body.toString("utf8"),
                "0",
                "",
                "",
              ].join("\r\n")
        req.socket.write(response)
      })
      const result = await runAdapter({
        env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
        stdin: commandRequest("generate", "list files"),
      })
      expect(result.exitCode).toBe(0)
      const socketClosed = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ])
      expect(socketClosed).toBe(true)
    })
  }

  for (const context of ["discovery", "completion"] as const) {
    for (const status of [401, 503]) {
      for (const framing of ["malformed chunks", "oversized", "premature close"] as const) {
        test(`${context} classifies ${status} before ${framing} error body`, async () => {
          const fixture = await startFixture((req, res) => {
            if (context === "completion" && req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
            const wire = framing === "malformed chunks"
              ? "Transfer-Encoding: chunked\r\n\r\ninvalid-chunk\r\nprivate-body"
              : framing === "oversized"
                ? `Content-Length: 300000\r\n\r\n${"private-body".repeat(28000)}`
                : "Content-Length: 1000\r\n\r\nprivate-body"
            req.socket.end(`HTTP/1.1 ${status} Failure\r\n${wire}`)
          })
          const result = await runAdapter({
            env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model",
              ...(context === "discovery" ? { SHELLQ_LOCAL_OPENAI_MODE: "discover" } : {}) },
            stdin: context === "completion" ? commandRequest("generate", "list files") : undefined,
          })
          expect(result.exitCode).toBe(status === 401 ? 67 : 73)
          expect(result.stderr.trim()).toBe(status === 401 ? "local-openai: authentication required" : "local-openai: server failed")
          expect(result.stdout).toBe("")
        })
      }
    }
  }

  test("a silent response hits stall before a valid response inside the absolute bound", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      // Without the 150ms stall timer this succeeds before the 600ms ceiling.
      const timer = setTimeout(() => jsonRoute(res, 200, chatCompletion(commandContent({}), "stop")), 400)
      res.on("close", () => clearTimeout(timer))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model", ...FAST_DEADLINES },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(76)
    expect(result.stderr.trim()).toBe("local-openai: timed out")
  })

  test("a byte trickle within the stall window still hits the absolute ceiling", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      res.writeHead(200, { "Content-Type": "application/json" })
      const timer = setInterval(() => {
        if (res.writableEnded) return clearInterval(timer)
        res.write(" ")
      }, 40) // well under the 150ms fast stall window
      // Without the absolute timer this eventually succeeds; it cannot hang
      // until a test-runner timeout and be confused with the adapter's bound.
      const finish = setTimeout(() => res.end(chatCompletion(commandContent({}), "stop")), 1000)
      res.on("close", () => { clearInterval(timer); clearTimeout(finish) })
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model", ...FAST_DEADLINES },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(76)
    expect(result.stderr.trim()).toBe("local-openai: timed out")
  })

  test("a listener that answers discovery then closes before POST is ENDPOINT_UNAVAILABLE", async () => {
    const fixture = await startFixture((req, res) => {
      jsonRoute(res, 200, catalogBody(["target-model"]))
      setImmediate(() => fixture.close())
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(66)
    expect(result.stderr.trim()).toBe("local-openai: endpoint unavailable")
  })

  test("an oversized command field is still rejected by final validation", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      const oversized = commandContent({ tldr: "x".repeat(200_000) })
      jsonRoute(res, 200, chatCompletion(oversized, "stop"))
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(74)
    expect(result.stderr.trim()).toBe("local-openai: malformed completion")
  })

  test("invalid stdin JSON is INVALID_REQUEST", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 200, catalogBody(["target-model"])))
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: "{not json",
    })
    expect(result.exitCode).toBe(64)
    expect(result.stderr.trim()).toBe("local-openai: invalid request")
    expect(fixture.hits.length).toBe(0)
  })

  test("a missing model env var is INVALID_REQUEST before any network traffic", async () => {
    const fixture = await startFixture((_req, res) => jsonRoute(res, 200, catalogBody(["target-model"])))
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint },
      stdin: commandRequest("generate", "list files"),
    })
    expect(result.exitCode).toBe(64)
    expect(fixture.hits.length).toBe(0)
  })
})

describe("local-openai-provider cancellation", () => {
  test("SIGHUP during an in-flight request exits without writing a result", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      // Hold the completion connection open indefinitely.
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
      signalAfterMs: { signal: "SIGHUP", ms: 150 },
    })
    expect(result.exitCode).toBe(129)
    expect(result.stderr.trim()).toBe("local-openai: cancelled")
    expect(result.stdout).toBe("")
  })

  test("SIGTERM during an in-flight request exits with the cancellation code and no result", async () => {
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      // Hold the completion connection open indefinitely.
    })
    const result = await runAdapter({
      env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
      stdin: commandRequest("generate", "list files"),
      signalAfterMs: { signal: "SIGTERM", ms: 150 },
    })
    expect(result.exitCode).toBe(143)
    expect(result.stderr.trim()).toBe("local-openai: cancelled")
    expect(result.stdout).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Producer/parser contract
//
// The adapter's stdin shape was inferred before anything was wired to it. These
// drive the REAL production request builders (`buildProviderRequest` /
// `buildAskRequest`) over the REAL `shellq.plugin.zsh` templates, so a drift
// between producer and parser fails here rather than at a user's first turn.
// ---------------------------------------------------------------------------

describe("workbench request builders match the adapter's parser", () => {
  // Captured verbatim from `_shellq_ask_request_json` / `_shellq_request_json`.
  const templates = () => ({
    ask: JSON.parse(
      '{"version":1,"mode":"ask","instructions":"Answer input.query directly.","response_schema":{"answer":"..."},' +
        '"input":{"query":"","environment":{"cwd":"/tmp/project","shell":"zsh 5.9","platform":"darwin25.0",' +
        '"identity":{"shell_pid":80860,"herdr_socket_path":"/tmp/h.sock","herdr_pane_id":"w0:p1","sequence":4}},' +
        '"captured_output":"","captured_output_is_untrusted":true}}',
    ),
    generate: JSON.parse(
      '{"version":1,"mode":"generate","instructions":"Turn input.command into a shell command.","response_schema":{},' +
        '"input":{"command":"","exit_status":null,"pipeline_statuses":[],"cwd":"/tmp/project","shell":"zsh 5.9",' +
        '"platform":"darwin25.0","identity":{"shell_pid":80860,"herdr_socket_path":"/tmp/h.sock","herdr_pane_id":"w0:p1","sequence":0},' +
        '"captured_output":"","captured_output_is_untrusted":true,"captured_output_correlated_to_command":false}}',
    ),
    correct: JSON.parse(
      '{"version":1,"mode":"correct","instructions":"Diagnose.","response_schema":{},' +
        '"input":{"command":"ls /nope","exit_status":127,"pipeline_statuses":[127],"cwd":"/tmp/project","shell":"zsh 5.9",' +
        '"platform":"darwin25.0","identity":{"shell_pid":80860,"herdr_socket_path":"/tmp/h.sock","herdr_pane_id":"pane-1","sequence":3},' +
        '"captured_output":"ls: /nope","captured_output_is_untrusted":true,"captured_output_correlated_to_command":true}}',
    ),
  })

  const session = () =>
    ({
      requests: templates(),
      context: {
        text: "ls: /nope: No such file or directory",
        source: "tmux",
        label: "recent pane only",
        correlated: true,
        included: true,
      },
      last_command: {
        command: "ls /nope",
        cwd: "/tmp/project",
        exit_status: 127,
        pipeline_statuses: [127],
      },
    }) as unknown as WorkbenchSession

  const completionPayload = async (
    request: Record<string, unknown>,
    content: string,
  ): Promise<{ payload: Record<string, any>; result: RunResult }> => {
    let posted: Record<string, any> | null = null
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      let body = ""
      req.on("data", (chunk) => {
        body += chunk
      })
      req.on("end", () => {
        posted = JSON.parse(body)
        jsonRoute(res, 200, request.mode === "ask" ? sseAskCompletion(content) : chatCompletion(content, "stop"))
      })
    })
    const result = await runAdapter({
      env: {
        SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint,
        SHELLQ_LOCAL_OPENAI_MODEL: "target-model",
      },
      stdin: JSON.stringify(request),
    })
    return { payload: JSON.parse(posted!.messages[1].content), result }
  }

  test("a built Command request is accepted and reduced to the allowlisted payload", async () => {
    const request = buildProviderRequest(
      session(),
      "generate",
      "list the files",
      "ls: /nope: No such file or directory",
      true,
      [],
    )
    const { payload, result } = await completionPayload(request, commandContent({}))
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      tldr: "runs the thing",
      corrected_command: "echo ok",
      confidence: 0.8,
      risk: "low",
    })
    expect(Object.keys(payload).sort()).toEqual([
      "command",
      "environment",
      "output",
      "previous_command",
      "status",
    ])
    expect(payload.command).toBe("list the files")
    // The builder writes cwd/shell/platform FLAT on `input` for Command/Fix
    // (unlike Ask's nested `input.environment`); the parser reads them from the
    // same place, which is the contract this test exists to hold.
    expect(payload.environment).toEqual({
      cwd: "/tmp/project",
      shell: "zsh 5.9",
      platform: "darwin25.0",
    })
    expect(payload.status).toEqual({ exit_status: null, pipeline_statuses: [] })
    expect(payload.output.captured_output).toBe("ls: /nope: No such file or directory")
    expect(payload.previous_command).toEqual({
      command: "ls /nope",
      cwd: "/tmp/project",
      exit_status: 127,
      pipeline_statuses: [127],
    })
    expect(JSON.stringify(payload)).not.toContain("shell_pid")
    expect(JSON.stringify(payload)).not.toContain("herdr")
    expect(JSON.stringify(payload)).not.toContain("sequence")
    expect(JSON.stringify(payload)).not.toContain("instructions")
  })

  test("a built Fix request carries its status, correlation, and avoided commands", async () => {
    const request = buildProviderRequest(
      session(),
      "correct",
      "ls /nope",
      "ls: /nope: No such file or directory",
      true,
      [{ tldr: "prior", corrected_command: "echo prior", confidence: 0.4, risk: "low" }],
    )
    const { payload, result } = await completionPayload(
      request,
      commandContent({ corrected_command: null }),
    )
    expect(result.exitCode).toBe(0)
    expect(payload.status).toEqual({ exit_status: 127, pipeline_statuses: [127] })
    expect(payload.output.captured_output_correlated_to_command).toBe(true)
    expect(payload.avoid_commands).toEqual(["echo prior"])
  })

  test("a built Ask request reaches the parser through its nested environment", async () => {
    const request = buildAskRequest(
      session(),
      "what does this directory hold",
      "ls: /nope: No such file or directory",
      true,
    )
    const { payload, result } = await completionPayload(request, askContent("a local answer"))
    expect(result.exitCode).toBe(0)
    expect(finalJson(result.stdout)).toEqual({ answer: "a local answer" })
    expect(Object.keys(payload).sort()).toEqual([
      "captured_output",
      "captured_output_is_untrusted",
      "environment",
      "previous_command",
      "query",
    ])
    expect(payload.query).toBe("what does this directory hold")
    expect(payload.environment).toEqual({
      cwd: "/tmp/project",
      shell: "zsh 5.9",
      platform: "darwin25.0",
    })
    expect(JSON.stringify(payload)).not.toContain("shell_pid")
    expect(JSON.stringify(payload)).not.toContain("herdr")
  })
})

// ---------------------------------------------------------------------------
// SPIKE(local-stream-ask): streamed Ask over Server-Sent Events
//
// The fixture writes its SSE body in tiny timed writes, so every TCP write
// can split a chunked-framing header, an SSE line, a JSON string escape, or
// a multi-byte UTF-8 sequence. Only genuinely incremental parsing — chunk
// decoder → streaming UTF-8 → SSE assembler → answer scanner — can
// reconstruct it.
// ---------------------------------------------------------------------------

const STREAM_ENV = (endpoint: string): Record<string, string> => ({
  ...FAST_DEADLINES,
  SHELLQ_LOCAL_OPENAI_ENDPOINT: endpoint,
  SHELLQ_LOCAL_OPENAI_MODEL: "target-model",
})

// Serves the SSE text in small slices with a delay, proving preview records
// cross the workbench boundary while the response is still being generated.
function streamSseFixture(sse: string, opts: { slice?: number; delayMs?: number; abortAfterMs?: number; expectStream?: boolean } = {}) {
  return startFixture((req, res) => {
    if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
    let posted = ""
    req.on("data", (chunk) => {
      posted += chunk
    })
    req.on("end", () => {
      const body = JSON.parse(posted) as Record<string, unknown>
      expect(body.stream).toBe(opts.expectStream ?? true)
      expect((body.response_format as Record<string, unknown>).type).toBe("json_schema")
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      // Slice the wire bytes, never JS string indices: a string-index slice
      // can split a surrogate pair before it is ever encoded.
      const wire = Buffer.from(sse, "utf8")
      const slice = opts.slice ?? 12
      let offset = 0
      const timer = setInterval(() => {
        if (offset >= wire.byteLength) {
          clearInterval(timer)
          res.end()
          return
        }
        res.write(wire.subarray(offset, offset + slice))
        offset += slice
      }, opts.delayMs ?? 2)
      if (opts.abortAfterMs !== undefined) {
        setTimeout(() => {
          clearInterval(timer)
          res.socket?.destroy()
        }, opts.abortAfterMs)
      }
    })
  })
}

const streamedAskSse = (content: string, thinking: string[] = [], finishReason = "stop"): string => {
  const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  let body = ""
  for (const reasoning of thinking) {
    body += event({ choices: [{ index: 0, delta: { reasoning_content: reasoning } }] })
  }
  // Content fragments cut mid-string, mid-JSON-escape, and (via the tiny
  // timed slices) mid-UTF-8 sequence, forcing the scanner across every
  // boundary at once. One literal character is re-encoded as its `\uXXXX`
  // escape split across two fragments, so the decoded content is unchanged.
  const escapeIndex = 15
  const hex = content.charCodeAt(escapeIndex).toString(16).padStart(4, "0")
  body += event({ choices: [{ index: 0, delta: { content: content.slice(0, 11) } }] })
  body += event({ choices: [{ index: 0, delta: { content: `${content.slice(11, escapeIndex)}\\u0` } }] })
  body += event({ choices: [{ index: 0, delta: { content: `${hex.slice(1)}${content.slice(escapeIndex + 1)}` } }] })
  body += event({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
  body += "data: [DONE]\n\n"
  return body
}

const streamedStructuredSse = (content: string, finishReason = "stop"): string => {
  const event = (delta: Record<string, unknown>, reason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`
  const midpoint = Math.max(1, Math.floor(content.length / 2))
  return event({ content: content.slice(0, midpoint) }) +
    event({ content: content.slice(midpoint) }) +
    event({}, finishReason) +
    "data: [DONE]\n\n"
}

describe("streamed local Ask (spike)", () => {
  test("answer preview arrives before completion, split-byte SSE parses, thinking stays separate, final validates", async () => {
    const answer = 'Rename with git branch -m. 🙂 Line two — done.'
    const fixture = await streamSseFixture(streamedAskSse(askContent(answer), ["weighing the safe rename path"]), {
      slice: 8,
      delayMs: 8,
    })
    const child = Bun.spawn([process.execPath, ADAPTER], {
      env: { ...process.env, ...STREAM_ENV(fixture.endpoint) } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(askRequest("how do I rename the current branch"))
    child.stdin.end()
    let exited = false
    void child.exited.then(() => {
      exited = true
    })
    // Incremental stdout reader: the first answer preview record must be
    // observable while the adapter is still streaming (before exit, before
    // the final object exists).
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let stdout = ""
    let previewArrivedBeforeExit = false
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stdout += decoder.decode(value ?? new Uint8Array(), { stream: true })
      if (!previewArrivedBeforeExit && stdout.includes('"t":"answer"')) {
        expect(exited).toBe(false)
        previewArrivedBeforeExit = true
        // Still mid-stream: the fixture keeps writing long after the first
        // preview record crossed the boundary.
        await Bun.sleep(120)
        expect(exited).toBe(false)
      }
    }
    stdout += decoder.decode()
    reader.releaseLock()
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe("")

    const lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { t: string; text: string })
    const final = lines[lines.length - 1] as unknown as { answer: string }
    expect(final).toEqual({ answer })
    const deltas = lines.filter((line) => line.t === "answer").map((line) => line.text as string)
    expect(deltas.join("")).toBe(answer)
    // No schema punctuation, envelope key, or brace leaks into any preview.
    for (const text of deltas) {
      expect(text).not.toContain("{")
      expect(text).not.toContain('"answer"')
    }
    expect(lines.filter((line) => line.t === "thinking").map((line) => line.text)).toEqual([
      "weighing the safe rename path",
    ])
    // Preview records precede the final object; the note is the only other
    // provisional record, and it is fixed.
    for (const line of lines.slice(0, -1)) {
      expect(["answer", "thinking", "note"]).toContain(line.t)
      if (line.t === "note") expect(line.text).toBe("Drafting the answer")
    }
    expect(previewArrivedBeforeExit).toBe(true)
    await fixture.close()
  }, 20_000)

  test("thinking seen before a mid-stream failure is never accepted as an answer", async () => {
    const fixture = await streamSseFixture(
      streamedAskSse(askContent("a partial answer"), ["reasoning that must be erased"]),
      { slice: 12, delayMs: 6, abortAfterMs: 60 },
    )
    const result = await runAdapter({
      env: STREAM_ENV(fixture.endpoint),
      stdin: askRequest("anything"),
    })
    expect(result.exitCode).toBe(77)
    expect(result.stderr.trim()).toBe("local-openai: connection lost")
    const lines = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { t: string })
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((line) => line.t === "thinking")).toBe(true)
    // No final object on stdout: only preview records were emitted.
    expect(lines.every((line) => "t" in line)).toBe(true)
    await fixture.close()
  }, 20_000)

  test("SIGINT during streaming exits cancelled with no accepted final", async () => {
    const fixture = await streamSseFixture(streamedAskSse(askContent("never accepted"), ["transient"]), {
      slice: 6,
      delayMs: 8,
    })
    const child = Bun.spawn([process.execPath, ADAPTER], {
      env: { ...process.env, ...STREAM_ENV(fixture.endpoint) } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(askRequest("question"))
    child.stdin.end()
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let stdout = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stdout += decoder.decode(value ?? new Uint8Array(), { stream: true })
      if (stdout.includes('"t":"thinking"')) break
    }
    child.kill("SIGINT")
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      stdout += decoder.decode(value ?? new Uint8Array(), { stream: true })
    }
    stdout += decoder.decode()
    reader.releaseLock()
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode).toBe(130)
    expect(stderr.trim()).toBe("local-openai: cancelled")
    const finalLines = stdout.split("\n").filter(Boolean).filter((line) => !("t" in JSON.parse(line)))
    expect(finalLines).toEqual([])
    // The adapter destroyed its socket: the fixture server cannot be reached
    // for a second request because nothing is left open.
    await fixture.close()
  }, 20_000)
})

describe("opt-in structured local previews", () => {
  for (const mode of ["generate", "correct"] as const) {
    test(`${mode} emits readable previews before the validated final`, async () => {
      const content = commandContent({ tldr: "Explain the safe command.", corrected_command: "printf '%s' ok" })
      const fixture = await streamSseFixture(streamedStructuredSse(content), { slice: 7, delayMs: 2 })
      const result = await runAdapter({
        env: { ...STREAM_ENV(fixture.endpoint), SHELLQ_STREAM_PREVIEW: "1" },
        stdin: commandRequest(mode, "show the value"),
      })
      expect(result.exitCode).toBe(0)
      expect(finalJson(result.stdout)).toEqual(JSON.parse(content))
      const previews = result.stdout.trim().split("\n").slice(0, -1).map(line => JSON.parse(line))
      expect(previews.map(event => event.text).join("")).toContain("Explanation: Explain the safe command.")
      expect(previews.map(event => event.text).join("")).toContain("\nCommand: printf '%s' ok")
      await fixture.close()
    }, 20_000)

    test(`${mode} rejects a non-stop streamed completion after provisional output`, async () => {
      const fixture = await streamSseFixture(streamedStructuredSse(commandContent({}), "length"), { slice: 9 })
      const result = await runAdapter({
        env: { ...STREAM_ENV(fixture.endpoint), SHELLQ_STREAM_PREVIEW: "1" },
        stdin: commandRequest(mode, "show the value"),
      })
      expect(result.exitCode).toBe(74)
      expect(result.stderr).toBe("local-openai: malformed completion\n")
      expect(result.stdout).not.toContain('"corrected_command"')
      await fixture.close()
    }, 20_000)
  }

  test("without the explicit offer, Command remains final-only", async () => {
    let streamFlag: unknown
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      let body = ""
      req.on("data", chunk => { body += chunk })
      req.on("end", () => {
        streamFlag = (JSON.parse(body) as Record<string, unknown>).stream
        jsonRoute(res, 200, chatCompletion(commandContent({})))
      })
    })
    const result = await runAdapter({ env: STREAM_ENV(fixture.endpoint), stdin: commandRequest("generate", "show the value") })
    expect(result.exitCode).toBe(0)
    expect(streamFlag).toBe(false)
    expect(result.stdout).toBe(commandContent({}) + "")
    await fixture.close()
  }, 20_000)
})


describe("stream completion boundary", () => {
  const event = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  const finish = event({}, "stop") + "data: [DONE]\n\n"
  for (const mode of ["missing finish", "wrong role", "tool call", "malformed JSON"]) {
    test(`rejects ${mode} with content-length framing`, async () => {
      const delta = { content: JSON.stringify({ answer: "safe display" }),
        ...(mode === "wrong role" ? { role: "user" } : {}),
        ...(mode === "tool call" ? { tool_calls: [] } : {}),
      }
      const wire = mode === "malformed JSON" ? "data: {broken}\n\n" : event(delta) + (mode === "missing finish" ? "" : finish)
      const fixture = await startFixture((req, res) => {
        if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
        res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Length": Buffer.byteLength(wire) })
        res.end(wire)
      })
      const result = await runAdapter({ env: STREAM_ENV(fixture.endpoint), stdin: askRequest("synthetic") })
      expect(result.exitCode).toBe(74)
      expect(result.stderr).toBe("local-openai: malformed completion\n")
    })
  }
  test("large reasoning, code prose and escaped surrogates preserve the final and preview", async () => {
    const answer = '```json\n{"ok":true}\n``` 🙂'
    const fragments = ['{"answer":"```json\\n{\\"ok\\":true}\\n``` \\ud83d', '\\ude42"}']
    const wire = event({ reasoning_content: "x".repeat(9000) }) +
      event({ reasoning_content: "\x1b]private" }) + event({ reasoning_content: "payload\x07visible" }) +
      fragments.map(content => event({ content })).join("") + finish
    const fixture = await startFixture((req, res) => {
      if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
      res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(wire)
    })
    const result = await runAdapter({ env: STREAM_ENV(fixture.endpoint), stdin: askRequest("synthetic") })
    expect(result.exitCode).toBe(0)
    const previews: {t: string; text: string}[] = []
    const final = await readAskStream(new Response(result.stdout).body!, e => previews.push(e), true, true)
    expect(JSON.parse(final)).toEqual({ answer })
    expect(previews.filter(e => e.t === "answer").map(e => e.text).join("")).toBe(answer)
    const thoughts = previews.filter(e => e.t === "thinking").map(e => e.text).join("")
    expect(thoughts).not.toContain("private")
    expect(thoughts).not.toContain("payload")
    expect(thoughts).toContain("visible")
  })
})


describe("completion wire size", () => {
  for (const mode of ["ask", "generate", "correct"] as const) {
    test(`${mode} accepts transport metadata above the former caps`, async () => {
      const fixture = await startFixture((req, res) => {
        if (req.url === "/v1/models") return jsonRoute(res, 200, catalogBody(["target-model"]))
        const padding = "x".repeat(2 * 1024 * 1024)
        if (mode === "ask") {
          res.writeHead(200, { "Content-Type": "text/event-stream" })
          res.end(`:${padding}\n\n` + `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: askContent("ok") }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)
        } else {
          const envelope = JSON.parse(chatCompletion(commandContent({}), "stop"))
          envelope.metadata = padding
          jsonRoute(res, 200, JSON.stringify(envelope))
        }
      })
      const result = await runAdapter({
        env: { SHELLQ_LOCAL_OPENAI_ENDPOINT: fixture.endpoint, SHELLQ_LOCAL_OPENAI_MODEL: "target-model" },
        stdin: mode === "ask" ? askRequest("synthetic") : commandRequest(mode, "synthetic"),
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(finalJson(result.stdout)).toEqual(mode === "ask" ? { answer: "ok" } : JSON.parse(commandContent({})))
    })
  }
})


describe("explicit local thinking control", () => {
  for (const thinking of ["on", "off"] as const) {
    for (const mode of ["ask", "generate", "correct"] as const) {
      test(`${mode} sends thinking ${thinking} through template kwargs`, async () => {
        let posted: Record<string, unknown> | undefined
        const fixture = await startFixture((req, res) => {
          if (req.url === "/v1/models") { res.end(JSON.stringify({object:"list",data:[{id:"target-model"}]})); return }
          if (req.url === "/props") { res.end(JSON.stringify({chat_template:"{% if enable_thinking %}"})); return }
          let body=""
          req.on("data", chunk => body+=chunk)
          req.on("end", () => {
            posted=JSON.parse(body)
            if (mode === "ask") {
              res.writeHead(200, {"Content-Type":"text/event-stream"})
              res.end(streamedAskSse(askContent("accepted answer")))
            } else {
              res.end(chatCompletion(commandContent({})))
            }
          })
        })
        const result=await runAdapter({env:{SHELLQ_LOCAL_OPENAI_ENDPOINT:fixture.endpoint,SHELLQ_LOCAL_OPENAI_MODEL:"target-model",SHELLQ_LOCAL_OPENAI_THINKING:thinking},stdin:mode==="ask"?askRequest("synthetic"):commandRequest(mode,"synthetic")})
        expect(result.exitCode).toBe(0)
        expect(posted?.max_tokens).toBeUndefined()
        expect(posted?.max_completion_tokens).toBeUndefined()
        expect(posted?.chat_template_kwargs).toEqual({enable_thinking:thinking==="on"})
        expect(fixture.hits.map(hit=>hit.path)).toEqual(["/v1/models","/props","/v1/chat/completions"])
      })
    }
  }
  test("unsupported thinking never silently dispatches an uncontrolled completion", async () => {
    const fixture=await startFixture((req,res)=>res.end(JSON.stringify(req.url==="/v1/models"?{object:"list",data:[{id:"target-model"}]}:{chat_template:"{# enable_thinking is unsupported #}"})))
    const result=await runAdapter({env:{SHELLQ_LOCAL_OPENAI_ENDPOINT:fixture.endpoint,SHELLQ_LOCAL_OPENAI_MODEL:"target-model",SHELLQ_LOCAL_OPENAI_THINKING:"off"},stdin:askRequest("synthetic")})
    expect(result.exitCode).toBe(78)
    expect(fixture.hits.every(hit=>hit.method==="GET")).toBe(true)
  })
})


for (const mode of ["ask", "generate", "correct"] as const) {
  test(`${mode} reported metrics follow valid final framing without becoming answer text`, async () => {
    const usage = {choices:[],usage:{completion_tokens:84},timings:{predicted_n:84,predicted_per_second:40}}
    const content=mode==="ask"?askContent("a valid metrics answer"):commandContent({})
    const sse=streamedAskSse(content).replace("data: [DONE]",`data: ${JSON.stringify(usage)}\n\ndata: [DONE]`)
    const fixture=await streamSseFixture(sse)
    const result=await runAdapter({env:{...STREAM_ENV(fixture.endpoint),SHELLQ_STREAM_PREVIEW:"1"},stdin:mode==="ask"?askRequest("synthetic"):commandRequest(mode,"synthetic")})
    expect(result.exitCode).toBe(0)
    let metrics:unknown
    const final=await readAskStream(new Response(result.stdout).body!,()=>{},true,true,value=>{metrics=value})
    expect(metrics).toEqual({outputTokens:84,tokensPerSecond:40})
    expect(JSON.parse(final)).toEqual(JSON.parse(content))
  })
}



test("batch candidates reject duplicate keys and non-stop completions atomically", async () => {
  let content = ""
  let finishReason = "stop"
  const fixture = await startFixture((req,res) => {
    if (req.url === "/v1/models") return jsonRoute(res,200,catalogBody(["target-model"]))
    jsonRoute(res,200,chatCompletion(content,finishReason))
  })
  const request = {...JSON.parse(commandRequest("correct","synthetic")),candidate_count:3}
  const run = () => runAdapter({env:{SHELLQ_LOCAL_OPENAI_ENDPOINT:fixture.endpoint,SHELLQ_LOCAL_OPENAI_MODEL:"target-model"},stdin:JSON.stringify(request)})
  const member = commandContent({})
  for (const malformed of [
    `{"candidates":[${member}],"candidates":[${member}]}`,
    `{"candidates":[${member.replace('"corrected_command":', '"corrected_command":"echo other","corrected_command":')}]}`,
    `{"candidates":[${member.replace('"corrected_command":', '"corrected_command":"echo other","corrected_\\u0063ommand":')}]}`,
    `{"candidates":[${member},${member}]}`,
    `{"candidates":[${member},${commandContent({confidence:2})}]}`,
  ]) {
    content=malformed
    const result=await run()
    expect(result.exitCode).toBe(74)
    expect(result.stdout).toBe("")
  }
  content=batchCommandContent();finishReason="length"
  expect((await run()).exitCode).toBe(74)
  content=JSON.stringify({candidates:[JSON.parse(commandContent({corrected_command:null}))]});finishReason="stop"
  expect(JSON.parse((await run()).stdout)).toEqual(JSON.parse(content))
  for (const count of [0, 6, 1.5, "3", null]) {
    const before=fixture.hits.length
    const result=await runAdapter({env:{SHELLQ_LOCAL_OPENAI_ENDPOINT:fixture.endpoint,SHELLQ_LOCAL_OPENAI_MODEL:"target-model"},stdin:JSON.stringify({...request,candidate_count:count})})
    expect(result.exitCode).toBe(64)
    expect(fixture.hits).toHaveLength(before)
  }
})
