// Focused checks for bounded local endpoint discovery and endpoint-aware
// selection: adapter scan mode, parent scan revalidation, the probe list
// gates, and the atomic endpoint/model/effort settings write.
import { afterEach, describe, expect, test } from "bun:test"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Socket } from "node:net"

import {
  DEFAULT_LOCAL_ENDPOINT,
  LOCAL_SCAN_PORTS,
  LOCAL_PROVIDER_ID,
  inferenceSettingsFile,
  localAdapterEnvironment,
  localScanEndpoints,
  parseLocalScan,
  readPersistedInferenceDocument,
  writePersistedInferenceSettings,
  writePersistedLocalSelection,
  type LocalEndpointResolution,
} from "../src/workbench"

const ADAPTER = join(import.meta.dir, "../src", "local-openai-provider.ts")

// ---------------------------------------------------------------------------
// Fixture server helper (same discipline as local-openai-provider.test.ts)
// ---------------------------------------------------------------------------

type Fixture = {
  port: number
  endpoint: string
  hits: { path: string; method: string }[]
  close: () => Promise<void>
}

const openFixtures: Fixture[] = []
const openServers: Server[] = []

function startFixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Fixture> {
  return new Promise((resolve) => {
    const hits: { path: string; method: string }[] = []
    const sockets = new Set<Socket>()
    let closed = false
    const server = createServer((req, res) => {
      hits.push({ path: req.url ?? "", method: req.method ?? "" })
      handler(req, res)
    })
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })
    openServers.push(server)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      const fixture: Fixture = {
        port: address.port,
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        hits,
        close: () =>
          new Promise<void>((r) => {
            if (closed) return r()
            closed = true
            server.close(() => r())
            for (const socket of sockets) socket.destroy()
          }),
      }
      openFixtures.push(fixture)
      resolve(fixture)
    })
  })
}

