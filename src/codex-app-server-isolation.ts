import {
  chmodSync,
  lstatSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { resolveStateRoot } from "./workbench"

export type AppServerMode = "ask" | "command" | "fix"

export class AppServerIsolationFailure extends Error {
  constructor(
    readonly code: 64 | 66 | 70,
    message: string,
  ) {
    super(message)
  }
}

const ALLOWED_ENV = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SYSTEMROOT",
  "WINDIR",
] as const

const PRIVATE_CONFIG = 'cli_auth_credentials_store = "file"\nproject_doc_max_bytes = 0\n'
const FEATURE_NAMES = [
  "plugins",
  "apps",
  "hooks",
  "memories",
  "multi_agent",
  "browser_use",
  "computer_use",
  "image_generation",
  "skill_search",
] as const

function fail(code: 64 | 66 | 70, message: string): never {
  throw new AppServerIsolationFailure(code, message)
}

function privateDirectory(path: string, create = true): void {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const item = lstatSync(path)
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) !== 0) {
    fail(66, "ShellQ Codex state is not a private directory")
  }
  if (typeof process.getuid === "function" && item.uid !== process.getuid()) {
    fail(66, "ShellQ Codex state is not owned by the current user")
  }
  chmodSync(path, 0o700)
}

function sourceAuthPath(env: Readonly<Record<string, string | undefined>>): string {
  if (env.CODEX_HOME !== undefined && !env.CODEX_HOME.startsWith("/")) fail(70, "Codex home must be absolute")
  const home = env.CODEX_HOME?.startsWith("/")
    ? env.CODEX_HOME
    : join(env.HOME?.startsWith("/") ? env.HOME : homedir(), ".codex")
  for (const config of ["/etc/codex/config.toml", join(home, "config.toml")]) {
  try {
    if (statSync(config).size > 64 * 1024) fail(70, "Codex authentication configuration is too large")
    const text = readFileSync(config, "utf8")
    if (Buffer.byteLength(text) > 64 * 1024) fail(70, "Codex authentication configuration is too large")
    const parsed = Bun.TOML.parse(text) as Record<string, unknown>
    if (parsed.profile !== undefined || env.CODEX_PROFILE !== undefined) fail(70, "Codex authentication profile selection is unsupported; use the default file login")
    const selector = parsed.cli_auth_credentials_store
    if (selector !== undefined && selector !== "file") {
      fail(70, "Codex authentication storage is unsupported; select file authentication")
    }
  } catch (error) {
    if (error instanceof AppServerIsolationFailure) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(70, "Codex authentication configuration is unsupported")
    }
  }
  }
  const auth = join(home, "auth.json")
  try {
    const item = lstatSync(auth)
    if (!item.isFile() || item.isSymbolicLink() || (typeof process.getuid === "function" && item.uid !== process.getuid())) fail(70, "Codex file authentication is unavailable")
  } catch {
    fail(70, "Codex file authentication is unavailable")
  }
  return auth
}

function ensurePrivateConfig(home: string): string {
  privateDirectory(home)
  const config = join(home, "config.toml")
  try {
    const item = lstatSync(config)
    if (!item.isFile() || item.isSymbolicLink() || (item.mode & 0o077) !== 0 || (typeof process.getuid === "function" && item.uid !== process.getuid()) || item.size !== Buffer.byteLength(PRIVATE_CONFIG) || readFileSync(config, "utf8") !== PRIVATE_CONFIG) {
      fail(66, "ShellQ Codex config conflicts with the owned policy")
    }
  } catch (error) {
    if (error instanceof AppServerIsolationFailure) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(66, "ShellQ Codex config is unavailable")
    const temporary = `${config}.${crypto.randomUUID()}`
    writeFileSync(temporary, PRIVATE_CONFIG, { flag: "wx", mode: 0o600 })
    try {
      try { linkSync(temporary, config) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    } finally { unlinkSync(temporary) }
    return ensurePrivateConfig(home)
  }
  return config
}

function ensureAuthLink(home: string, source: string): void {
  const target = realpathSync(source)
  const destination = join(home, "auth.json")
  try {
    const item = lstatSync(destination)
    if (!item.isSymbolicLink() || resolve(dirname(destination), readlinkSync(destination)) !== target) {
      fail(66, "ShellQ Codex authentication link conflicts with the native login")
    }
    return
  } catch (error) {
    if (error instanceof AppServerIsolationFailure) throw error
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(66, "ShellQ Codex authentication link is unavailable")
  }
  try { symlinkSync(target, destination, "file") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    ensureAuthLink(home, source)
  }
}

export type AppServerLaunch = {
  env: Record<string, string>
  home: string
  config: string
  ephemeralCwd: string
  cleanup: () => void
}

export function prepareAppServerLaunch(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppServerLaunch {
  const source = sourceAuthPath(env)
  const declaredHome = join(resolveStateRoot(env), "codex-home")
  privateDirectory(declaredHome)
  // Codex reports resolved paths, so a state root behind a symlink (macOS
  // /var -> /private/var, stow-managed ~/.local) must use them too.
  const home = realpathSync(declaredHome)
  const config = ensurePrivateConfig(home)
  ensureAuthLink(home, source)
  const ephemeralCwd = join(home, "empty")
  privateDirectory(ephemeralCwd)
  if (readdirSync(ephemeralCwd).length) fail(66, "ShellQ ephemeral directory must be empty")
  const childEnv: Record<string, string> = {}
  for (const key of ALLOWED_ENV) {
    const value = env[key]
    if (value !== undefined) childEnv[key] = value
  }
  childEnv.CODEX_HOME = home
  return {
    env: childEnv,
    home,
    config,
    ephemeralCwd,
    cleanup: () => {},
  }
}

export function appServerConfig(
  mode: AppServerMode,
  effort: string,
  skillPaths: string[],
): Record<string, unknown> {
  const features: Record<string, boolean> = Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, false]),
  )
  features.shell_tool = mode === "ask"
  features.unified_exec = mode === "ask"
  return {
    model_reasoning_effort: effort,
    project_doc_max_bytes: 0,
    features,
    tools: { view_image: false, web_search: false },
    web_search: "disabled",
    agents: { enabled: false },
    skills: { config: skillPaths.map((path) => ({ path, enabled: false })) },
  }
}

