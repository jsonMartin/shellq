// Hand-framed wire fixtures on a plain TCP server.
//
// Bun 1.3's node:http polyfill swallows raw `req.socket.write/end` bytes made
// from inside a request handler (fixed in 1.4), so fixtures that answer with
// hand-framed HTTP run on a bare `node:net` server behind minimal request and
// response shims. The shims expose exactly the node:http surface those
// handlers use — `method`, `url`, `headers`, `socket`, `on("data"/"end")`,
// `writeHead`, `write`, `end`, `writableEnded`, and `on("close")` — keeping
// every handler body identical across Bun versions.
import { createServer as createTcpServer, type Socket } from "node:net"
import type { IncomingMessage, ServerResponse } from "node:http"

export type RawTcpHandler = (req: IncomingMessage, res: ServerResponse) => void

export type RawTcpFixture = {
  port: number
  // Live client sockets, for force-closing held connections on fixture close.
  sockets: Set<Socket>
  close: () => Promise<void>
}

const REASONS: Record<number, string> = {
  200: "OK",
  204: "No Content",
  302: "Found",
  307: "Temporary Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
}

type RequestState = {
  listeners: Array<{ event: string; fn: (chunk?: Buffer) => void }>
  bodyLeft: number
  delivered: boolean
}

export const startRawTcpFixture = (handler: RawTcpHandler): Promise<RawTcpFixture> =>
  new Promise((resolve) => {
    const sockets = new Set<Socket>()
    // One request per connection: the adapter opens a fresh connection per
    // request, and several fixtures deliberately never answer, so nothing
    // here can wait for a second request.
    const server = createTcpServer((socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
      // Held fixtures may answer after the client hung up; node:http absorbed
      // those late writes, so a bare socket must swallow EPIPE the same way.
      socket.on("error", () => {})
      let headBuf = Buffer.alloc(0)
      let state: RequestState | null = null
      const deliver = (chunk: Buffer) => {
        if (!state) return
        // Handlers register body listeners synchronously during the handler
        // call, so buffered body bytes and `end` are delivered after it
        // returns, in arrival order.
        if (state.bodyLeft > 0) {
          const take = chunk.subarray(0, state.bodyLeft)
          state.bodyLeft -= take.byteLength
          for (const { event, fn } of state.listeners) if (event === "data") fn(take)
        }
        if (state.bodyLeft <= 0 && !state.delivered) {
          state.delivered = true
          for (const { event, fn } of state.listeners) if (event === "end") fn()
        }
      }
      socket.on("data", (chunk: Buffer) => {
        if (state) return deliver(chunk)
        headBuf = Buffer.concat([headBuf, chunk])
        const headEnd = headBuf.indexOf("\r\n\r\n")
        if (headEnd < 0) return
        const head = headBuf.slice(0, headEnd).toString("latin1").split("\r\n")
        const [method = "", url = ""] = (head[0] ?? "").split(" ")
        const headers: Record<string, string> = {}
        for (const line of head.slice(1)) {
          const colon = line.indexOf(":")
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        const listeners: RequestState["listeners"] = []
        state = {
          listeners,
          bodyLeft: Number.parseInt(headers["content-length"] ?? "0", 10) || 0,
          delivered: false,
        }
        const closeListeners: Array<() => void> = []
        socket.on("close", () => {
          for (const fn of closeListeners) fn()
        })
        let status = 200
        let resHeaders: Record<string, string> = {}
        let headerWritten = false
        let chunked = false
        let ended = false
        const flushHeaders = () => {
          if (headerWritten || socket.destroyed || socket.writableEnded) return
          headerWritten = true
          const names = Object.keys(resHeaders).map((n) => n.toLowerCase())
          chunked = !names.includes("content-length") && !names.includes("transfer-encoding")
          if (chunked) resHeaders["Transfer-Encoding"] = "chunked"
          const block = Object.entries(resHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")
          socket.write(`HTTP/1.1 ${status} ${REASONS[status] ?? "Response"}\r\n${block}\r\n\r\n`)
        }
        const res = {
          get writableEnded() {
            return ended
          },
          socket,
          writeHead(s: number, h: Record<string, string> = {}) {
            status = s
            resHeaders = { ...h }
          },
          write(c: string | Buffer) {
            if (socket.destroyed || socket.writableEnded) return
            flushHeaders()
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c)
            if (chunked) socket.write(`${buf.byteLength.toString(16)}\r\n`)
            socket.write(buf)
            if (chunked) socket.write("\r\n")
          },
          end(b?: string | Buffer) {
            if (ended) return
            ended = true
            if (socket.destroyed || socket.writableEnded) return
            if (b !== undefined) res.write(b)
            flushHeaders()
            if (chunked) socket.write("0\r\n\r\n")
            socket.end()
          },
          on(event: string, fn: () => void) {
            if (event === "close") closeListeners.push(fn)
          },
        }
        handler(
          {
            method,
            url,
            headers,
            socket,
            on: (event: string, fn: (chunk?: Buffer) => void) => listeners.push({ event, fn }),
          } as unknown as IncomingMessage,
          res as unknown as ServerResponse,
        )
        if (headBuf.length > headEnd + 4) deliver(headBuf.slice(headEnd + 4))
        headBuf = Buffer.alloc(0)
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("no port")
      resolve({
        port: address.port,
        sockets,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            for (const socket of sockets) socket.destroy()
          }),
      })
    })
  })