// A port that answers nothing: bind, capture the port, release.
async function closedPort(): Promise<number> {
  const server = createServer()
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

afterEach(async () => {
  while (openFixtures.length) await openFixtures.pop()!.close()
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function runAdapter(env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const child = Bun.spawn([process.execPath, ADAPTER], {
    env: { ...process.env, ...env } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  child.stdin.end()
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    exitCode: await child.exited,
  }
}

const catalogBody = (ids: string[]) => JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) })

// ---------------------------------------------------------------------------
// Adapter scan mode
// ---------------------------------------------------------------------------

describe("local adapter scan mode", () => {
  test("queries only the bounded list over GET, quietly drops failed endpoints, and a slow peer does not delay a healthy one", async () => {
    const healthy = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(catalogBody(["alpha-model", "beta-model"]))
    })
    const malformed = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("not json at all")
    })
    const redirecting = await startFixture((_req, res) => {
      res.writeHead(302, { Location: "http://10.9.8.7:1/v1/models" })
      res.end()
    })
    const slow = await startFixture((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(catalogBody(["too-late"]))
      }, 5_000)
    })
    const quiet = await closedPort()
    const endpoints = [healthy.endpoint, malformed.endpoint, redirecting.endpoint, slow.endpoint, `http://127.0.0.1:${quiet}/v1`]

    const started = Date.now()
    const { stdout, exitCode } = await runAdapter({
      SHELLQ_LOCAL_OPENAI_MODE: "scan",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: endpoints[0],
      SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS: endpoints.join(" "),
      SHELLQ_LOCAL_OPENAI_TEST_SCAN_ABSOLUTE_MS: "800",
      SHELLQ_LOCAL_OPENAI_TEST_DISCOVERY_CONNECT_MS: "300",
    })
    const elapsed = Date.now() - started

    expect(exitCode).toBe(0)
    // The whole scan returns inside the short ceiling, far below the slow
    // peer's 5s answer: one unreachable endpoint cannot delay the rest.
    expect(elapsed).toBeLessThan(3_500)
    const catalogs = parseLocalScan(stdout, endpoints)
    expect(catalogs).not.toBeNull()
    expect([...catalogs!.keys()]).toEqual([healthy.endpoint])
    expect(catalogs!.get(healthy.endpoint)).toEqual(["alpha-model", "beta-model"])
    // GET only, on the models path, zero POSTs anywhere.
    for (const fixture of [healthy, malformed, redirecting, slow]) {
      expect(fixture.hits.length).toBeGreaterThan(0)
      for (const hit of fixture.hits) {
        expect(hit.method).toBe("GET")
        expect(hit.path).toBe("/v1/models")
      }
    }
    expect(healthy.hits).toHaveLength(1)
  })

  test("dedupes repeated endpoints, ignores ungrammatical tokens, and still answers", async () => {
    const healthy = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(catalogBody(["solo-model"]))
    })
    const { stdout, exitCode } = await runAdapter({
      SHELLQ_LOCAL_OPENAI_MODE: "scan",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: healthy.endpoint,
      SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS: [healthy.endpoint, healthy.endpoint, "http://localhost:9/v1", "nonsense"].join(" "),
      SHELLQ_LOCAL_OPENAI_TEST_SCAN_ABSOLUTE_MS: "500",
      SHELLQ_LOCAL_OPENAI_TEST_DISCOVERY_CONNECT_MS: "200",
    })
    expect(exitCode).toBe(0)
    expect(healthy.hits).toHaveLength(1)
    expect(parseLocalScan(stdout, [healthy.endpoint])?.get(healthy.endpoint)).toEqual(["solo-model"])
  })

  test("with no catalog anywhere, the effective endpoint's fixed failure is the exit", async () => {
    const failing = await startFixture((_req, res) => {
      res.writeHead(503)
      res.end("private server body")
    })
    const healthy = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(catalogBody(["other-model"]))
    })
    const quietA = await closedPort()
    const quietB = await closedPort()
    const run = (endpoints: string[]) => runAdapter({
      SHELLQ_LOCAL_OPENAI_MODE: "scan",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: endpoints[0],
      SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS: endpoints.join(" "),
      SHELLQ_LOCAL_OPENAI_TEST_SCAN_ABSOLUTE_MS: "800",
      SHELLQ_LOCAL_OPENAI_TEST_DISCOVERY_CONNECT_MS: "300",
    })
    const refused = await run([`http://127.0.0.1:${quietA}/v1`, `http://127.0.0.1:${quietB}/v1`])
    expect(refused.exitCode).toBe(66)
    expect(refused.stdout).toBe("")
    const serverFailed = await run([failing.endpoint, `http://127.0.0.1:${quietA}/v1`])
    expect(serverFailed.exitCode).toBe(73)
    expect(serverFailed.stdout + serverFailed.stderr).not.toContain("private")
    // A healthy common port still answers even when the effective endpoint fails.
    const masked = await run([`http://127.0.0.1:${quietA}/v1`, healthy.endpoint])
    expect(masked.exitCode).toBe(0)
    expect(parseLocalScan(masked.stdout, [`http://127.0.0.1:${quietA}/v1`, healthy.endpoint])?.get(healthy.endpoint)).toEqual(["other-model"])
  })

  test("an empty scan list is INVALID_REQUEST with no output", async () => {
    const { stdout, stderr, exitCode } = await runAdapter({
      SHELLQ_LOCAL_OPENAI_MODE: "scan",
      SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS: "   ",
    })
    expect(exitCode).toBe(64)
    expect(stdout).toBe("")
    expect(stderr).toBe("local-openai: invalid request\n")
  })

  test("two maximum-size catalogs both survive the aggregate output bound", async () => {
    const maxCatalog = Array.from({ length: 512 }, (_, i) => ({ id: String(i).padStart(3, "0") + "x".repeat(125) }))
    const first = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: maxCatalog }))
    })
    const second = await startFixture((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ object: "list", data: maxCatalog }))
    })
    const endpoints = [first.endpoint, second.endpoint]
    const { stdout, exitCode } = await runAdapter({
      SHELLQ_LOCAL_OPENAI_MODE: "scan",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: endpoints[0],
      SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS: endpoints.join(" "),
      SHELLQ_LOCAL_OPENAI_TEST_SCAN_ABSOLUTE_MS: "2_000",
      SHELLQ_LOCAL_OPENAI_TEST_DISCOVERY_CONNECT_MS: "1_000",
    })
    expect(exitCode).toBe(0)
    // Both single-catalog-legal maximum inputs come through whole: the
    // aggregate bound never drops a healthy endpoint's catalog.
    const catalogs = parseLocalScan(stdout, endpoints)
    expect(catalogs).not.toBeNull()
    expect(catalogs!.get(first.endpoint)?.length).toBe(512)
    expect(catalogs!.get(second.endpoint)?.length).toBe(512)
  })
})