export function validateConfigRead(
  result: unknown,
  cwd: string,
  privateConfig: string,
): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) fail(66, "Codex configuration receipt is malformed")
  const layers = (result as Record<string, unknown>).layers
  if (!Array.isArray(layers)) fail(66, "Codex configuration layers are unavailable")
  let users = 0
  for (const layer of layers) {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) fail(66, "Codex configuration layer is malformed")
    const item = layer as Record<string, any>
    const name = item.name
    if (!name || typeof name !== "object" || Array.isArray(name)) fail(66, "Codex configuration layer is malformed")
    if (name.type === "project") {
      if (typeof item.disabledReason !== "string" || !item.disabledReason) fail(66, "project configuration is active")
    } else if (name.type === "user") {
      users++
      if (name.file !== privateConfig || name.profile !== null || item.disabledReason != null) fail(66, "unexpected Codex user configuration")
    }
    if (!["project", "user", "system", "sessionFlags", "mdm", "managedRequirements"].includes(name.type)) fail(66, "unexpected Codex configuration layer")

  }
  if (users !== 1) fail(66, "private Codex configuration is unavailable")
  const config = (result as Record<string, any>).config
  if (!config || typeof config !== "object" || Array.isArray(config)) fail(66, "effective Codex configuration is unavailable")
  if (config.profile != null) fail(66, "unexpected Codex profile")
  if (config.cli_auth_credentials_store !== undefined && config.cli_auth_credentials_store !== "file") fail(70, "Codex authentication storage is unsupported; select file authentication")
  const servers = config.mcp_servers
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) fail(66, "invalid MCP configuration")
  for (const server of Object.values(servers ?? {})) {
    if (!server || typeof server !== "object" || (server as Record<string, unknown>).enabled !== false) fail(66, "enabled MCP configuration is incompatible with ShellQ")
  }
}

export const APP_SERVER_BASE_INSTRUCTIONS = "You are ShellQ, a concise terminal assistant. Follow the supplied mode and request."
export const APP_SERVER_ASK_INSTRUCTIONS = "Answer directly. Use the native read-only shell inspection tool to inspect files in the selected working directory when needed. Never modify files, use the network, call external tools, or execute generated answer text."

export function extractSkillPaths(result: unknown, cwd: string): string[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) fail(66, "Codex skills receipt is malformed")
  const data = (result as Record<string, unknown>).data
  if (!Array.isArray(data)) fail(66, "Codex skills receipt is malformed")
  const entry = data.find((value) => value && typeof value === "object" && (value as Record<string, unknown>).cwd === cwd) as Record<string, any> | undefined
  if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length !== 0) fail(66, "Codex skills discovery is unavailable")
  const paths: string[] = []
  for (const skill of entry.skills) {
    if (!skill || typeof skill !== "object" || typeof skill.path !== "string" || !skill.path.startsWith("/") || paths.includes(skill.path)) fail(66, "Codex skills discovery is malformed")
    paths.push(skill.path)
  }
  return paths
}

export function validateInstructionSources(result: Record<string, any>): void {
  if (!Array.isArray(result.instructionSources) || result.instructionSources.length !== 0) {
    fail(66, "Codex instruction sources are not empty")
  }
}
