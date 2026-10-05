export type ValidatedEndpoint = {
  raw: string
  host: string
  family: 4 | 6
  port: number
  peerLiteral: string
}

const IPV4_ENDPOINT = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/v1\/?$/u
const IPV6_ENDPOINT = /^http:\/\/\[::1\]:([0-9]{1,5})\/v1\/?$/u
const PORT_GRAMMAR = /^[1-9][0-9]{0,4}$/u

export function parseLocalEndpoint(raw: unknown): ValidatedEndpoint | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256 || /\s/u.test(raw)) {
    return null
  }

  let match = IPV4_ENDPOINT.exec(raw)
  let family: 4 | 6 = 4
  let host = "127.0.0.1"
  let peerLiteral = "127.0.0.1"
  if (!match) {
    match = IPV6_ENDPOINT.exec(raw)
    family = 6
    host = "::1"
    peerLiteral = "::1"
  }
  if (!match) return null

  const portText = match[1]
  if (!PORT_GRAMMAR.test(portText)) return null
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null

  return {
    raw: `http://${family === 4 ? "127.0.0.1" : "[::1]"}:${port}/v1`,
    host,
    family,
    port,
    peerLiteral,
  }
}