// ---------------------------------------------------------------------------
// Parent-side scan revalidation
// ---------------------------------------------------------------------------

describe("parseLocalScan revalidation", () => {
  const a = "http://127.0.0.1:8000/v1"
  const b = "http://127.0.0.1:8081/v1"

  test("admits only requested endpoints with strict ordered catalogs", () => {
    const parsed = parseLocalScan(
      JSON.stringify({ object: "scan", data: [
        { endpoint: a, object: "list", data: [{ id: "m-one" }, { id: "m-two" }] },
        { endpoint: b, object: "list", data: [] },
      ]}),
      [a, b],
    )
    expect(parsed).not.toBeNull()
    expect([...parsed!.entries()]).toEqual([[a, ["m-one", "m-two"]], [b, []]])
  })

  test("failed endpoints are simply absent, never fabricated", () => {
    const parsed = parseLocalScan(JSON.stringify({ object: "scan", data: [] }), [a, b])
    expect(parsed).not.toBeNull()
    expect(parsed!.size).toBe(0)
  })

  test("rejects anything unexpected", () => {
    const entry = (data: unknown) => JSON.stringify({ object: "scan", data })
    for (const hostile of [
      "",
      "not json",
      JSON.stringify({ object: "other", data: [] }),
      entry("nope"),
      entry([{ endpoint: "http://10.0.0.1:9/v1", object: "list", data: [] }]),
      entry([{ endpoint: a, object: "list", data: [] }, { endpoint: a, object: "list", data: [] }]),
      entry([{ endpoint: a, object: "list", data: [{ id: "x" }, { id: "x" }] }]),
      entry([{ endpoint: a, object: "list", data: [{ id: "has space" }] }]),
      entry([{ endpoint: a, object: "list", data: [{ id: 7 }] }]),
      entry([{ endpoint: a, object: "list", data: ["m"] }]),
      entry([{ endpoint: a, object: "other", data: [] }]),
      entry([{ endpoint: a, object: "list", data: Array.from({ length: 513 }, (_, i) => ({ id: `m${i}` })) }]),
    ]) {
      expect(parseLocalScan(hostile, [a, b])).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Probe list gates
// ---------------------------------------------------------------------------

describe("localScanEndpoints", () => {
  const saved: LocalEndpointResolution = { endpoint: "http://127.0.0.1:9999/v1", source: "saved", readOnly: false }

  test("saved/custom endpoint first, then the fixed common loopback ports, deduped", () => {
    expect(localScanEndpoints(saved)).toEqual([
      "http://127.0.0.1:9999/v1",
      ...[...new Set(LOCAL_SCAN_PORTS)].filter((port) => port !== 9999).map((port) => `http://127.0.0.1:${port}/v1`),
    ].slice(0, 8))
    // The default endpoint is one of the common ports: no duplicate probe.
    expect(localScanEndpoints({ endpoint: DEFAULT_LOCAL_ENDPOINT, source: "default", readOnly: false }))
      .toEqual([...new Set([DEFAULT_LOCAL_ENDPOINT, ...LOCAL_SCAN_PORTS.map((port) => `http://127.0.0.1:${port}/v1`)])])
  })

  test("a valid override restricts probes to exactly that endpoint", () => {
    expect(localScanEndpoints({ endpoint: "http://[::1]:4777/v1", source: "environment override", readOnly: true }))
      .toEqual(["http://[::1]:4777/v1"])
  })

  test("an invalid or empty override and unresolved settings block all probing", () => {
    expect(localScanEndpoints({ endpoint: null, source: "environment override", readOnly: true })).toBeNull()
    expect(localScanEndpoints({ endpoint: null, source: "unresolved", readOnly: false })).toBeNull()
  })

  test("TEST-ONLY port pinning keeps focused tests off the real fixed ports", () => {
    const original = process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS
    process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS = "9010,9011"
    try {
      expect(localScanEndpoints(saved)).toEqual([
        "http://127.0.0.1:9999/v1",
        "http://127.0.0.1:9010/v1",
        "http://127.0.0.1:9011/v1",
      ])
    } finally {
      if (original === undefined) delete process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS
      else process.env.SHELLQ_LOCAL_OPENAI_TEST_SCAN_PORTS = original
    }
  })
})

// ---------------------------------------------------------------------------
// Scan adapter environment
// ---------------------------------------------------------------------------

describe("localAdapterEnvironment scan environment", () => {
  test("carries only the allowlisted keys, never the parent's proxy or credentials", () => {
    const parent = {
      PATH: "/usr/bin:/bin",
      HTTP_PROXY: "http://evil:3128",
      OPENAI_API_KEY: "sk-secret",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: "http://127.0.0.1:8000/v1",
    }
    const endpoints = ["http://127.0.0.1:8081/v1", "http://127.0.0.1:1234/v1"]
    const env = localAdapterEnvironment(parent, endpoints[0], { mode: "scan", scanEndpoints: endpoints })
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: "http://127.0.0.1:8081/v1",
      SHELLQ_LOCAL_OPENAI_MODE: "scan",
      SHELLQ_LOCAL_OPENAI_SCAN_ENDPOINTS: endpoints.join(" "),
    })
  })
})

// ---------------------------------------------------------------------------
// Atomic endpoint + inference tuple persistence
// ---------------------------------------------------------------------------

describe("writePersistedLocalSelection", () => {
  const makeEnv = () => {
    const dir = mkdtempSync(join(tmpdir(), "shellq-scan-test-"))
    return { SHELLQ_STATE_DIR: dir } as Record<string, string | undefined>
  }

  afterEach(() => {
    // Each test cleans its own directory; nothing global is touched.
  })

  test("stores endpoint plus exact inference tuple in one document and preserves unrelated entries", () => {
    const env = makeEnv()
    try {
      writePersistedInferenceSettings("codex-model", "low", env, "codex")
      writePersistedLocalSelection("http://127.0.0.1:8081/v1", "fixture-model", "endpoint default", env)
      const document = readPersistedInferenceDocument(env)
      expect(document?.provider).toBe(LOCAL_PROVIDER_ID)
      expect(document?.localEndpoint).toBe("http://127.0.0.1:8081/v1")
      expect(document?.providers[LOCAL_PROVIDER_ID]).toEqual({ model: "fixture-model", reasoning: "endpoint default" })
      // The other provider's entry survives the atomic update untouched.
      expect(document?.providers.codex).toEqual({ model: "codex-model", reasoning: "low" })
    } finally {
      rmSync(env.SHELLQ_STATE_DIR!, { recursive: true, force: true })
    }
  })

  test("an unsafe endpoint or model is rejected before any write", () => {
    const env = makeEnv()
    try {
      writePersistedLocalSelection("http://127.0.0.1:8081/v1", "fixture-model", "endpoint default", env)
      expect(() => writePersistedLocalSelection("http://localhost:9/v1", "fixture-model", "endpoint default", env))
        .toThrow("invalid local selection")
      expect(() => writePersistedLocalSelection("http://127.0.0.1:8081/v1", "bad model; rm -rf /", "endpoint default", env))
        .toThrow("invalid local selection")
      const document = readPersistedInferenceDocument(env)
      expect(document?.localEndpoint).toBe("http://127.0.0.1:8081/v1")
      expect(document?.providers[LOCAL_PROVIDER_ID]).toEqual({ model: "fixture-model", reasoning: "endpoint default" })
    } finally {
      rmSync(env.SHELLQ_STATE_DIR!, { recursive: true, force: true })
    }
  })

  test("malformed settings block the write until deliberately repaired", () => {
    const env = makeEnv()
    const dir = env.SHELLQ_STATE_DIR!
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const path = inferenceSettingsFile(env)
      writeFileSync(path, "{not json", { mode: 0o600 })
      expect(() => writePersistedLocalSelection("http://127.0.0.1:8081/v1", "fixture-model", "endpoint default", env))
        .toThrow("settings need repair")
      expect(readFileSync(path, "utf8")).toBe("{not json")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
