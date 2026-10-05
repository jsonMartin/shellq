export type StructuredPreviewMode = "generate" | "correct"
export type StructuredPreviewEvent = { t: "answer"; text: string }

const MAX_PREVIEW_BYTES = 8 * 1024
const MAX_RAW_BYTES = 128 * 1024
const FIELD_NAMES = new Set(["tldr", "corrected_command"])

type Field = { name: "tldr" | "corrected_command"; index: number; start: number }

class PreviewSanitizer {
  private state: "text" | "escape" | "csi" | "osc" | "osc-escape" = "text"

  push(value: string): string {
    let out = ""
    for (const character of value) {
      if (this.state === "osc") {
        if (character === "\x07") this.state = "text"
        else if (character === "\x1b") this.state = "osc-escape"
      } else if (this.state === "osc-escape") {
        this.state = character === "\\" ? "text" : "osc"
      } else if (this.state === "csi") {
        if (/[@-~]/u.test(character)) this.state = "text"
      } else if (this.state === "escape") {
        this.state = character === "]" ? "osc" : character === "[" ? "csi" : "text"
      } else if (character === "\x1b") this.state = "escape"
      else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(character)) {
        out += /\p{Bidi_Control}/u.test(character)
          ? `\\u{${character.codePointAt(0)!.toString(16)}}`
          : character
      }
    }
    return out
  }
}

function completeStringEnd(raw: string, start: number): number | null {
  for (let index = start; index < raw.length; index += 1) {
    if (raw[index] === "\\") {
      const escaped = raw[index + 1]
      if (escaped === undefined) return null
      if (escaped === "u") {
        if (!/^[0-9a-f]{4}$/iu.test(raw.slice(index + 2, index + 6))) return null
        index += 5
      } else {
        index += 1
      }
    } else if (raw[index] === '"') {
      return index
    }
  }
  return null
}

function fieldsIn(raw: string): Field[] {
  const fields: Field[] = []
  for (let index = 0; index < raw.length;) {
    if (raw[index] !== '"') {
      index += 1
      continue
    }
    const end = completeStringEnd(raw, index + 1)
    if (end === null) break
    let key: unknown
    try { key = JSON.parse(raw.slice(index, end + 1)) } catch { index = end + 1; continue }
    let valueStart = end + 1
    while (/\s/u.test(raw[valueStart] ?? "")) valueStart += 1
    if (typeof key === "string" && FIELD_NAMES.has(key) && raw[valueStart] === ":") {
      valueStart += 1
      while (/\s/u.test(raw[valueStart] ?? "")) valueStart += 1
      if (raw[valueStart] === '"') fields.push({ name: key as Field["name"], index: fields.filter(field => field.name === key).length, start: valueStart + 1 })
    }
    index = end + 1
  }
  return fields
}

function decodePrefix(raw: string, start: number): { text: string } | null {
  let end = start
  for (; end < raw.length; end += 1) {
    if (raw[end] === '"') {
      break
    }
    if (raw.charCodeAt(end) < 0x20) return null
    if (raw[end] !== "\\") continue
    const escaped = raw[end + 1]
    if (escaped === undefined) break
    if (escaped === "u") {
      if (end + 6 > raw.length || !/^[0-9a-f]{4}$/iu.test(raw.slice(end + 2, end + 6))) break
      end += 5
    } else if (/["\\/bfnrt]/u.test(escaped)) {
      end += 1
    } else {
      return null
    }
  }
  const source = raw.slice(start, end)
  let text: string
  try { text = JSON.parse(`"${source}"`) } catch { return null }
  // Do not display a high surrogate until its pair arrives in a later chunk.
  if (/^[\s\S]*[\ud800-\udbff]$/u.test(text)) text = text.slice(0, -1)
  return { text }
}

export class StructuredPreviewProjector {
  private raw = ""
  private decoded = new Map<string, string>()
  private sanitizers = new Map<string, PreviewSanitizer>()
  private seenFields = new Set<string>()
  private seenChoices = new Set<number>()
  private outputBytes = 0
  private overflow = false

  constructor(
    private readonly mode: StructuredPreviewMode,
    private readonly candidateCount: 1 | 2 | 3 | 4 | 5 = 1,
  ) {}

  push(fragment: string): StructuredPreviewEvent[] {
    if (this.overflow) return []
    if (new TextEncoder().encode(this.raw).byteLength + new TextEncoder().encode(fragment).byteLength > MAX_RAW_BYTES) {
      this.raw = ""
      this.decoded.clear()
      this.sanitizers.clear()
      this.overflow = true
      return []
    }
    this.raw += fragment
    // ponytail: bounded O(n²) rescan keeps one tiny scanner shared by all
    // adapters; replace with a cursor only if measured large-stream cost matters.
    const events: StructuredPreviewEvent[] = []
    for (const field of fieldsIn(this.raw)) {
      const key = `${field.name}:${field.index}`
      const decoded = decodePrefix(this.raw, field.start)
      if (!decoded) continue
      const previous = this.decoded.get(key) ?? ""
      const delta = decoded.text.slice(previous.length)
      this.decoded.set(key, decoded.text)
      if (!delta) continue
      const sanitizer = this.sanitizers.get(key) ?? new PreviewSanitizer()
      this.sanitizers.set(key, sanitizer)
      const safeDelta = sanitizer.push(delta)
      if (!safeDelta) continue
      const remaining = MAX_PREVIEW_BYTES - this.outputBytes
      if (remaining <= 0) return events
      const firstField = !this.seenFields.has(key)
      const firstChoice = !this.seenChoices.has(field.index)
      const label = this.candidateCount > 1
        ? firstChoice
          ? `${field.index === 0 ? "" : "\n"}Choice ${field.index + 1}\n${field.name === "tldr" ? "Explanation: " : "Command: "}`
          : `\n${field.name === "tldr" ? "Explanation: " : "Command: "}`
        : `${this.seenFields.size ? "\n" : ""}${field.name === "tldr" ? "Explanation: " : "Command: "}`
      const prefix = firstField ? label : ""
      this.seenFields.add(key)
      this.seenChoices.add(field.index)
      const text = `${prefix}${safeDelta}`
      let bounded = ""
      let bytes = 0
      for (const character of text) {
        const size = new TextEncoder().encode(character).byteLength
        if (bytes + size > remaining) break
        bounded += character
        bytes += size
      }
      this.outputBytes += bytes
      if (bounded) events.push({ t: "answer", text: bounded })
    }
    return events
  }
}
