import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { BoxRenderable, type BorderCharacters } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import {
  applyPersistedInferenceSettings,
  ASK_ANSWER_MAX_BYTES,
  ASK_PREVIEW_INPUT_MAX_BYTES,
  ASK_QUERY_MAX_BYTES,
  ASK_TURN_LIMIT,
  BUNDLED_CODEX_APP_SERVER_PROVIDER,
  BUNDLED_CODEX_PROVIDER,
  BUNDLED_CLAUDE_PROVIDER,
  BUNDLED_DEFAULT_PROVIDER,
  CANDIDATE_LIMIT,
  CANDIDATE_MARKER_WIDTH,
  ASK_STREAM_MAX_FOOTER_HEIGHT,
  COMPACT_FOOTER_HEIGHT,
  CONTEXT_PREVIEW_LABEL,
  CONTEXT_PREVIEW_MAX_ROWS,
  DEFAULT_FOOTER_MAX_ROWS,
  DETAILS_FOOTER_HEIGHT,
  FOOTER_MAX_ROWS_OPTIONS,
  INFERENCE_SETTINGS_MAX_BYTES,
  INFERENCE_SETTINGS_LOCK,
  LOCAL_DISCOVERY_MAX_BYTES,
  RESPONSE_MAX_BYTES,
  INTERIOR_ORIGIN_X,
  READER_FOOTER_HEIGHT,
  TITLE_ORIGIN_X,
  actionsSheetLines,
  appServerFailureMessage,
  appServerCandidateFile,
  appServerPointerDecision,
  appendAskPreview,
  askConversationRows,
  retainedPreviewOffset,
  appendAskTurn,
  appendCandidate,
  answerIsValid,
  askChatWasSaved,
  askProviderArgv,
  bottomRail,
  bottomRailLine,
  buildUniversalPaletteSources,
  captureDoctorRows,
  buildAskRequest,
  buildProviderRequest,
  candidateRowMarker,
  codexAskSessionEnvironment,
  codexSessionFile,
  commandIsValid,
  commandLines,
  composerText,
  contextPreview,
  contextPreviewVisible,
  contextualAction,
  ctrlXAction,
  emptyAskConversation,
  explicitModelCatalog,
  finalizeAskSessionPointer,
  formatBytes,
  frameLayout,
  fuzzySettingsCandidates,
  inferenceSettingsFile,
  isEditingMode,
  isBundledCodexProvider,
  localAdapterEnvironment,
  parseResponseMetrics,
  responseSummary,
  DEFAULT_LOCAL_ENDPOINT,
  resolveLocalEndpoint,
  writePersistedLocalEndpoint,
  writePersistedLocalThinking,
  writePersistedMetricsExpanded,
  writePersistedMaxFooterRows,
  writePersistedInitialChoices,
  LOCAL_PROVIDER_ID,
  parseLocalCatalog,
  adapterPath,
  providerAvailability,
  providerSetupLines,
  providerRegistry,
  prepareProviderSession,
  PROVIDER_POINTER_MAX_BYTES,
  providerPointerDecision,
  resolveProviderId,
  metadataItems,
  metadataWindow,
  modeTabs,
  modeTabsLine,
  normalizeSettingsQuery,
  outputState,
  parseAskResponse,
  POINTER_REACHABLE_ACTIONS,
  parseProviderResponse,
  parseProviderResponses,
  queryIsValid,
  railCwd,
  railGlyphs,
  readAskStream,
  readBounded,
  readPersistedInferenceDocumentState,
  readPersistedInferenceDocument,
  readPersistedInferenceSettings,
  requestOutcome,
  requestedFooterHeight,
  responseIsValid,
  sanitizeContext,
  saveContextDraft,
  selectedCommandLines,
  settingsPickerCandidates,
  settingsPaletteSources,
  settingsPaletteRestoredIndex,
  settingsPickerWindow,
  validateCodexModelPages,
  sliceCells,
  switchAskEngine,
  steppedAskFooterHeight,
  steppedConversationOffset,
  tailUtf8,
  terminalLiteral,
  terminalWidth,
  universalPaletteStatus,
  topRail,
  topRailLine,
  transmissionLabel,
  truncateCells,
  validateTrustedWorkdir,
  verdict,
  visibleShellText,
  wrappedTextLines,
  writePersistedInferenceSettings,
  type ActionsSheetAction,
  type BottomRailState,
  type Density,
  type SessionIntent,
  type TopRailState,
  type ProviderResponse,
  type WorkbenchSession,
} from "../src/workbench"
import { isNoUnicode } from "../src/components/ui/theme-provider"
// railCwd renders home-relative against the real homedir, so cwd fixtures
// that must display as ~/Projects/shellq sit under the actual home.
const HOME_CWD = join(homedir(), "Projects", "shellq")


const SUPPORTED_WIDTHS = [80, 100, 140]

const candidate = (command: string): ProviderResponse => ({
  tldr: "safe suggestion",
  corrected_command: command,
  confidence: 0.9,
  risk: "low",
})

const session = {
  initial_intent: "generate" as const,
  requests: {
    ask: {
      mode: "ask",
      instructions: "Return Ask JSON.",
      input: {
        query: "",
        environment: {
          cwd: "/tmp",
          shell: "zsh",
          platform: "darwin",
        },
        captured_output: "",
      },
    },
    generate: {
      mode: "generate",
      instructions: "Return JSON.",
      input: {
        command: "list files",
        captured_output: "",
        captured_output_correlated_to_command: false,
      },
    },
    correct: {
      mode: "correct",
      instructions: "Return correction JSON.",
      input: {
        command: "pwd",
        captured_output: "",
        captured_output_correlated_to_command: false,
      },
    },
  },
  provider: ["/bin/true"],
  codex_ask_engine: null,
  model: "gpt-5.3-codex-spark",
  reasoning: "low",
  models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
  reasoning_levels: ["low", "medium", "high"],
  context: {
    text: "prior output",
    source: "herdr" as const,
    label: "matched command" as const,
    correlated: true,
    included: false,
  },
  actionable_failure: true,
  last_command: {
    command: "pwd",
    cwd: "/tmp",
    exit_status: 0,
    pipeline_statuses: [0],
  },
}

describe("workbench trust boundaries", () => {
  test("builds one bounded typed inventory with complete destinations", () => {
    const sources = buildUniversalPaletteSources({
      availableProviders: [
        {
          id: "claude",
          models: ["claude-sonnet-5"],
          reasoningLevels: ["low"],
          selectable: true,
        },
        {
          id: "codex",
          models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
          reasoningLevels: ["low", "high"],
          selectable: true,
        },
      ],
      anotherAvailable: true,
      doctorAvailable: true,
      codexEngine: "exec",
      codexEngineAvailable: true,
      engine: null,
      model: "claude-sonnet-5",
      providerId: "claude",
      providerSource: "default",
      reasoning: "low",
    })
    // 8 provider/model/effort/engine destinations, the 5 global Initial
    // choices rows, and the 3 global Max height rows (spec: five root
    // parents; global initial choice count; global maximum frame height).
    expect(sources.filter((source) => source.kind === "set")).toHaveLength(16)
    expect(sources.filter((source) => source.authorityKey === "initial-choices"))
      .toHaveLength(5)
    expect(sources.filter((source) => source.field === "reasoning").map((source) => source.label))
      .toEqual(["Claude/low"])
    expect(sources.filter((source) => source.label === "Codex/Luna")).toHaveLength(1)
    expect(sources.map((source) => source.label)).not.toContain("private-effort")
    expect(sources.filter((source) => source.kind === "open").map((source) => source.label)).toEqual([
      "Ask",
      "Command",
      "Fix",
      "Context",
      "Doctor",
      "Details",
      "Provider Setup",
      "Configure local endpoint",
    ])
    expect(sources.find((source) => source.action === "guard-another")).toMatchObject({
      kind: "guard",
      field: "action",
      label: "Another suggestion",
    })
    expect(sources.filter((source) => source.kind === "n-a").map((source) => source.label)).toEqual([
      "Save edit",
    ])
    expect(fuzzySettingsCandidates("lun", sources)[0]).toMatchObject({
      kind: "set",
      label: "Codex/Luna",
      identity: {
        authorityKey: "codex",
        sourceIndex: 1,
        value: "gpt-5.6-luna",
      },
      destination: {
        providerId: "codex",
        model: "gpt-5.6-luna",
        reasoning: "low",
        engine: "exec",
      },
    })
    expect(fuzzySettingsCandidates("codex spark", sources)[0]).toMatchObject({
      label: "Codex/Spark",
      destination: {
        providerId: "codex",
        model: "gpt-5.3-codex-spark",
        reasoning: "low",
        engine: "exec",
      },
    })
    expect(new Set(sources.map((source) => source.identity.authorityKey + ":" + source.identity.value)).size)
      .toBe(sources.length)
  })

  test("advertises live active siblings before stale persisted settings", () => {
    const base = {
      availableProviders: [
        {
          id: "codex" as const,
          models: ["gpt-5.3-codex-spark", "gpt-5.6-luna"],
          reasoningLevels: ["low", "high"],
          selectable: true,
        },
        {
          id: "claude" as const,
          models: ["claude-sonnet-5"],
          reasoningLevels: ["low", "high"],
          selectable: true,
        },
      ],
      anotherAvailable: false,
      doctorAvailable: false,
      codexEngine: "app-server" as const,
      codexEngineAvailable: true,
      engine: "app-server" as const,
      providerSource: "default" as const,
    }
    const activeCodex = buildUniversalPaletteSources({
      ...base,
      model: "gpt-5.3-codex-spark",
      providerId: "codex",
      reasoning: "high",
      codexLunaReasoning: "low",
      persisted: {
        codex: { model: "gpt-5.6-luna", reasoning: "low" },
      },
    })
    expect(activeCodex.find((source) => source.label === "Codex/Luna")?.destination).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: "high",
    })
    expect(activeCodex.find((source) => source.field === "provider" && source.value === "codex")?.destination)
      .toMatchObject({ model: "gpt-5.3-codex-spark", reasoning: "high" })

    const activeLuna = buildUniversalPaletteSources({
      ...base,
      model: "gpt-5.6-luna",
      providerId: "codex",
      reasoning: "high",
      persisted: {
        codex: { model: "gpt-5.3-codex-spark", reasoning: "low" },
      },
    })
    expect(activeLuna.find((source) => source.field === "reasoning" && source.value === "high")?.destination)
      .toMatchObject({ model: "gpt-5.6-luna", reasoning: "high" })
  })

  test("normalizes picker input without admitting control or bidi bytes", () => {
    expect(normalizeSettingsQuery("  gpt\r\n\t5 \u202e6\u200d ")).toBe(" gpt 5 6 ")
    expect(
      new TextEncoder().encode(normalizeSettingsQuery("x".repeat(ASK_QUERY_MAX_BYTES + 100))).byteLength,
    ).toBe(ASK_QUERY_MAX_BYTES)
  })

  test("keeps configured inventory active-only and opaque", () => {
    const sources = buildUniversalPaletteSources({
      availableProviders: [
        {
          id: "codex",
          models: ["gpt-5.6-luna"],
          reasoningLevels: ["low", "high"],
          selectable: true,
        },
      ],
      configuredModels: ["custom-model", "custom-model-2"],
      configuredReasoningLevels: ["low", "high"],
      doctorAvailable: false,
      anotherAvailable: false,
      engine: null,
      model: "custom-model",
      providerId: null,
      providerSource: "configured",
      reasoning: "low",
    })
    expect(sources.slice(0, 4).map((source) => source.label)).toEqual([
      "custom-model",
      "custom-model-2",
      "Configured/low",
      "Configured/high",
    ])
    expect(sources.filter((source) => source.kind === "open").map((source) => source.label)).toEqual([
      "Ask",
      "Command",
      "Fix",
      "Context",
      "Details",
      "Provider Setup",
      "Configure local endpoint",
    ])
    // Provider-authority sets stay configured-only and opaque; the global
    // Initial choices and Max height rows carry no provider destination
    // (global settings).
    const configuredSets = sources.filter(
      (source) => source.kind === "set" && source.authorityKey !== "initial-choices" &&
        source.authorityKey !== "max-footer-rows",
    )
    expect(configuredSets).toHaveLength(4)
    expect(configuredSets.every((source) => source.destination?.authority.kind === "configured")).toBe(true)
    expect(configuredSets.every((source) => source.destination?.providerId === null)).toBe(true)
    expect(sources.filter((source) => source.authorityKey === "initial-choices"))
      .toHaveLength(5)
    expect(JSON.stringify(sources)).not.toContain("custom-provider")
    expect(JSON.stringify(sources)).not.toContain("argv")
    expect(sources.find((source) => source.value === "custom-model")?.current).toBe(true)
  })

  test("rebuilds safe action inventory from candidate and editor eligibility", () => {
    const base = {
      availableProviders: [
        {
          id: "codex" as const,
          models: ["gpt-5.6-luna"],
          reasoningLevels: ["low"],
          selectable: true,
        },
      ],
      codexEngine: "exec" as const,
      codexEngineAvailable: true,
      engine: "exec" as const,
      model: "gpt-5.6-luna",
      providerId: "codex" as const,
      providerSource: "default" as const,
      reasoning: "low",
      intent: "generate" as const,
      hasCapturedContext: true,
      includeContext: false,
      fixAvailable: true,
      doctorAvailable: false,
    }
    const candidate = buildUniversalPaletteSources({
      ...base,
      anotherAvailable: true,
      hasCandidateList: true,
      editing: false,
    })
    expect(candidate.filter((source) => source.kind === "toggle").map((source) => source.action)).toEqual([
      "toggle-context",
    ])
    expect(candidate.filter((source) => source.kind === "open").map((source) => source.action)).toEqual([
      "mode-ask",
      "mode-command",
      "mode-fix",
      "open-context",
      "open-details",
      "open-candidate-details",
      "open-candidate-edit",
      "open-provider-setup",
      "configure-local-endpoint",
    ])
    expect(candidate.filter((source) => source.kind === "guard").map((source) => source.action)).toEqual([
      "guard-another",
      "guard-insert",
      "guard-new-chat",
    ])
    expect(fuzzySettingsCandidates("ctrl-x p", candidate)[0]).toMatchObject({
      action: "open-provider-setup",
      chord: "Ctrl-X P",
    })

    const editor = buildUniversalPaletteSources({
      ...base,
      anotherAvailable: false,
      hasCandidateList: true,
      editing: true,
    })
    expect(editor.find((source) => source.action === "guard-save")).toMatchObject({
      kind: "guard",
      field: "action",
      effect: "returns to editor · Ctrl-X W saves",
    })
    expect(editor.find((source) => source.action === "guard-insert")).toBeUndefined()
    expect(editor.find((source) => source.action === "mode-ask")).toBeUndefined()
    expect(editor.find((source) => source.action === "toggle-context")).toBeUndefined()
    expect(editor.find((source) => source.action === "guard-new-chat")).toBeUndefined()
    expect(editor.find((source) => source.action === "refusal-new-chat")).toMatchObject({
      kind: "n-a",
      effect: "save or discard the edit first",
    })
  })

  test("keeps known refusals query-only and ranks them after eligible actions", () => {
    const sources = buildUniversalPaletteSources({
      availableProviders: [],
      anotherAvailable: false,
      doctorAvailable: false,
      engine: null,
      model: "configured-model",
      providerId: null,
      providerSource: "configured",
      configuredModels: ["configured-model"],
      configuredReasoningLevels: ["low"],
      reasoning: "low",
      hasCapturedContext: false,
      fixAvailable: false,
      intent: "generate",
    })
    expect(fuzzySettingsCandidates("", sources).some((source) => source.kind === "n-a")).toBe(false)
    expect(fuzzySettingsCandidates("context", sources)[0]).toMatchObject({
      kind: "open",
      action: "open-context",
    })
    expect(sources.find((source) => source.action === "refusal-context")).toBeUndefined()
    expect(fuzzySettingsCandidates("fix", sources)[0]).toMatchObject({
      kind: "n-a",
      action: "refusal-fix",
    })
    expect(fuzzySettingsCandidates("save", sources)[0]).toMatchObject({
      kind: "n-a",
      action: "refusal-save",
    })
    expect(fuzzySettingsCandidates("another", sources)[0]).toMatchObject({
      kind: "n-a",
      action: "refusal-another",
    })
    expect(JSON.stringify(sources)).not.toMatch(/argv|secret|private-effort|\/tmp\//)
  })

  test("ranks exact, prefix, substring, and subsequence model matches deterministically", () => {
    const sources = [
      { field: "model" as const, sourceIndex: 0, value: "gpt-5.6-luna", publicId: "gpt-5.6-luna", display: "Luna", current: false },
      { field: "model" as const, sourceIndex: 1, value: "gpt-5.3-codex-spark", publicId: "gpt-5.3-codex-spark", display: "Spark", current: true },
      { field: "model" as const, sourceIndex: 2, value: "gpt-5.6-lumen", publicId: "gpt-5.6-lumen", display: "Lumen", current: false },
    ]
    expect(fuzzySettingsCandidates("luna", sources).map((item) => item.sourceIndex)).toEqual([0])
    expect(fuzzySettingsCandidates("gpt", sources).map((item) => item.sourceIndex)).toEqual([1, 0, 2])
    expect(fuzzySettingsCandidates("umen", sources).map((item) => item.sourceIndex)).toEqual([2])
    expect(fuzzySettingsCandidates("ln", sources).map((item) => item.sourceIndex)).toEqual([0, 2])
    expect(fuzzySettingsCandidates("", sources).map((item) => item.sourceIndex)).toEqual([1, 0, 2])
    expect(fuzzySettingsCandidates("smlun", sources)[0]?.sourceIndex).toBe(0)
    expect(fuzzySettingsCandidates("set model", sources).map((item) => item.sourceIndex))
      .toEqual([1, 0, 2])
    expect(fuzzySettingsCandidates("lun", sources)[0]?.sourceIndex).toBe(0)
  })

  test("returns complete logical results for the five-row painted window", () => {
    const sources = Array.from({ length: 6 }, (_, sourceIndex) => ({
      field: "model" as const,
      sourceIndex,
      value: `model-${sourceIndex}`,
      publicId: `model-${sourceIndex}`,
      display: `Model ${sourceIndex}`,
      current: sourceIndex === 0,
      kind: "set" as const,
    }))
    const deck = settingsPickerCandidates("", sources)
    expect(deck).toHaveLength(6)
    expect(deck.every((item) => item.kind === "set")).toBe(true)
    expect(settingsPickerCandidates("", sources).map((item) => item.sourceIndex))
      .toEqual([0, 1, 2, 3, 4, 5])
    expect(settingsPickerCandidates("model", sources)).toHaveLength(6)

    const changed = sources.map((source) => ({
      ...source,
      current: source.sourceIndex === 5,
    }))
    const rebuilt = settingsPickerCandidates("", changed)
    expect(rebuilt[0].sourceIndex).toBe(5)
    expect(rebuilt.map((item) => item.sourceIndex)).not.toEqual(
      deck.map((item) => item.sourceIndex),
    )
  })

  test("projects an exact root and complete hierarchical children", () => {
    const leaves = Array.from({ length: 6 }, (_, index) => ({
      field: "model" as const,
      sourceIndex: index,
      value: `model-${index}`,
      display: `Model ${index}`,
      label: `Model ${index}`,
      kind: "set" as const,
      identity: {
        field: "model" as const,
        authorityKey: "codex",
        sourceIndex: index,
        value: `model-${index}`,
      },
      effect: "selects model",
    }))
    const root = settingsPaletteSources(leaves, "root")
    expect(root.map((item) => item.label)).toEqual([
      "Set model",
      "Set effort",
      "Set provider",
      "Initial choices",
      "More settings & actions",
    ])
    expect(settingsPaletteSources(leaves, "model")).toHaveLength(6)
    expect(settingsPickerWindow(settingsPaletteSources(leaves, "model"), 5)).toHaveLength(5)
    expect(settingsPaletteSources(leaves, "root", "lun").some((item) => item.value === "palette-model")).toBe(true)
  })

  test("validates dynamic Codex capabilities and keeps Luna model-specific efforts", () => {
    const models = validateCodexModelPages([
      {
        id: "gpt-5.6-sol",
        model: "gpt-5.6-sol",
        displayName: "Sol",
        description: "Codex Sol",
        supportedReasoningEfforts: ["low", "high", "ultra"],
        defaultReasoningEffort: "high",
        isDefault: true,
      },
      {
        id: "gpt-5.6-luna",
        model: "gpt-5.6-luna",
        displayName: "Luna",
        description: "Codex Luna",
        supportedReasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        isDefault: false,
      },
      { hidden: true },
    ])
    expect(models[0].efforts).toContain("ultra")
    expect(models[1].efforts).not.toContain("ultra")
    expect(() => validateCodexModelPages([
      { ...models[0], supportedReasoningEfforts: ["bogus"], defaultReasoningEffort: "bogus" },
    ])).toThrow()
  })

  test("uses the authoritative catalog for provider and exact-model effort leaves", () => {
    const base = {
      availableProviders: [
        { id: "codex" as const, models: ["gpt-5.6-luna"], reasoningLevels: ["low"], selectable: true },
        { id: "claude" as const, models: ["claude-sonnet-5"], reasoningLevels: ["low", "max"], selectable: true },
      ],
      anotherAvailable: false,
      codexEngine: "app-server" as const,
      codexEngineAvailable: true,
      doctorAvailable: false,
      engine: "app-server" as const,
      model: "gpt-5.6-sol",
      providerId: "codex" as const,
      providerSource: "default" as const,
      reasoning: "ultra",
    }
    const codexCatalog = {
      providerId: "codex" as const,
      source: "codex-model-list" as const,
      models: [
        {
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "Sol",
          description: "Sol",
          efforts: ["low", "ultra"],
          defaultEffort: "low",
          isDefault: true,
        },
        {
          id: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          displayName: "Luna",
          description: "Luna",
          efforts: ["low", "high"],
          defaultEffort: "low",
          isDefault: false,
        },
      ],
    }
    const solSources = buildUniversalPaletteSources({ ...base, codexCatalog })
    const codexProvider = solSources.find((source) => source.field === "provider" && source.value === "codex")
    expect(codexProvider?.sourceIndex).toBe(0)
    expect(codexProvider?.destination?.model).toBe("gpt-5.6-sol")
    const solEfforts = solSources.filter((source) => source.field === "reasoning")
    expect(solEfforts.map((source) => source.value)).toEqual(["low", "ultra"])
    expect(solEfforts.every((source) =>
      source.destination?.model === "gpt-5.6-sol" &&
      source.destination.reasoning === source.value
    )).toBe(true)

    const lunaSources = buildUniversalPaletteSources({
      ...base,
      codexCatalog,
      model: "gpt-5.6-luna",
      reasoning: "high",
    })
    expect(lunaSources.filter((source) => source.field === "reasoning").map((source) => source.value))
      .toEqual(["low", "high"])

    const unknownSources = buildUniversalPaletteSources({
      ...base,
      codexCatalog,
      model: "gpt-unknown",
      reasoning: "high",
    })
    expect(unknownSources.filter((source) => source.field === "reasoning")).toEqual([])

    const emptySources = buildUniversalPaletteSources({
      ...base,
      codexCatalog: { ...codexCatalog, models: [] },
    })
    expect(emptySources.some((source) =>
      source.authorityKey === "codex" && source.field !== "engine"
    )).toBe(false)
    const provisionalEngines = emptySources.filter((source) => source.field === "engine")
    expect(provisionalEngines).toHaveLength(2)
    expect(provisionalEngines.every((source) =>
      source.destination?.model === "gpt-5.6-sol" && source.destination.reasoning === "ultra"
    )).toBe(true)
    expect(settingsPaletteSources(emptySources, "more").some((source) => source.paletteView === "engine"))
      .toBe(true)

    const namedCatalog = {
      ...codexCatalog,
      models: [{
        id: "gpt-x",
        model: "gpt-x",
        displayName: "Research Mini",
        description: "Research model",
        efforts: ["low"],
        defaultEffort: "low",
        isDefault: true,
      }],
    }
    const namedSources = buildUniversalPaletteSources({
      ...base,
      codexCatalog: namedCatalog,
      model: "gpt-x",
      reasoning: "low",
    })
    expect(namedSources.find((source) => source.field === "model")).toMatchObject({
      label: "Codex/Research Mini",
      publicId: "gpt-x",
      value: "gpt-x",
      destination: { model: "gpt-x" },
    })
    expect(fuzzySettingsCandidates("research mini", namedSources)[0]?.value).toBe("gpt-x")
    expect(fuzzySettingsCandidates("gpt-x", namedSources)[0]?.value).toBe("gpt-x")
  })

  test("keeps Set engine under More without expanding the bare root", () => {
    const sources = buildUniversalPaletteSources({
      availableProviders: [
        { id: "codex", models: ["gpt-5.6-luna"], reasoningLevels: ["low"], selectable: true },
      ],
      anotherAvailable: false,
      codexEngine: "app-server",
      codexEngineAvailable: true,
      doctorAvailable: false,
      engine: "app-server",
      model: "gpt-5.6-luna",
      providerId: "codex",
      providerSource: "default",
      reasoning: "low",
    })
    expect(settingsPaletteSources(sources, "root")).toHaveLength(5)
    expect(settingsPaletteSources(sources, "more")[0]).toMatchObject({
      label: "Set engine",
      paletteView: "engine",
    })
    expect(settingsPaletteSources(sources, "root", "set engine").some((source) =>
      source.paletteView === "engine"
    )).toBe(true)
  })

  test("restores discovery focus only by stable identity", () => {
    const before = settingsPaletteSources(buildUniversalPaletteSources({
      availableProviders: [
        { id: "codex", models: ["gpt-5.6-luna", "gpt-5.3-codex-spark"], reasoningLevels: ["low"], selectable: true },
      ],
      anotherAvailable: false,
      doctorAvailable: false,
      engine: "app-server",
      model: "gpt-5.6-luna",
      providerId: "codex",
      providerSource: "default",
      reasoning: "low",
    }), "model")
    const focused = before.find((source) => source.value === "gpt-5.3-codex-spark")
    const reordered = [before[0], ...before.slice(1).reverse()]
    expect(reordered[settingsPaletteRestoredIndex(focused, reordered)]?.value)
      .toBe("gpt-5.3-codex-spark")
    expect(settingsPaletteRestoredIndex(focused, reordered.filter((source) => source !== focused)))
      .toBe(0)
  })

  test("keeps palette footer instructions concise inside every supported cell width", () => {
    const guard = {
      kind: "guard" as const,
      current: false,
    }
    const refusal = {
      kind: "n-a" as const,
      current: false,
    }
    const currentModel = {
      kind: "set" as const,
      current: true,
      field: "model" as const,
    }
    const currentEffort = {
      kind: "set" as const,
      current: true,
      field: "reasoning" as const,
    }
    const toggle = {
      kind: "toggle" as const,
      current: false,
    }
    for (const width of [80, 100, 140]) {
      for (const unicode of [true, false]) {
        const interior = frameLayout(width).interior
        const rows = [
          universalPaletteStatus(undefined, false, "", interior, unicode),
          universalPaletteStatus(currentModel, false, "", interior, unicode),
          universalPaletteStatus(currentEffort, false, "", interior, unicode),
          universalPaletteStatus(undefined, true, "", interior, unicode),
          universalPaletteStatus(guard, false, "", interior, unicode),
          universalPaletteStatus(refusal, false, "", interior, unicode),
          universalPaletteStatus(undefined, false, "no matching palette records", interior, unicode),
        ]
        for (const row of rows) {
          expect(terminalWidth(row)).toBeLessThanOrEqual(interior)
          if (!unicode) expect(row).not.toMatch(/[^\x00-\x7f]/u)
        }
        expect(rows[0]).toBe(`Esc back`)
        expect(rows[1]).toBe(unicode ? "Enter effort · Esc back" : "Enter effort / Esc back")
        expect(rows[2]).toBe(unicode ? "Enter done · Esc back" : "Enter done / Esc back")
        expect(rows[3]).toBe("")
        expect(rows[4]).toBe(unicode ? "Enter open · Esc back" : "Enter open / Esc back")
        expect(rows[5]).toBe("Esc back")
        expect(universalPaletteStatus(toggle, false, "output attached", interior, unicode))
          .toBe(unicode ? "Enter toggle · Esc back" : "Enter toggle / Esc back")
        expect(rows.join("\n")).not.toMatch(/Already current|Ctrl-X|→|->|\[set\]/u)
      }
    }
  })

  test("keeps exact source identity separate from filtered position", () => {
    const results = fuzzySettingsCandidates("spark", [
      { field: "model", sourceIndex: 4, value: "gpt-5.3-codex-spark", display: "Spark" },
    ])
    expect(results[0]).toMatchObject({ sourceIndex: 4, value: "gpt-5.3-codex-spark" })
  })

  test("shows only the action for a focused non-current set", () => {
    const status = universalPaletteStatus(
      {
        kind: "set",
        current: false,
        field: "model",
      },
      false,
      "",
      frameLayout(80).interior,
      false,
    )
    expect(status).toBe("Enter apply / Esc back")
  })

  test("ranks mixed settings by stable field order and ignores private value fallback", () => {
    const sources = [
      { field: "reasoning" as const, sourceIndex: 3, value: "private-effort", publicId: "high", display: "setting" },
      { field: "model" as const, sourceIndex: 2, value: "gpt-model", publicId: "gpt-model", display: "setting" },
      { field: "engine" as const, sourceIndex: 1, value: "app-server", publicId: "app-server", display: "setting" },
      { field: "provider" as const, sourceIndex: 0, value: "codex", publicId: "codex", display: "setting" },
    ]
    expect(fuzzySettingsCandidates("setting", sources).map((item) => item.field)).toEqual([
      "provider",
      "engine",
      "model",
      "reasoning",
    ])
    expect(fuzzySettingsCandidates("effort", [sources[0]]).map((item) => item.field)).toEqual(["reasoning"])
    expect(fuzzySettingsCandidates("reasoning", [sources[0]])).toEqual([])
    expect(fuzzySettingsCandidates("private", [sources[0]])).toEqual([])
  })

  test("limits effort records to the active provider and model", () => {
    const sources = buildUniversalPaletteSources({
      availableProviders: [
        { id: "codex", models: ["codex-model"], reasoningLevels: ["high"], selectable: true },
        { id: "claude", models: ["claude-model"], reasoningLevels: ["high"], selectable: true },
      ],
      anotherAvailable: false,
      doctorAvailable: false,
      engine: null,
      model: "claude-model",
      providerId: "claude",
      providerSource: "default",
      reasoning: "low",
    })
    expect(fuzzySettingsCandidates("high", sources).map((source) => source.providerLabel)).toEqual(["Claude"])
  })

  test("honors the explicit ASCII override in renderer environments", () => {
    const hadWindow = "window" in globalThis
    const priorWindow = (globalThis as any).window
    const priorNoUnicode = process.env.NO_UNICODE
    try {
      ;(globalThis as any).window = {}
      process.env.NO_UNICODE = "1"
      expect(isNoUnicode()).toBe(true)
    } finally {
      if (hadWindow) (globalThis as any).window = priorWindow
      else delete (globalThis as any).window
      if (priorNoUnicode === undefined) delete process.env.NO_UNICODE
      else process.env.NO_UNICODE = priorNoUnicode
    }
  })

  test("resolves bundled providers by exact registry paths only", () => {
    expect(resolveProviderId([BUNDLED_CODEX_PROVIDER])).toBe("codex")
    expect(resolveProviderId([BUNDLED_CLAUDE_PROVIDER])).toBe("claude")
    expect(resolveProviderId(["/tmp/codex-provider.zsh"])).toBeNull()
    expect(resolveProviderId([BUNDLED_CODEX_PROVIDER, "--extra"])).toBeNull()
    expect(adapterPath(providerRegistry().find((item) => item.id === "codex")!)).toBe(
      BUNDLED_CODEX_PROVIDER,
    )
    expect(BUNDLED_DEFAULT_PROVIDER).toBe("codex")
    expect(providerRegistry({ HOME: "/tmp", SHELLQ_CLAUDE_REASONING: "low" }).find((item) => item.id === "claude")?.reasoningLevels)
      .toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("PATH detection is inert and store roots are non-following", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-provider-detect-"))
    try {
      const bin = join(root, "bin")
      mkdirSync(bin)
      writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0", { mode: 0o700 })
      const available = providerAvailability({
        HOME: root,
        PATH: bin,
      })
      expect(available.find((item) => item.id === "codex")?.selectable).toBe(true)
      expect(available.find((item) => item.id === "claude")?.selectable).toBe(false)
      const store = join(root, ".codex")
      symlinkSync(join(root, "missing"), store)
      expect(
        providerAvailability({ HOME: root, PATH: bin }).find(
          (item) => item.id === "codex",
        )?.historyAvailable,
      ).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("provider-scoped settings migrate v1 and retain both entries", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-provider-settings-"))
    try {
      const env = { SHELLQ_STATE_DIR: root }
      const path = inferenceSettingsFile(env)
      writeFileSync(
        path,
        JSON.stringify({ version: 1, model: "gpt-5.6-luna", reasoning: "high" }),
        { mode: 0o600 },
      )
      expect(readPersistedInferenceSettings(env, "codex")).toEqual({
        model: "gpt-5.6-luna",
        reasoning: "high",
      })
      writePersistedInferenceSettings("claude-sonnet-5", "low", env, "claude")
      expect(readPersistedInferenceSettings(env, "codex")?.model).toBe(
        "gpt-5.6-luna",
      )
      expect(readPersistedInferenceSettings(env, "claude")?.model).toBe(
        "claude-sonnet-5",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("configured providers keep their argv and use the reserved settings scope", () => {
    const configured = {
      ...(session as any),
      provider: ["/tmp/custom-provider"],
      provider_source: "configured" as const,
    }
    const notice = prepareProviderSession(configured, {
      SHELLQ_STATE_DIR: mkdtempSync(join(tmpdir(), "shellq-configured-")),
    })
    expect(configured.provider).toEqual(["/tmp/custom-provider"])
    expect(configured.provider_id).toBeNull()
    expect(notice).toBeNull()
  })

  test("pointer provenance refuses another provider", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-pointer-provider-"))
    try {
      const path = join(root, "pointer.json")
      writeFileSync(
        path,
        JSON.stringify({
          provider: "claude",
          session_id: "11111111-1111-4111-8111-111111111111",
          cwd: "/tmp",
        }),
        { mode: 0o600 },
      )
      expect(providerPointerDecision(path, { provider: "codex", cwd: "/tmp" }).kind).toBe(
        "invalid",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("pointer provenance rejects a regular file over the byte limit", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-pointer-size-"))
    try {
      const path = join(root, "pointer.json")
      writeFileSync(path, "x".repeat(PROVIDER_POINTER_MAX_BYTES + 1), { mode: 0o600 })
      expect(providerPointerDecision(path, { provider: "codex", cwd: "/tmp" })).toEqual({
        kind: "invalid",
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("validates the provider response schema", () => {
    expect(responseIsValid(candidate("echo ok"))).toBe(true)
    expect(responseIsValid({ ...candidate("echo ok"), risk: "x".repeat(81) }))
      .toBe(false)
    expect(commandIsValid("echo \u001b[31mbad")).toBe(false)
    expect(commandIsValid("echo \u009b2J")).toBe(false)
    expect(commandIsValid("echo \u202ereordered")).toBe(false)
    expect(commandIsValid("echo \u2066isolated")).toBe(false)
    expect(responseIsValid({ ...candidate("echo ok"), risk: "\u009b2J" }))
      .toBe(false)
    expect(responseIsValid({ ...candidate("echo ok"), tldr: "\u202ereordered" }))
      .toBe(false)
    expect(responseIsValid({ ...candidate("echo ok"), risk: "\u2066isolated" }))
      .toBe(false)
    expect(parseProviderResponse(`${JSON.stringify(candidate("pwd"))}\n{}`))
      .toBeNull()
  })

  test("sanitizes and bounds captured or pasted context", () => {
    expect(sanitizeContext("old \u001b[31mred\u001b[0m\u0001\nlast"))
      .toBe("old red\nlast")
    expect(sanitizeContext("old\u009b2Jlast")).toBe("old2Jlast")
    expect(sanitizeContext("old\u202elast")).toBe("old\\u{202e}last")
    expect(
      new TextEncoder().encode(sanitizeContext("🙂".repeat(20_000))).byteLength,
    ).toBeLessThanOrEqual(16_384)
  })

  test("keeps at most five distinct candidates", () => {
    let candidates: ProviderResponse[] = []
    for (let index = 0; index < 7; index += 1) {
      candidates = appendCandidate(candidates, candidate(`echo ${index}`))
    }
    expect(candidates.map((item) => item.corrected_command)).toEqual([
      "echo 0",
      "echo 1",
      "echo 2",
      "echo 3",
      "echo 4",
    ])
    expect(appendCandidate(candidates, candidate("echo 4"))).toBe(candidates)
  })

  test("only sends ordinary prior context after explicit inclusion", () => {
    const excluded = buildProviderRequest(
      session,
      "generate",
      "list files",
      "prior output",
      false,
      [],
    )
    expect(excluded.input.captured_output).toBe("")
    expect(excluded.input.previous_command).toBeUndefined()

    const included = buildProviderRequest(
      session,
      "generate",
      "list files",
      "edited output",
      true,
      [candidate("ls")],
    )
    expect(included.input.captured_output).toBe("edited output")
    expect(included.input.previous_command.command).toBe("pwd")
    expect(included.input.avoid_commands).toEqual(["ls"])
    expect(included.input.captured_output_correlated_to_command).toBe(false)

    const pasted = buildProviderRequest(
      {
        ...session,
        context: {
          text: "",
          source: "none",
          label: "unavailable",
          correlated: false,
          included: false,
        },
      },
      "generate",
      "list files",
      "manually pasted output",
      true,
      [],
    )
    expect(pasted.input.captured_output).toBe("manually pasted output")

    const correction = buildProviderRequest(
      {
        ...session,
        context: { ...session.context, included: true },
      },
      "correct",
      "pwd",
      "prior output",
      true,
      [],
    )
    expect(correction.input.captured_output_correlated_to_command).toBe(true)

    const edited = saveContextDraft("newly pasted secret")
    expect(edited.included).toBe(false)
    expect(
      buildProviderRequest(
        { ...session, context: { ...session.context, included: true } },
        "generate",
        "list files",
        edited.context,
        edited.included,
        [],
      ).input.captured_output,
    ).toBe("")
  })

  test("keeps Ask queries and answers inside their isolated contract", () => {
    expect(queryIsValid("what is this repo?")).toBe(true)
    expect(queryIsValid("x".repeat(ASK_QUERY_MAX_BYTES))).toBe(true)
    expect(queryIsValid("x".repeat(ASK_QUERY_MAX_BYTES + 1))).toBe(false)
    expect(queryIsValid("line one\n\nline two")).toBe(true)
    expect(queryIsValid("\n\t")).toBe(false)
    expect(queryIsValid("unsafe \u202e query")).toBe(false)

    expect(answerIsValid("x".repeat(ASK_ANSWER_MAX_BYTES))).toBe(true)
    expect(answerIsValid("🙂".repeat(ASK_ANSWER_MAX_BYTES / 4))).toBe(true)
    expect(answerIsValid("x".repeat(ASK_ANSWER_MAX_BYTES) + "x")).toBe(false)
    expect(answerIsValid("line one\n\tline two")).toBe(true)
    expect(answerIsValid("unsafe \u009b2J")).toBe(false)
    expect(answerIsValid("unsafe \u2066 isolate")).toBe(false)
    expect(parseAskResponse('{"answer":"safe"}')).toEqual({
      answer: "safe",
    })
    expect(parseAskResponse('{"answer":"safe","command":"pwd"}')).toBeNull()
    expect(parseAskResponse('{"answer":"safe"}\n{}')).toBeNull()

    const held = buildAskRequest(
      session,
      "what changed?",
      "captured output",
      false,
    )
    expect(held.mode).toBe("ask")
    expect(held.input.query).toBe("what changed?")
    expect(held.input.previous_command.command).toBe("pwd")
    expect(held.input.captured_output).toBe("")

    const included = buildAskRequest(
      session,
      "what failed?",
      "captured output",
      true,
    )
    expect(included.input.captured_output).toBe("captured output")

    expect(validateTrustedWorkdir("/tmp")).toBe("/tmp")
    expect(() => validateTrustedWorkdir("relative/path")).toThrow(
      "invalid workbench directory",
    )
    expect(() =>
      validateTrustedWorkdir("/definitely/missing/shellq-directory"),
    ).toThrow("invalid workbench directory")
  })

  test("derives one private Codex pointer per trusted cwd", () => {
    const override = codexSessionFile("/tmp", {
      SHELLQ_STATE_DIR: "/private/tmp/shellq-state",
    })
    expect(override).toMatch(
      /^\/private\/tmp\/shellq-state\/ask\/codex-[a-f0-9]{64}\.json$/,
    )
    expect(
      codexSessionFile("/tmp", {
        SHELLQ_STATE_DIR: "/private/tmp/shellq-state",
      }),
    ).toBe(override)
    expect(
      codexSessionFile(homedir(), {
        SHELLQ_STATE_DIR: "/private/tmp/shellq-state",
      }),
    ).not.toBe(override)
    expect(
      codexSessionFile("/tmp", { XDG_STATE_HOME: "/private/tmp/xdg" }),
    ).toStartWith("/private/tmp/xdg/shellq/ask/")
    expect(codexSessionFile("/tmp", { HOME: "/Users/tester" })).toStartWith(
      "/Users/tester/.local/state/shellq/ask/",
    )
    expect(() =>
      codexSessionFile("/tmp", { SHELLQ_STATE_DIR: "relative" }),
    ).toThrow("invalid shellq state directory")
    expect(askChatWasSaved(null)).toBe(false)
    expect(askChatWasSaved("/tmp")).toBe(false)
    expect(
      codexSessionFile(
        "/tmp",
        { SHELLQ_STATE_DIR: "/private/tmp/shellq-state" },
        "app-server",
      ),
    ).toMatch(
      /^\/private\/tmp\/shellq-state\/ask\/codex-app-server-isolated-[a-f0-9]{64}\.json$/,
    )
  })

  test("inferenceSettingsFile sits beside the ask/ pointer directory, not inside it", () => {
    const env = { SHELLQ_STATE_DIR: "/private/tmp/shellq-state" }
    expect(inferenceSettingsFile(env)).toBe(
      "/private/tmp/shellq-state/settings.json",
    )
    expect(() =>
      inferenceSettingsFile({ SHELLQ_STATE_DIR: "relative" }),
    ).toThrow("invalid shellq state directory")
  })

  test("round-trips a saved inference selection through the private state root", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-"))
    try {
      const env = { SHELLQ_STATE_DIR: stateDir }
      expect(readPersistedInferenceSettings(env)).toBeNull()

      writePersistedInferenceSettings("gpt-5.6-luna", "high", env)
      expect(readPersistedInferenceSettings(env)).toEqual({
        model: "gpt-5.6-luna",
        reasoning: "high",
      })

      // Directory 0700, file 0600 — the same private-state discipline the
      // Ask pointer already uses.
      const path = inferenceSettingsFile(env)
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(stateDir).mode & 0o777).toBe(0o700)

      // A second write overwrites the first rather than appending or
      // failing because the file already exists.
      writePersistedInferenceSettings("gpt-5.3-codex-spark", "low", env)
      expect(readPersistedInferenceSettings(env)).toEqual({
        model: "gpt-5.3-codex-spark",
        reasoning: "low",
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("a saved value wins over the shell default only when the session still offers it", () => {
    const withSaved = { ...session }
    expect(
      applyPersistedInferenceSettings(withSaved, {
        model: "gpt-5.6-luna",
        reasoning: "high",
      }),
    ).toBeNull()
    expect(withSaved.model).toBe("gpt-5.6-luna")
    expect(withSaved.reasoning).toBe("high")

    const claudeSession = {
      ...session,
      provider_id: "claude" as const,
      model: "claude-sonnet-5",
      models: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"],
      reasoning: "low",
      reasoning_levels: providerRegistry({ HOME: "/tmp", SHELLQ_CLAUDE_REASONING: "low" })
        .find((item) => item.id === "claude")!.reasoningLevels,
    }
    expect(applyPersistedInferenceSettings(claudeSession, {
      model: "claude-sonnet-5",
      reasoning: "max",
    })).toBeNull()
    expect(claudeSession.reasoning).toBe("max")

    expect(applyPersistedInferenceSettings({ ...session }, null)).toBeNull()

    // An unknown saved model falls back to the shell default and reports it
    // once; an unknown reasoning level does the same independently.
    const staleModel = { ...session }
    const modelNotice = applyPersistedInferenceSettings(staleModel, {
      model: "gpt-5.9-ghost",
      reasoning: "medium",
    })
    expect(staleModel.model).toBe(session.model)
    expect(staleModel.reasoning).toBe("medium")
    expect(modelNotice).toBe("saved model unavailable · using Spark")

    const staleBoth = { ...session }
    const bothNotice = applyPersistedInferenceSettings(staleBoth, {
      model: "gpt-5.9-ghost",
      reasoning: "extreme",
    })
    expect(staleBoth.model).toBe(session.model)
    expect(staleBoth.reasoning).toBe(session.reasoning)
    expect(bothNotice).toBe(
      "saved model unavailable · using Spark · saved effort unavailable · using low",
    )
  })

  test("readPersistedInferenceSettings refuses untrusted files without throwing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-untrusted-"))
    try {
      const env = { SHELLQ_STATE_DIR: stateDir }
      const path = inferenceSettingsFile(env)

      // Malformed JSON.
      writeFileSync(path, "{not json", { mode: 0o600 })
      expect(readPersistedInferenceSettings(env)).toBeNull()

      // Well-formed JSON missing the expected shape.
      writeFileSync(path, JSON.stringify({ version: 1, model: "x" }), {
        mode: 0o600,
      })
      expect(readPersistedInferenceSettings(env)).toBeNull()

      // Unknown keys are untrusted too.
      writeFileSync(path, JSON.stringify({ version: 1, model: "x", reasoning: "low", extra: true }), {
        mode: 0o600,
      })
      expect(readPersistedInferenceSettings(env)).toBeNull()

      // Oversized file.
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          model: "x".repeat(INFERENCE_SETTINGS_MAX_BYTES),
          reasoning: "low",
        }),
        { mode: 0o600 },
      )
      expect(readPersistedInferenceSettings(env)).toBeNull()

      // Non-regular file: a directory occupying the expected path.
      rmSync(path, { force: true })
      mkdirSync(path)
      expect(readPersistedInferenceSettings(env)).toBeNull()
      rmSync(path, { recursive: true, force: true })

      // Symlink to a file that would otherwise be valid.
      const real = join(stateDir, "real-settings.json")
      writeFileSync(
        real,
        JSON.stringify({ version: 1, model: "gpt-5.6-luna", reasoning: "low" }),
        { mode: 0o600 },
      )
      symlinkSync(real, path)
      expect(readPersistedInferenceSettings(env)).toBeNull()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("distinguishes missing, invalid, and operational settings reads", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-settings-state-"))
    try {
      const env = { SHELLQ_STATE_DIR: root }
      expect(readPersistedInferenceDocumentState(env).kind).toBe("missing")
      writeFileSync(inferenceSettingsFile(env), "not json", { mode: 0o600 })
      expect(readPersistedInferenceDocumentState(env).kind).toBe("invalid")
      const blocked = join(root, "blocked")
      writeFileSync(blocked, "not a directory")
      expect(readPersistedInferenceDocumentState({ SHELLQ_STATE_DIR: blocked }).kind)
        .toBe("operational-error")
      expect(() => writePersistedInferenceSettings("gpt-5.6-luna", "high", {
        SHELLQ_STATE_DIR: blocked,
      })).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("endpoint settings resolve strictly, merge both writer orders, and require explicit safe repair", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-endpoint-settings-"))
    const env = { SHELLQ_STATE_DIR: join(root, "state") }
    const resolve = (override = {}) => resolveLocalEndpoint(readPersistedInferenceDocumentState(env), { ...env, ...override })
    try {
      expect(resolve().endpoint).toBe(DEFAULT_LOCAL_ENDPOINT)
      writePersistedLocalEndpoint("http://[::1]:65535/v1/", "claude", env)
      expect(readPersistedInferenceDocument(env)).toEqual({ version: 2, provider: "claude", providers: {}, localEndpoint: "http://[::1]:65535/v1" })
      expect(resolve().source).toBe("saved")
      writePersistedInferenceSettings("claude-sonnet-5", "high", env, "claude")
      expect(resolve().endpoint).toBe("http://[::1]:65535/v1")
      writePersistedLocalEndpoint("http://127.0.0.1:1/v1", "codex", env)
      expect(readPersistedInferenceDocument(env)?.provider).toBe("claude")
      expect(readPersistedInferenceSettings(env, "claude")?.model).toBe("claude-sonnet-5")
      expect(resolve({ SHELLQ_LOCAL_OPENAI_ENDPOINT: "http://127.0.0.1:2/v1" })).toEqual({ endpoint: "http://127.0.0.1:2/v1", source: "environment override", readOnly: true })
      for (const bad of ["", "private-invalid-override", "http://localhost:8000/v1"]) {
        expect(resolve({ SHELLQ_LOCAL_OPENAI_ENDPOINT: bad })).toEqual({ endpoint: null, source: "environment override", readOnly: true })
      }
      const path = inferenceSettingsFile(env)
      const valid = readFileSync(path, "utf8")
      for (const raw of ["{corrupt", JSON.stringify({ ...JSON.parse(valid), extra: true }), JSON.stringify({ ...JSON.parse(valid), localEndpoint: 8 }), JSON.stringify({ ...JSON.parse(valid), localEndpoint: "http://localhost:8000/v1" }), "x".repeat(4097)]) {
        writeFileSync(path, raw)
        expect(resolve().endpoint).toBeNull()
        expect(() => writePersistedInferenceSettings("other", "low", env, "configured")).toThrow()
        expect(readFileSync(path, "utf8")).toBe(raw)
        expect(() => writePersistedLocalEndpoint(DEFAULT_LOCAL_ENDPOINT, null, env)).toThrow("confirm replacement")
        expect(readFileSync(path, "utf8")).toBe(raw)
        expect(resolve({ SHELLQ_LOCAL_OPENAI_ENDPOINT: DEFAULT_LOCAL_ENDPOINT }).endpoint).toBe(DEFAULT_LOCAL_ENDPOINT)
        writePersistedLocalEndpoint(DEFAULT_LOCAL_ENDPOINT, null, env, true)
        expect(readPersistedInferenceDocument(env)).toEqual({ version: 2, provider: "codex", providers: {}, localEndpoint: DEFAULT_LOCAL_ENDPOINT })
      }
      writePersistedInferenceSettings("configured-model", "low", env, "configured")
      writePersistedLocalEndpoint(null, null, env)
      expect(resolve().source).toBe("default")
      expect(readPersistedInferenceSettings(env, "configured")?.model).toBe("configured-model")
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(env.SHELLQ_STATE_DIR).mode & 0o777).toBe(0o700)
      expect(readdirSync(env.SHELLQ_STATE_DIR)).toEqual(["settings.json"])
      rmSync(path)
      const target = join(root, "target")
      writeFileSync(target, valid)
      symlinkSync(target, path)
      expect(resolve().endpoint).toBeNull()
      expect(() => writePersistedLocalEndpoint(DEFAULT_LOCAL_ENDPOINT, null, env, true)).toThrow("safely")
      expect(readFileSync(target, "utf8")).toBe(valid)
      rmSync(path)
      mkdirSync(path)
      expect(() => writePersistedLocalEndpoint(null, null, env, true)).toThrow("safely")
      expect(statSync(path).isDirectory()).toBe(true)
      const blocked = { SHELLQ_STATE_DIR: target }
      expect(resolveLocalEndpoint(readPersistedInferenceDocumentState(blocked), blocked).endpoint).toBeNull()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("endpoint Doctor uses cached effective resolution with four value-free rows", () => {
    const base = {
      cwd: tmpdir(), providerId: LOCAL_PROVIDER_ID, providerSource: "default" as const,
      providerAvailable: true, adapterAvailable: true, settings: { kind: "invalid" as const },
      pointer: null, pointerRequired: false, pointerWillStartNew: false,
    }
    const unresolved = resolveLocalEndpoint(base.settings, {})
    expect(captureDoctorRows({ ...base, localEndpoint: unresolved })[2]).toEqual({ key: "FAIL settings", value: "local endpoint unavailable; configure local endpoint" })
    expect(captureDoctorRows({ ...base, providerSource: "configured", localEndpoint: unresolved })[2].key).toBe("WARN settings")
    for (const source of ["environment override", "not saved"] as const) {
      const rows = captureDoctorRows({ ...base, localEndpoint: { endpoint: "http://127.0.0.1:54321/v1", source, readOnly: source === "environment override" } })
      expect(rows).toHaveLength(4)
      expect(rows[2]).toEqual({ key: "WARN settings", value: "settings not saved; in-memory configuration active" })
      expect(JSON.stringify(rows)).not.toContain("54321")
      expect(JSON.stringify(rows)).not.toContain("http")
    }
  })

  test("a write failure leaves the invocation usable instead of crashing it", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-write-fail-"))
    try {
      const env = { SHELLQ_STATE_DIR: stateDir }
      const path = inferenceSettingsFile(env)
      // Occupy the settings path with a directory so the write's rename
      // step fails deterministically, without depending on file permissions
      // (which a root-run test suite could ignore).
      mkdirSync(path)
      expect(() =>
        writePersistedInferenceSettings("gpt-5.6-luna", "high", env),
      ).toThrow()
      // The failed write left no partial temp file behind — only the
      // directory that blocked it remains — and a caller that catches the
      // throw can keep running: a subsequent read still resolves to "unset"
      // rather than a half-written value.
      expect(readdirSync(stateDir)).toEqual(["settings.json"])
      rmSync(path, { recursive: true, force: true })
      expect(readPersistedInferenceSettings(env)).toBeNull()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("settings lock preserves a live owner and reclaims a dead owner", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-lock-"))
    try {
      const env = { SHELLQ_STATE_DIR: stateDir }
      const settingsPath = inferenceSettingsFile(env)
      writeFileSync(join(stateDir, INFERENCE_SETTINGS_LOCK), JSON.stringify({
        pid: process.pid,
        nonce: "live-owner",
        created_at: Date.now(),
      }), { mode: 0o600 })
      expect(() => writePersistedInferenceSettings("gpt-5.6-luna", "high", env)).toThrow()
      expect(readFileSync(join(stateDir, INFERENCE_SETTINGS_LOCK), "utf8")).toContain("live-owner")

      writeFileSync(join(stateDir, INFERENCE_SETTINGS_LOCK), JSON.stringify({
        pid: 99999999,
        nonce: "dead-owner",
        created_at: Date.now(),
      }), { mode: 0o600 })
      writePersistedInferenceSettings("gpt-5.6-luna", "high", env)
      expect(readPersistedInferenceSettings(env)).toEqual({
        model: "gpt-5.6-luna",
        reasoning: "high",
      })
      expect(existsSync(join(stateDir, INFERENCE_SETTINGS_LOCK))).toBe(false)
      expect(existsSync(settingsPath)).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("concurrent writers preserve both provider settings", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-concurrent-"))
    try {
      writeFileSync(join(stateDir, INFERENCE_SETTINGS_LOCK), JSON.stringify({
        pid: 99999999,
        nonce: "dead-owner",
        created_at: Date.now(),
      }), { mode: 0o600 })
      const modulePath = join(import.meta.dir, "../src", "workbench.ts")
      const jobs = [
        ["gpt-5.6-luna", "codex"],
        ["claude-opus-5", "claude"],
      ].map(([model, provider]) => {
        const script = `const { writePersistedInferenceSettings } = await import(${JSON.stringify(modulePath)}); writePersistedInferenceSettings(${JSON.stringify(model)}, "high", process.env, ${JSON.stringify(provider)});`
        return Bun.spawn([process.execPath, "-e", script], {
          env: { ...process.env, SHELLQ_STATE_DIR: stateDir },
          stderr: "pipe",
          stdout: "pipe",
        })
      })
      const results = await Promise.all(jobs.map(async (job) => ({
        code: await job.exited,
        stderr: await new Response(job.stderr).text(),
      })))
      expect(results).toEqual([
        { code: 0, stderr: "" },
        { code: 0, stderr: "" },
      ])
      const document = readPersistedInferenceDocument({ SHELLQ_STATE_DIR: stateDir })!
      expect(document.version).toBe(2)
      expect(["codex", "claude"]).toContain(document.provider)
      expect(document.providers).toEqual({
        codex: { model: "gpt-5.6-luna", reasoning: "high" },
        claude: { model: "claude-opus-5", reasoning: "high" },
      })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test("settings lock reclaims a reclaim sentinel stranded by a killed writer", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-stranded-sentinel-"))
    try {
      const env = { SHELLQ_STATE_DIR: stateDir }
      const lockPath = join(stateDir, INFERENCE_SETTINGS_LOCK)
      const sentinelPath = `${lockPath}.reclaim`
      // Simulate a writer that died between reclaiming the dead main lock's
      // `.reclaim` sentinel and its own cleanup: the dead-owned main lock
      // and the sentinel it created (also with a dead pid, since it never
      // got to overwrite it with its own live identity) are both left
      // behind on disk.
      writeFileSync(lockPath, JSON.stringify({
        pid: 99999999,
        nonce: "dead-owner",
        created_at: Date.now() - 60_000,
      }), { mode: 0o600 })
      writeFileSync(sentinelPath, JSON.stringify({
        pid: 99999999,
        nonce: "dead-reclaimer",
        created_at: Date.now() - 60_000,
      }), { mode: 0o600 })

      // Without owner/liveness discipline on the sentinel, every later
      // writer's `openSync(sentinel, "wx")` fails forever and this throws.
      writePersistedInferenceSettings("gpt-5.6-luna", "high", env)

      expect(readPersistedInferenceSettings(env)).toEqual({
        model: "gpt-5.6-luna",
        reasoning: "high",
      })
      expect(existsSync(lockPath)).toBe(false)
      expect(existsSync(sentinelPath)).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  for (const boundary of ["kill-reclaimer", "paused-live-reclaimer", "competing-stale-reclaimers"] as const) {
    test(`production settings writer serializes ${boundary}`, async () => {
      const stateDir = mkdtempSync(join(tmpdir(), "shellq-settings-boundary-"))
      const env = { ...process.env, SHELLQ_STATE_DIR: stateDir }
      const lock = join(stateDir, INFERENCE_SETTINGS_LOCK)
      const claim = `${lock}.reclaim`
      const dead = JSON.stringify({ pid: 99999999, nonce: "dead", created_at: 0 })
      writeFileSync(lock, dead, { mode: 0o600 })
      if (boundary === "competing-stale-reclaimers") writeFileSync(claim, dead, { mode: 0o600 })
      const jobs: ReturnType<typeof Bun.spawn>[] = []
      const spawnWriter = (pause: boolean, provider: string) => {
        const script = `
          import * as fs from "node:fs";
          import { spyOn } from "bun:test";
          const claim = ${JSON.stringify(claim)};
          let stopped = false;
          const stop = () => { if (stopped) return; stopped = true; fs.writeSync(1, "paused\\n"); process.kill(process.pid, "SIGSTOP"); };
          if (${pause}) {
            if (${JSON.stringify(boundary)} === "competing-stale-reclaimers") {
              const unlink = fs.unlinkSync;
              spyOn(fs, "unlinkSync").mockImplementation(path => { if (path === claim) stop(); return unlink(path); });
            } else {
              const link = fs.linkSync;
              spyOn(fs, "linkSync").mockImplementation((from, to) => { const result = link(from, to); if (to === claim) stop(); return result; });
            }
          }
          const { writePersistedInferenceSettings } = await import(${JSON.stringify(join(import.meta.dir, "../src", "workbench.ts"))});
          try { writePersistedInferenceSettings("model-${provider}", "high", process.env, ${JSON.stringify(provider)}); }
          catch { process.exit(1); }
        `
        const job = Bun.spawn([process.execPath, "-e", script], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        jobs.push(job)
        return job
      }
      try {
        const first = spawnWriter(true, "codex")
        const reader = first.stdout.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("paused\n")
        reader.releaseLock()
        if (boundary !== "competing-stale-reclaimers") {
          expect(JSON.parse(readFileSync(claim, "utf8")).pid).toBe(first.pid)
        }
        if (boundary === "kill-reclaimer") {
          first.kill("SIGKILL")
          await first.exited
        } else {
          const identity = statSync(claim).ino
          utimesSync(claim, new Date(0), new Date(0))
          const competing = spawnWriter(false, "claude")
          expect(await competing.exited).toBe(1)
          expect(statSync(claim).ino).toBe(identity)
          expect(existsSync(inferenceSettingsFile(env))).toBe(false)
          process.kill(first.pid, "SIGCONT")
          expect(await first.exited).toBe(0)
        }
        const next = spawnWriter(false, "claude")
        expect(await next.exited).toBe(0)
        const document = readPersistedInferenceDocument(env)!
        expect(document.providers.claude?.model).toBe("model-claude")
        if (boundary !== "kill-reclaimer") expect(document.providers.codex?.model).toBe("model-codex")
        expect(existsSync(lock)).toBe(false)
        expect(existsSync(claim)).toBe(false)
      } finally {
        for (const job of jobs) { try { job.kill("SIGKILL") } catch {} }
        await Promise.all(jobs.map(job => job.exited))
        rmSync(stateDir, { recursive: true, force: true })
      }
    }, 20_000)
  }

  test("only gives the bundled Codex provider exact resume state", () => {
    const provider = [BUNDLED_CODEX_PROVIDER]
    const pointer = "/private/tmp/shellq-state/ask/codex-test.json"
    expect(isBundledCodexProvider(provider)).toBe(true)
    expect(isBundledCodexProvider([...provider, "--extra"])).toBe(false)
    expect(isBundledCodexProvider(["custom-provider"])).toBe(false)
    expect(isBundledCodexProvider(["/tmp/codex-provider.zsh"])).toBe(false)
    expect(codexAskSessionEnvironment(provider, pointer, false)).toEqual({
      SHELLQ_CODEX_SESSION_FILE: pointer,
    })
    const candidate = appServerCandidateFile(pointer)
    expect(codexAskSessionEnvironment(provider, pointer, true, "exec", candidate)).toEqual({
      SHELLQ_ASK_PENDING_FILE: candidate,
      SHELLQ_CODEX_NEW_SESSION: "1",
      SHELLQ_CODEX_SESSION_FILE: pointer,
    })
    expect(
      codexAskSessionEnvironment(["custom-provider"], pointer, true),
    ).toEqual({})
    expect(() =>
      codexAskSessionEnvironment(provider, "relative.json", false),
    ).toThrow("invalid Codex session file")

    expect(candidate).toStartWith(`${pointer}.pending-`)
    expect(
      codexAskSessionEnvironment(
        provider,
        pointer,
        false,
        "app-server",
        candidate,
        "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
      ),
    ).toEqual({
      SHELLQ_ASK_PENDING_FILE: candidate,
      SHELLQ_CODEX_SESSION_ID: "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
      SHELLQ_CODEX_SESSION_FILE: pointer,
    })
    expect(
      codexAskSessionEnvironment(
        provider,
        pointer,
        true,
        "app-server",
        candidate,
      ),
    ).toEqual({
      SHELLQ_ASK_PENDING_FILE: candidate,
      SHELLQ_CODEX_NEW_SESSION: "1",
      SHELLQ_CODEX_SESSION_FILE: pointer,
    })
    expect(() =>
      codexAskSessionEnvironment(
        provider,
        pointer,
        false,
        "app-server",
        candidate,
      ),
    ).toThrow("invalid App Server session intent")
    expect(
      askProviderArgv(
        {
          ...session,
          provider,
          codex_ask_engine: "app-server",
        },
        "/usr/bin/bun",
      ),
    ).toEqual(["/usr/bin/bun", BUNDLED_CODEX_APP_SERVER_PROVIDER])
    expect(
      askProviderArgv({ ...session, provider, codex_ask_engine: "exec" }),
    ).toBe(provider)
  })

  test("renders every configured argv element independently", () => {
    const command = ["provider", "argument with spaces", "quote\"here"]
    const item = metadataItems({
      askChatState: "one-shot",
      candidate: null,
      candidateCount: 0,
      candidateIndex: 0,
      contextBytes: 0,
      contextLabel: "unavailable",
      contextSource: "none",
      cwd: "/tmp",
      included: false,
      lastCommand: null,
      model: "Spark",
      providerCommand: command,
      reasoning: "low",
      repositoryAccess: false,
    })
    expect(item.find((entry) => entry.key === "provider command")?.value).toBe(
      command.map(terminalLiteral).join(" "),
    )
  })

  test("maps only the documented ctrl-x suffixes", () => {
    expect(
      Object.fromEntries(
        ["a", "c", "d", "e", "g", "h", "i", "m", "n", "r", "w"].map((key) => [
          key,
          ctrlXAction(key),
        ]),
      ),
    ).toEqual({
      a: "another",
      c: "context",
      d: "doctor",
      e: "edit",
      g: "engine",
      h: "details",
      i: "include",
      m: "model",
      n: "new-chat",
      r: "reasoning",
      w: "save",
    })
    expect(ctrlXAction("H")).toBe("details")
    expect(ctrlXAction("?")).toBeNull()
  })

  test("switchAskEngine clears only engine-bound Ask state", () => {
    const previous = {
      conversation: {
        turns: [{ question: "old question", answer: "old answer" }],
        dropped: true,
      },
      askDraft: "preserve exactly",
      askPreview: { note: "working", text: "partial", thinking: "private reasoning" },
      candidates: [candidate("echo keep")],
      context: "saved output",
      diagnosis: "old diagnosis",
      editorMode: "view" as const,
      includeContext: true,
      intent: "ask" as const,
      lastAskQuery: "old question",
      model: "gpt-5.6-luna",
      newAskSession: true,
      phase: "answer" as const,
      reasoning: "high",
    }
    const switched = switchAskEngine(
      previous,
      "exec",
      true,
    )

    expect(switched).toEqual({
      ...previous,
      conversation: emptyAskConversation(),
      askPreview: { note: "", text: "", thinking: "" },
      diagnosis: null,
      detail: "new chat armed · Exec",
      editorMode: "composer",
      lastAskQuery: "",
      newAskSession: true,
      phase: "ready",
    })

    expect(
      switchAskEngine(
        {
          ...previous,
          intent: "correct",
          newAskSession: false,
          phase: "analysis",
          editorMode: "prompt",
        },
        "app-server",
        false,
      ),
    ).toMatchObject({
      diagnosis: "old diagnosis",
      editorMode: "prompt",
      intent: "correct",
      phase: "analysis",
    })
  })

  test("steps conversation offsets from the displayed clamp", () => {
    expect(steppedConversationOffset(28, 6, -1)).toBe(5)
    expect(steppedConversationOffset(28, 6, 1)).toBe(6)
    expect(steppedConversationOffset(0, 6, -1)).toBe(0)
  })

  test("wraps conversation prose in one pass with hard long-word fallback", () => {
    expect(wrappedTextLines("alpha beta", 6, "word")).toEqual([
      "alpha",
      "beta",
    ])
    expect(wrappedTextLines("abcdefgh", 4, "word")).toEqual([
      "abcd",
      "efgh",
    ])
    expect(wrappedTextLines("alpha beta", 6)).toEqual([
      "alpha ",
      "beta",
    ])
  })

  test("wraps the maximum retained conversation without a quadratic stall", () => {
    const conversation = {
      dropped: false,
      turns: Array.from({ length: ASK_TURN_LIMIT }, () => ({
        answer: "a".repeat(ASK_ANSWER_MAX_BYTES),
        question: "q".repeat(ASK_QUERY_MAX_BYTES),
      })),
    }
    const started = performance.now()
    const lines = askConversationRows(conversation, 76)
    expect(lines.length).toBeGreaterThan(0)
    expect(performance.now() - started).toBeLessThan(750)
  })

  test("keeps newest Ask turns together and discloses whole-turn retention", () => {
    let conversation = emptyAskConversation()
    for (let index = 0; index < ASK_TURN_LIMIT; index += 1) {
      conversation = appendAskTurn(conversation, {
        question: `question ${index}`,
        answer: `answer ${index}`,
      })
    }

    expect(conversation.turns).toHaveLength(ASK_TURN_LIMIT)
    expect(conversation.turns[0]).toEqual({
      question: `question ${ASK_TURN_LIMIT - 1}`,
      answer: `answer ${ASK_TURN_LIMIT - 1}`,
    })
    expect(conversation.turns.at(-1)).toEqual({
      question: "question 0",
      answer: "answer 0",
    })
    expect(conversation.dropped).toBe(false)

    conversation = appendAskTurn(conversation, {
      question: "newest",
      answer: "newest answer",
    })
    expect(conversation.turns).toHaveLength(ASK_TURN_LIMIT)
    expect(conversation.turns[0]?.question).toBe("newest")
    expect(conversation.turns.at(-1)?.question).toBe("question 1")
    expect(conversation.dropped).toBe(true)
  })

  test("shows the retention notice before the oldest retained turn", () => {
    const rows = askConversationRows({
      turns: [{ question: "kept", answer: "answer" }], dropped: true,
    }, 76)
    expect(rows[0]).toEqual({ kind: "separator", text: "Earlier exchanges cleared" })
    expect(rows.at(-1)).toEqual({ kind: "answer", text: "answer" })
  })

  test("App Server failures use fixed recovery copy", () => {
    expect(appServerFailureMessage(64)).toBe(
      "App Server did not start · nothing saved · ^X G opens engine setting",
    )
    expect(appServerFailureMessage(66)).toBe(
      "App Server stopped safely · nothing saved · ^X G opens engine setting",
    )
    expect(appServerFailureMessage(69)).toContain(
      "could not resume this saved chat",
    )
  })

  test("rejects provider output beyond the raw byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5))
        controller.enqueue(new Uint8Array(6))
        controller.close()
      },
    })
    await expect(readBounded(stream, 10)).rejects.toThrow("size limit")
    expect(
      parseProviderResponse(
        '{"t":"delta","text":"must stay invalid"}\n' +
          '{"tldr":"safe","corrected_command":"pwd","confidence":1,"risk":"low"}',
      ),
    ).toBeNull()
  })

  test("frames Ask previews on raw LF bytes and preserves the final bytes", async () => {
    const encoder = new TextEncoder()
    const source = [
      encoder.encode('{"t":"delta","text":"split '),
      encoder.encode('🙂"}\n{"t":"note","text":"Searching the web"}\n{'),
      encoder.encode('\n  "answer": "final only"\n}'),
    ]
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of source) controller.enqueue(chunk)
        controller.close()
      },
    })
    const previews: unknown[] = []
    const raw = await readAskStream(stream, (event) => previews.push(event))

    expect(previews).toEqual([
      { t: "delta", text: "split 🙂" },
      { t: "note", text: "Searching the web" },
    ])
    expect(raw).toBe('{\n  "answer": "final only"\n}')
    expect(parseAskResponse(raw)).toEqual({ answer: "final only" })
  })

  test("suppresses JSON-like previews and rejects non-exact preview records", async () => {
    const payload = [
      '{"t":"delta","text":"```json\\n{\\\"answer\\\":\\\"leak\\\"}"}',
      '{"text":"wrong order is valid","t":"delta"}',
      '{"t":"delta","text":"extra","other":true}',
      '{"answer":"authoritative"}',
    ].join("\n")
    const stream = new Response(payload).body!
    const previews: unknown[] = []
    const raw = await readAskStream(stream, (event) => previews.push(event))

    expect(previews).toEqual([
      { t: "note", text: "Drafting the answer" },
      { t: "delta", text: "wrong order is valid" },
    ])
    expect(raw).toBe(
      '{"t":"delta","text":"extra","other":true}\n{"answer":"authoritative"}',
    )
    expect(parseAskResponse(raw)).toBeNull()
  })

  test("accepts trusted App Server answer records without weakening delta filtering", async () => {
    const answer = 'JSON {"key":"value"}\n```sh\nprintf ok\n```\n🙂'
    const payload =
      `${JSON.stringify({ t: "answer", text: answer })}\n` +
      '{"answer":"authoritative"}'
    const trusted: unknown[] = []
    const raw = await readAskStream(
      new Response(payload).body!,
      (event) => trusted.push(event),
      true,
    )
    expect(trusted).toEqual([{ t: "answer", text: answer }])
    expect(raw).toBe('{"answer":"authoritative"}')

    const untrusted: unknown[] = []
    expect(
      await readAskStream(new Response(payload).body!, (event) => {
        untrusted.push(event)
      }),
    ).toBe(payload)
    expect(untrusted).toEqual([])

    const encoded = new TextEncoder().encode(payload)
    const emoji = new TextEncoder().encode("🙂")
    const emojiStart = encoded.findIndex((byte, index) =>
      emoji.every((part, offset) => encoded[index + offset] === part),
    )
    const split: unknown[] = []
    const splitRaw = await readAskStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.slice(0, emojiStart + 2))
          controller.enqueue(encoded.slice(emojiStart + 2))
          controller.close()
        },
      }),
      (event) => split.push(event),
      true,
    )
    expect(split).toEqual([{ t: "answer", text: answer }])
    expect(splitRaw).toBe('{"answer":"authoritative"}')
  })

  test("bounds preview display input separately from the final response", async () => {
    const line = `${JSON.stringify({ t: "delta", text: "x".repeat(8000) })}\n`
    expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(8192)
    const count = Math.ceil(ASK_PREVIEW_INPUT_MAX_BYTES / line.length) + 2
    const stream = new Response(
      line.repeat(count) + '{"answer":"still valid"}',
    ).body!
    let previews = 0
    const raw = await readAskStream(stream, () => {
      previews += 1
    })

    expect(previews).toBeGreaterThan(0)
    expect(previews).toBeLessThan(count)
    expect(raw).toBe('{"answer":"still valid"}')
    expect(tailUtf8(`drop-${"🙂".repeat(3000)}`, ASK_ANSWER_MAX_BYTES)).toBe(
      "🙂".repeat(ASK_ANSWER_MAX_BYTES / 4),
    )
    const rendered = appendAskPreview(
      { note: "", text: "x".repeat(ASK_ANSWER_MAX_BYTES), thinking: "" },
      { t: "note", text: "Searching the web" },
    )
    expect(
      new TextEncoder().encode(`${rendered.text}\n${rendered.note}`).byteLength,
    ).toBe(ASK_ANSWER_MAX_BYTES)
  })

  test("treats invalid UTF-8 and an oversized candidate line as final bytes", async () => {
    const invalid = new Uint8Array([0xff, 10, 123, 125])
    const invalidRaw = await readAskStream(
      new ReadableStream({
        start(controller) {
          controller.enqueue(invalid)
          controller.close()
        },
      }),
      () => {
        throw new Error("invalid bytes cannot preview")
      },
    )
    expect(invalidRaw).toBe("�\n{}")

    const oversized = `${"x".repeat(8193)}\n{"answer":"ignored"}`
    expect(await readAskStream(new Response(oversized).body!, () => {})).toBe(
      oversized,
    )
  })

  test("accepts an exact-bound preview and rejects missing or truncated finals", async () => {
    const prefix = '{"t":"delta","text":"'
    const suffix = '"}'
    const exact = `${prefix}${"x".repeat(8192 - prefix.length - suffix.length)}${suffix}`
    expect(new TextEncoder().encode(exact).byteLength).toBe(8192)
    let previews = 0
    const raw = await readAskStream(
      new Response(`${exact}\n{"answer":"done"}`).body!,
      () => {
        previews += 1
      },
    )
    expect(previews).toBe(1)
    expect(parseAskResponse(raw)).toEqual({ answer: "done" })

    expect(
      await readAskStream(
        new Response('{"t":"note","text":"Drafting the answer"}\n').body!,
        () => {},
      ),
    ).toBe("")
    expect(
      parseAskResponse(
        await readAskStream(new Response('{"answer":').body!, () => {}),
      ),
    ).toBeNull()
  })

  test("keeps the existing final limit after any number of previews", async () => {
    const payload =
      '{"t":"note","text":"Calling a tool"}\n' +
      "x".repeat(65_537)
    await expect(
      readAskStream(new Response(payload).body!, () => {}),
    ).rejects.toThrow("size limit")
  })

  test("commits or discards only the staged Ask pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-pointer-test-"))
    const pointer = join(root, "session.json")
    const pending = `${pointer}.pending`
    try {
      writeFileSync(pointer, "old")
      writeFileSync(pending, "new")
      expect(finalizeAskSessionPointer(pointer, false)).toBe(false)
      expect(readFileSync(pointer, "utf8")).toBe("old")
      expect(() => readFileSync(pending)).toThrow()

      writeFileSync(pending, "new")
      expect(finalizeAskSessionPointer(pointer, true)).toBe(true)
      expect(readFileSync(pointer, "utf8")).toBe("new")
      expect(finalizeAskSessionPointer(pointer, true)).toBe(false)
      expect(readFileSync(pointer, "utf8")).toBe("new")

      symlinkSync(pointer, pending)
      expect(finalizeAskSessionPointer(pointer, true)).toBe(false)
      expect(readFileSync(pointer, "utf8")).toBe("new")
      expect(() => readFileSync(pending)).toThrow()
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test("validates and commits only one request-unique App Server candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-app-pointer-test-"))
    const pointer = join(root, "session.json")
    const first = appServerCandidateFile(pointer)
    const second = appServerCandidateFile(pointer)
    const invalid = appServerCandidateFile(pointer)
    const expected = { provider: "codex-app-server", cwd: "/tmp" } as const
    try {
      expect(first).not.toBe(second)
      expect(appServerPointerDecision(pointer, expected)).toEqual({
        kind: "missing",
      })
      writeFileSync(
        first,
        JSON.stringify({
          provider: "codex-app-server",
          session_id: "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
          cwd: "/tmp",
        }),
        { mode: 0o600 },
      )
      writeFileSync(
        second,
        JSON.stringify({
          provider: "codex-app-server",
          session_id: "019fd3fe-b1b0-71b0-9fba-38734709fed6",
          cwd: "/tmp",
        }),
        { mode: 0o600 },
      )
      writeFileSync(
        invalid,
        JSON.stringify({
          provider: "codex-app-server",
          session_id: "019fd3fe-b1b0-71b0-9fba-38734709fed6",
          cwd: "/tmp",
          extra: true,
        }),
        { mode: 0o600 },
      )
      expect(finalizeAskSessionPointer(pointer, true, invalid, expected)).toBe(
        false,
      )
      expect(readFileSync(first, "utf8")).toContain("019fd36e")
      expect(finalizeAskSessionPointer(pointer, true, first, expected)).toBe(
        true,
      )
      expect(readFileSync(second, "utf8")).toContain("019fd3fe")
      expect(finalizeAskSessionPointer(pointer, false, second, expected)).toBe(
        false,
      )
      expect(existsSync(second)).toBe(false)
      expect(readFileSync(pointer, "utf8")).toContain("019fd36e")
      expect(askChatWasSaved(pointer, expected)).toBe(true)
      expect(appServerPointerDecision(pointer, expected)).toEqual({
        kind: "valid",
        sessionId: "019fd36e-a83f-7ad3-ba25-243ea233e1f3",
      })
      writeFileSync(pointer, "broken")
      expect(appServerPointerDecision(pointer, expected)).toEqual({
        kind: "invalid",
      })
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })
})

describe("workbench presentation", () => {
  test("maps compact, reader, and details surfaces to 3, 8, and 12 rows", () => {
    const compact = {
      actionsOpen: false,
      composerLines: 1,
      editorMode: "composer",
      intent: "ask",
      phase: "ready",
      previewVisible: false,
      settingsOpen: false,
      view: "main",
    } as const

    expect(requestedFooterHeight(compact)).toBe(COMPACT_FOOTER_HEIGHT)
    for (const promoted of [
      { ...compact, actionsOpen: true },
      { ...compact, editorMode: "prompt" as const },
      { ...compact, editorMode: "command" as const },
      { ...compact, editorMode: "context" as const },
      { ...compact, phase: "candidate" as const },
      { ...compact, settingsOpen: true },
      { ...compact, previewVisible: true },
    ]) {
      expect(requestedFooterHeight(promoted)).toBe(READER_FOOTER_HEIGHT)
    }
    // Ask loading/streaming/answer use content-driven 4/8/12/16 sizing: an
    // empty envelope rests at the 4-row floor and the 8-row reader envelope
    // arrives with rendered content (spec: content-driven Ask sizing).
    expect(requestedFooterHeight({ ...compact, phase: "loading" })).toBe(4)
    expect(requestedFooterHeight({ ...compact, phase: "streaming" })).toBe(4)
    expect(
      requestedFooterHeight({ ...compact, phase: "streaming", askContentLines: 6 }),
    ).toBe(READER_FOOTER_HEIGHT)
    expect(requestedFooterHeight({ ...compact, phase: "answer" })).toBe(4)
    expect(
      requestedFooterHeight({ ...compact, phase: "answer", askContentLines: 6 }),
    ).toBe(READER_FOOTER_HEIGHT)
    // Only Ask loading promotes immediately; Command and Fix loading stay
    // compact until they produce a candidate.
    for (const intent of ["generate", "correct"] as const) {
      expect(
        requestedFooterHeight({ ...compact, intent, phase: "loading" }),
      ).toBe(COMPACT_FOOTER_HEIGHT)
    }
    // The preview promotes the footer the same way any other promoted
    // surface does, but composerLines growth is irrelevant once it does.
    expect(
      requestedFooterHeight({
        ...compact,
        composerLines: 20,
        previewVisible: true,
      }),
    ).toBe(READER_FOOTER_HEIGHT)
    expect(requestedFooterHeight({ ...compact, view: "details" })).toBe(
      DETAILS_FOOTER_HEIGHT,
    )
    expect(requestedFooterHeight({ ...compact, view: "doctor" })).toBe(
      DETAILS_FOOTER_HEIGHT,
    )
    // Settings never outranks the details view's taller inspector envelope.
    expect(
      requestedFooterHeight({
        ...compact,
        settingsOpen: true,
        view: "details",
      }),
    ).toBe(DETAILS_FOOTER_HEIGHT)

    // The compact frame grows by exactly one row per additional composer
    // visual line, capped at the eight-row envelope, and a promoted surface
    // ignores composerLines entirely.
    expect(requestedFooterHeight({ ...compact, composerLines: 3 })).toBe(5)
    expect(requestedFooterHeight({ ...compact, composerLines: 6 })).toBe(8)
    expect(requestedFooterHeight({ ...compact, composerLines: 20 })).toBe(8)
    expect(
      requestedFooterHeight({
        ...compact,
        composerLines: 20,
        phase: "candidate",
      }),
    ).toBe(READER_FOOTER_HEIGHT)
  })

  test("captures four bounded Doctor rows and honest local statuses", () => {
    const root = mkdtempSync(join(tmpdir(), "shellq-doctor-rows-"))
    try {
      const base = {
        cwd: root,
        providerId: "codex",
        providerSource: "default",
        providerAvailable: true,
        adapterAvailable: true,
        pointer: null,
        pointerRequired: false,
        pointerWillStartNew: false,
      } as const
      const rows = captureDoctorRows({ ...base, settings: { kind: "missing" } })
      expect(rows).toHaveLength(4)
      expect(rows.map((row) => row.key)).toEqual([
        "PASS cwd",
        "PASS provider",
        "PASS settings",
        "PASS Ask pointer",
      ])
      expect(metadataWindow('"long value"', 2, 8, false)).toContain("<")
      expect(metadataWindow('"long value"', 0, 8, false)).toContain(">")
      for (const width of SUPPORTED_WIDTHS) {
        const layout = frameLayout(width)
        const keyWidth = Math.max(...rows.map((row) => terminalWidth(row.key))) + 2
        const valueWidth = Math.max(4, layout.interior - keyWidth - 3)
        for (const row of rows) {
          expect(
            terminalWidth(`${row.key.padEnd(keyWidth)} : ${metadataWindow(row.value, 0, valueWidth, false)}`),
          ).toBeLessThanOrEqual(layout.interior)
        }
      }

      const validV2 = {
        kind: "valid" as const,
        sourceVersion: 2,
        document: {
          version: 2 as const,
          provider: "codex" as const,
          providers: { codex: { model: "gpt-5.6-luna", reasoning: "low" } },
        },
      }
      const validV1 = { ...validV2, sourceVersion: 1 }
      const validPointer = {
        kind: "valid" as const,
        sessionId: "11111111-1111-4111-8111-111111111111",
      }
      const cases = [
        {
          name: "configured provider",
          input: { ...base, providerSource: "configured" as const },
          expected: "WARN provider",
        },
        {
          name: "unavailable provider",
          input: { ...base, providerAvailable: false },
          expected: "FAIL provider",
        },
        {
          name: "unavailable adapter",
          input: { ...base, adapterAvailable: false },
          expected: "FAIL provider",
        },
        { name: "settings v2", input: base, settings: validV2, expected: "PASS settings" },
        { name: "settings v1", input: base, settings: validV1, expected: "WARN settings" },
        { name: "settings invalid", input: base, settings: { kind: "invalid" as const }, expected: "WARN settings" },
        {
          name: "settings operational error",
          input: base,
          settings: { kind: "operational-error" as const, error: new Error("nope") },
          expected: "WARN settings",
        },
        {
          name: "valid pointer",
          input: { ...base, pointer: validPointer, pointerRequired: true },
          expected: "PASS Ask pointer",
        },
        {
          name: "invalid pointer with explicit new chat",
          input: {
            ...base,
            pointer: { kind: "invalid" as const },
            pointerRequired: true,
            pointerWillStartNew: true,
          },
          expected: "WARN Ask pointer",
        },
        {
          name: "invalid pointer Exec automatic-new",
          input: {
            ...base,
            pointer: { kind: "invalid" as const },
            pointerRequired: true,
            pointerWillStartNew: true,
          },
          expected: "WARN Ask pointer",
        },
        {
          name: "invalid pointer App Server/Claude blocking",
          input: { ...base, pointer: { kind: "invalid" as const }, pointerRequired: true },
          expected: "FAIL Ask pointer",
        },
      ]
      for (const item of cases) {
        const result = captureDoctorRows({
          ...item.input,
          settings: item.settings ?? { kind: "missing" },
        })
        expect(result.map((row) => row.key), item.name).toContain(item.expected)
      }
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  test("labels candidate insertion as review-only, with no routine label", () => {
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: false,
        phase: "candidate",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("Enter insert (never runs)")

    // Every ordinary resting state shows no action at all — there is no
    // routine "Enter ask" / "Enter generate" / "Enter fix" / "Enter follow
    // up" label any more.
    for (const phase of ["ready", "answer"] as const) {
      expect(
        contextualAction({
          actionsOpen: false,
          editorMode: "view",
          insertActionTaught: false,
          phase,
          settingsOpen: false,
          view: "main",
        }),
      ).toBe("")
    }
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "composer",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("")
    expect(
      contextualAction({
        actionsOpen: true,
        editorMode: "view",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("Esc back")
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "prompt",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("^X W save")
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "command",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("^X W save")
    for (const phase of ["loading", "streaming"] as const) {
      expect(
        contextualAction({
          actionsOpen: false,
          editorMode: "view",
          insertActionTaught: false,
          phase,
          settingsOpen: false,
          view: "main",
        }),
      ).toBe("Esc cancel")
    }
    for (const phase of ["failed", "cancelled"] as const) {
      expect(
        contextualAction({
          actionsOpen: false,
          editorMode: "composer",
          insertActionTaught: false,
          phase,
          settingsOpen: false,
          view: "main",
        }),
      ).toBe("Enter retry")
    }
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: false,
        view: "details",
      }),
    ).toBe("Esc back")
    // Settings itself is one more surface `Esc back` must cover.
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: true,
        view: "main",
      }),
    ).toBe("Esc back")
  })

  test("the insertion action teaches once: full text untaught, short text once taught", () => {
    // Item 4: exactly one boolean gates the whole message. Untaught shows
    // the full atomic hint; taught shows the short one. Neither form is
    // reachable by anything but `phase === "candidate"` with no higher-
    // precedence surface open — same precedence as the untaught case above.
    expect(
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: true,
        phase: "candidate",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("↵ insert")
    // A higher-precedence surface still wins regardless of `insertActionTaught`.
    expect(
      contextualAction({
        actionsOpen: true,
        editorMode: "view",
        insertActionTaught: true,
        phase: "candidate",
        settingsOpen: false,
        view: "main",
      }),
    ).toBe("Esc back")
  })

  test("keeps every row inside the frame width at 80, 100, and 140", () => {
    for (const width of SUPPORTED_WIDTHS) {
      const layout = frameLayout(width)
      expect(layout.interior).toBe(width - 4)
      expect(layout.composer).toBe(layout.interior - 2)

      // The command row is the only content allowed two rows, and it must
      // still fit the frame rather than wrap the footer past 12 rows.
      const lines = commandLines("git ".repeat(400), layout.interior)
      expect(lines).toHaveLength(2)
      for (const line of lines) {
        expect(terminalWidth(line)).toBeLessThanOrEqual(layout.interior)
      }
      expect(
        terminalWidth(truncateCells("🙂".repeat(100), layout.interior)),
      ).toBeLessThanOrEqual(layout.interior)

      for (const unicode of [true, false]) {
        const tabs = modeTabsLine("generate", layout.titleBudget, unicode)
        expect(terminalWidth(tabs)).toBeLessThanOrEqual(layout.titleBudget)
        expect(tabs).toContain("[Command]")
        expect(tabs).toContain("Ask")
        expect(tabs).toContain("Fix")
        if (!unicode) expect(tabs).not.toMatch(/[^\x00-\x7f]/u)

        const top = topRailLine(
          { intent: "generate", model: "gpt-5.3-codex-spark", reasoning: "low" },
          layout.titleBudget,
          unicode,
        )
        expect(terminalWidth(top)).toBeLessThanOrEqual(layout.titleBudget)
        expect(top).toContain(tabs)
        expect(top).toContain("Spark")

        const bottom = bottomRailLine(
          {
            action: "",
            contextBytes: 2100,
            cwd: HOME_CWD,
            included: true,
            message: null,
          },
          layout.titleBudget,
          unicode,
        )
        expect(terminalWidth(bottom)).toBeLessThanOrEqual(layout.titleBudget)
        expect(bottom).toContain("shellq")

        const withMessage = bottomRailLine(
          {
            action: "",
            contextBytes: 2100,
            cwd: HOME_CWD,
            included: true,
            message: "output included in the next request",
          },
          layout.titleBudget,
          unicode,
        )
        expect(terminalWidth(withMessage)).toBeLessThanOrEqual(layout.titleBudget)
      }
    }

    expect(COMPACT_FOOTER_HEIGHT).toBe(3)
    expect(READER_FOOTER_HEIGHT).toBe(8)
    expect(DETAILS_FOOTER_HEIGHT).toBe(12)
    expect(frameLayout(80).density).toBe<Density>("narrow")
    expect(frameLayout(100).density).toBe<Density>("medium")
    expect(frameLayout(140).density).toBe<Density>("wide")
    expect(truncateCells("abcdef", 4)).toBe("abc…")
    expect(commandLines("printf safe\nrm -f important", 80)[0]).toContain("↵")
    expect(visibleShellText("echo ‮unsafe")).toContain("\\u{202e}")
  })

  test("marks the selected mode with brackets and stays ASCII-safe when narrow", () => {
    expect(modeTabsLine("ask", 80, true)).toBe("[Ask] · Command · Fix")
    expect(modeTabsLine("generate", 80, true)).toBe("Ask · [Command] · Fix")
    expect(modeTabsLine("correct", 80, true)).toBe("Ask · Command · [Fix]")
    expect(modeTabsLine("ask", 80, false)).toBe("[Ask] | Command | Fix")

    // A width too narrow to fit the full strip must still contain no byte
    // above 0x7f - a plain cell slice rather than truncateCells' ellipsis.
    const narrowAscii = modeTabsLine("correct", 6, false)
    expect(narrowAscii).not.toMatch(/[^\x00-\x7f]/u)
    expect(terminalWidth(narrowAscii)).toBeLessThanOrEqual(6)
  })

  test("builds the rail chassis with safe Unicode seams and an ASCII fallback", () => {
    expect(railGlyphs(true)).toEqual({
      bottomLeft: "╰",
      bottomRight: "╯",
      horizontal: "─",
      topLeft: "╭",
      topRight: "╮",
      vertical: "│",
    })
    expect(railGlyphs(false)).toEqual({
      bottomLeft: "+",
      bottomRight: "+",
      horizontal: "-",
      topLeft: "+",
      topRight: "+",
      vertical: "|",
    })
    for (const glyph of Object.values(railGlyphs(false))) {
      expect(glyph.codePointAt(0)!).toBeLessThan(0x80)
    }
    for (const glyph of Object.values(railGlyphs(true))) {
      const codePoint = glyph.codePointAt(0)!
      expect(codePoint < 0xe000 || codePoint > 0xf8ff).toBe(true)
    }
  })

  test("fills the top border with the border glyph, never a space, between tabs and the model range", () => {
    // Item: space padding is forbidden — it blanks the border. The fill
    // between the mode tabs and the right-aligned model/reasoning range must
    // be built from `railGlyphs(unicode).horizontal`, and the joined text
    // must span the whole budget with no bare space run doing the job.
    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget
      for (const unicode of [true, false]) {
        const { text } = topRail(
          { intent: "generate", model: "gpt-5.3-codex-spark", reasoning: "low" },
          budget,
          unicode,
        )
        expect(terminalWidth(text)).toBe(budget)
        const glyph = railGlyphs(unicode).horizontal
        const fillRun = glyph.repeat(8)
        expect(text).toContain(fillRun)
        // No space run wide enough to look like a blanked border gap.
        expect(text).not.toMatch(/ {2,}/)
        expect(text.endsWith("low")).toBe(true)
      }
    }
  })

  test("fills the bottom border with the border glyph, never a space, between the left group and the action range", () => {
    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget
      for (const unicode of [true, false]) {
        const { text } = bottomRail(
          {
            action: "",
            contextBytes: 2100,
            cwd: HOME_CWD,
            included: false,
            message: null,
          },
          budget,
          unicode,
        )
        expect(terminalWidth(text)).toBe(budget)
        const glyph = railGlyphs(unicode).horizontal
        expect(text).toContain(glyph.repeat(8))
        expect(text).not.toMatch(/ {2,}/)
        expect(text.endsWith("actions")).toBe(true)
      }
    }
  })

  test("keeps model as the top rail's anchor and ^X as the bottom rail's anchor", () => {
    // Model/reasoning moved to the top border (item 1); cwd and `^X` stay
    // the bottom border's anchors — contextual segments drop before either.
    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget
      const top = topRailLine(
        { intent: "generate", model: "gpt-5.3-codex-spark", reasoning: "low" },
        budget,
        true,
      )
      expect(top).toContain("Spark")

      const bottom = bottomRailLine(
        {
          action: "",
          contextBytes: 0,
          cwd: HOME_CWD,
          included: false,
          message: null,
        },
        budget,
        true,
      )
      expect(bottom).toContain("shellq")
      expect(bottom).toContain("^X")
    }
  })

  test("the bottom rail's left slot shows cwd by default and yields entirely to a caller-supplied message", () => {
    // Item 2: the two are mutually exclusive — never a concatenation of cwd
    // and the message. `bottomRail` itself does not decide when the message
    // clears; it only ever renders whatever the caller currently passes.
    const budget = frameLayout(140).titleBudget
    const withCwd = bottomRail(
      {
        action: "",
        contextBytes: 0,
        cwd: HOME_CWD,
        included: false,
        message: null,
      },
      budget,
      true,
    )
    expect(withCwd.text).toContain("~/Projects/shellq")

    const withMessage = bottomRail(
      {
        action: "",
        contextBytes: 0,
        cwd: HOME_CWD,
        included: false,
        message: "provider exited 1: connection refused",
      },
      budget,
      true,
    )
    expect(withMessage.text).toContain("provider exited 1: connection refused")
    expect(withMessage.text).not.toContain("shellq")
  })

  test("keeps the contextual action visible when contextual state drops", () => {
    // The action is an anchor, not a contextual segment: hiding it would take
    // `never runs` off an insertion action, which is a safety label.
    const crowded = {
      action: "Enter insert (never runs)",
      contextBytes: 4200,
      cwd: `/Users/dev/${"deeply/nested/".repeat(12)}project`,
      included: true,
      message: "the provider returned a materially different command",
    }

    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget
      const line = bottomRailLine(crowded, budget, true)
      expect(terminalWidth(line)).toBeLessThanOrEqual(budget)
      expect(line).toContain("Enter insert (never runs)")
      expect(line).toContain("^X")
      // The crowding pressure at narrow width really did clip the
      // lower-priority message down to its 16-cell cap (unlike the retired
      // note slot, the new four-rung ladder never drops the message outright
      // — only the disclosure and `^X` can vanish entirely).
      if (width === 80) {
        expect(line).not.toContain("materially different command")
        expect(line).toContain("…")
      }
    }

    // Ordinary resting states carry no action at all.
    expect(
      bottomRailLine(
        { ...crowded, action: "", cwd: "/tmp", message: null },
        frameLayout(100).titleBudget,
        true,
      ),
    ).not.toContain("Enter")
  })

  test("reports captured output in human transmission terms", () => {
    expect(formatBytes(2100)).toBe("2.1k")
    expect(formatBytes(500)).toBe("500b")
    // Held back never shows a byte count — only the attached state does,
    // since that is also the only state where the count changes what a
    // click (detach) would do.
    expect(transmissionLabel(2100, false)).toBe("Attach output")
    expect(transmissionLabel(2100, true)).toBe("Output attached (~600 tokens)")
  })

  test("omits the disclosure when there is nothing captured, on a resting rail", () => {
    const idle = bottomRailLine(
      {
        action: "",
        contextBytes: 0,
        cwd: HOME_CWD,
        included: false,
        message: null,
      },
      140,
      true,
    )
    expect(idle).not.toContain("Attach output")
    expect(idle).not.toContain("Output attached")
    expect(idle).toContain("shellq")
    expect(idle).toContain("^X actions")

    // The note slot itself (candidate position, exit status, saved-chat,
    // `ro`) is retired outright (item 3) — `bottomRail` never emits any of
    // that text because it no longer accepts the inputs that used to
    // produce it.
    expect(idle).not.toMatch(/\bro\b/)
    expect(idle).not.toContain("chat saved")
    expect(idle).not.toMatch(/\d\/\d/)
  })

  test("reproduces the split rail grammar verbatim at 80/100/140 across resting, loading, candidate, editing, failed, cancelled, and sheet-open", () => {
    // Every case shares the ladder's fixed inputs: cwd `~/Projects/shellq`,
    // model `Spark`, reasoning `low`, 2100 captured bytes. Each row is
    // measured directly from `topRail`/`bottomRail`, the same functions the
    // UI calls, reproduced exactly. `candidate-first` vs `candidate-later`
    // pins the teach-once collapse (item 4): identical state except
    // `insertActionTaught`, and only the action text differs.
    const cwd = HOME_CWD
    const top = (intent: SessionIntent) =>
      ({ intent, model: "gpt-5.3-codex-spark", reasoning: "low" }) as TopRailState

    const cases: {
      name: string
      top: TopRailState
      bottom: BottomRailState
      topWidths: Record<number, string>
      bottomWidths: Record<number, string>
    }[] = [
      {
        name: "resting",
        top: top("generate"),
        bottom: {
          action: "",
          contextBytes: 2100,
          cwd,
          included: false,
          message: null,
        },
        topWidths: {
          80: "Ask · [Command] · Fix────────────────────────────────────────────Spark · low",
          100: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Attach output \u00b7 ^X actions",
          100: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Attach output \u00b7 ^X actions",
          140: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Attach output \u00b7 ^X actions",
        },
      },
      {
        name: "loading (first request in this workbench)",
        top: top("generate"),
        bottom: {
          action: "Esc cancel",
          contextBytes: 2100,
          cwd,
          included: false,
          message: "loading",
        },
        topWidths: {
          80: "Ask · [Command] · Fix────────────────────────────────────────────Spark · low",
          100: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "loading\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Esc cancel \u00b7 Attach output \u00b7 ^X actions",
          100: "loading\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Esc cancel \u00b7 Attach output \u00b7 ^X actions",
          140: "loading\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Esc cancel \u00b7 Attach output \u00b7 ^X actions",
        },
      },
      {
        name: "candidate-first (untaught: full insertion hint)",
        top: top("generate"),
        bottom: {
          action: "Enter insert (never runs)",
          contextBytes: 2100,
          cwd,
          included: true,
          message: null,
        },
        topWidths: {
          80: "Ask · [Command] · Fix────────────────────────────────────────────Spark · low",
          100: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "\u2026/shellq\u2500\u2500\u2500\u2500\u2500\u2500Enter insert (never runs) \u00b7 Output attached (~600 tokens) \u00b7 ^X",
          100: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Enter insert (never runs) \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          140: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Enter insert (never runs) \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
        },
      },
      {
        name: "candidate-later (taught: short insertion hint)",
        top: top("generate"),
        bottom: {
          action: "↵ insert",
          contextBytes: 2100,
          cwd,
          included: true,
          message: null,
        },
        topWidths: {
          80: "Ask · [Command] · Fix────────────────────────────────────────────Spark · low",
          100: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u21b5 insert \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          100: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u21b5 insert \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          140: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u21b5 insert \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
        },
      },
      {
        name: "editing (Ctrl-X W save is the anchored action)",
        top: top("generate"),
        bottom: {
          action: "^X W save",
          contextBytes: 2100,
          cwd,
          included: true,
          message: null,
        },
        topWidths: {
          80: "Ask · [Command] · Fix────────────────────────────────────────────Spark · low",
          100: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500^X W save \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          100: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500^X W save \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          140: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500^X W save \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
        },
      },
      {
        name: "failed",
        top: top("correct"),
        bottom: {
          action: "Enter retry",
          contextBytes: 2100,
          cwd,
          included: true,
          message: "provider exited 1: connection refused",
        },
        topWidths: {
          80: "Ask · Command · [Fix]────────────────────────────────────────────Spark · low",
          100: "Ask · Command · [Fix]────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · Command · [Fix]────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "provider exited 1: conn\u2026\u2500\u2500\u2500\u2500Enter retry \u00b7 Output attached (~600 tokens) \u00b7 ^X",
          100: "provider exited 1: connection refused\u2500\u2500\u2500Enter retry \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          140: "provider exited 1: connection refused\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Enter retry \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
        },
      },
      {
        name: "cancelled",
        top: top("correct"),
        bottom: {
          action: "Enter retry",
          contextBytes: 2100,
          cwd,
          included: true,
          message: "the workbench stayed open and kept every earlier suggestion",
        },
        topWidths: {
          80: "Ask · Command · [Fix]────────────────────────────────────────────Spark · low",
          100: "Ask · Command · [Fix]────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · Command · [Fix]────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "the workbench stayed op\u2026\u2500\u2500\u2500\u2500Enter retry \u00b7 Output attached (~600 tokens) \u00b7 ^X",
          100: "the workbench stayed open and kept ever\u2026Enter retry \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          140: "the workbench stayed open and kept every earlier suggestion\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Enter retry \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
        },
      },
      {
        name: "sheet-open",
        top: top("generate"),
        bottom: {
          action: "Esc back",
          contextBytes: 2100,
          cwd,
          included: true,
          message: null,
        },
        topWidths: {
          80: "Ask · [Command] · Fix────────────────────────────────────────────Spark · low",
          100: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────Spark · low",
          140: "Ask · [Command] · Fix────────────────────────────────────────────────────────────────────────────────────────────────────────Spark · low",
        },
        bottomWidths: {
          80: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500Esc back \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          100: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Esc back \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
          140: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Esc back \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
        },
      },
    ]

    for (const { top: topState, bottom: bottomState, topWidths, bottomWidths } of cases) {
      for (const width of SUPPORTED_WIDTHS) {
        const budget = frameLayout(width).titleBudget
        const topLine = topRailLine(topState, budget, true)
        expect(topLine).toBe(topWidths[width])
        expect(terminalWidth(topLine)).toBeLessThanOrEqual(budget)

        const bottomLine = bottomRailLine(bottomState, budget, true)
        expect(bottomLine).toBe(bottomWidths[width])
        expect(terminalWidth(bottomLine)).toBeLessThanOrEqual(budget)
      }
    }
  })

  test("reproduces the ASCII fallback of both borders verbatim at 80/100/140", () => {
    const cwd = HOME_CWD
    const topExpected: Record<number, string> = {
      80: "Ask | [Command] | Fix--------------------------------------------Spark | low",
      100: "Ask | [Command] | Fix----------------------------------------------------------------Spark | low",
      140: "Ask | [Command] | Fix--------------------------------------------------------------------------------------------------------Spark | low",
    }
    const bottomExpected: Record<number, string> = {
      80: "~/Projects/shellq---------------------------------Attach output · ^X actions",
      100: "~/Projects/shellq-----------------------------------------------------Attach output · ^X actions",
      140: "~/Projects/shellq---------------------------------------------------------------------------------------------Attach output · ^X actions",
    }
    const bottomActionExpected: Record<number, string> = {
      80: "\u2026/shellq------Enter insert (never runs) \u00b7 Output attached (~600 tokens) \u00b7 ^X",
      100: "~/Projects/shellq---------Enter insert (never runs) \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
      140: "~/Projects/shellq-------------------------------------------------Enter insert (never runs) \u00b7 Output attached (~600 tokens) \u00b7 ^X actions",
    }

    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget

      const topLine = topRailLine(
        { intent: "generate", model: "gpt-5.3-codex-spark", reasoning: "low" },
        budget,
        false,
      )
      expect(topLine).toBe(topExpected[width])
      expect(topLine).not.toMatch(/[^\x00-\x7f]/u)

      const restingBottom = bottomRailLine(
        { action: "", contextBytes: 2100, cwd, included: false, message: null },
        budget,
        false,
      )
      expect(restingBottom).toBe(bottomExpected[width])
      // `·` is the same universal separator the rest of the rail chassis
      // uses regardless of `unicode` (see `actionsSheetLines`'s own ASCII
      // fallback test) — deliberately not part of this fallback, so it is
      // excluded from the byte-range assertion below.
      for (const char of restingBottom.replace(/·/gu, "")) {
        expect(char.codePointAt(0)!).toBeLessThan(0x80)
      }

      const withAction = bottomRailLine(
        {
          action: "Enter insert (never runs)",
          contextBytes: 2100,
          cwd,
          included: true,
          message: null,
        },
        budget,
        false,
      )
      expect(withAction).toBe(bottomActionExpected[width])
      expect(withAction).toContain("Enter insert (never runs)")
    }
  })

  test("the reverse restore pass closes the over-drop a purely greedy ladder would leave", () => {
    // The measured defect: at 80 columns with this cwd and disclosure, a
    // purely greedy forward ladder fires every rung down through dropping
    // the message entirely and leaves cells of wasted border fill, with the
    // message gone even though undoing a rung would have bought back the
    // exact slack that overshoot needed. The message and action strings are
    // synthetic (`n`/`a` repeats) specifically to make their cell counts
    // obvious in this comment; only their lengths matter to the ladder.
    const budget = frameLayout(80).titleBudget
    expect(budget).toBe(76)
    const state: BottomRailState = {
      action: "a".repeat(20),
      contextBytes: 97,
      cwd: join(HOME_CWD, "spikes", "shellq"),
      included: false,
      message: "n".repeat(8),
    }
    const line = bottomRailLine(state, budget, true)
    // The fixed ladder recovers the disclosure a one-shot forward pass would
    // have dropped, landing exactly at budget — zero wasted cells.
    expect(line).toBe(
      "nnnnnnnn───────────────────aaaaaaaaaaaaaaaaaaaa · Attach output · ^X actions",
    )
    expect(terminalWidth(line)).toBe(budget)
    expect(line).toContain(state.action)
  })

  test("keeps `never runs` intact and indivisible below the supported widths", () => {
    const state: BottomRailState = {
      action: "Enter insert (never runs)",
      contextBytes: 2100,
      cwd: HOME_CWD,
      included: true,
      message: null,
    }
    // The reverse restore pass reclaims slack a purely greedy ladder would
    // have wasted, same discipline as the retired single-line rail.
    const expected: Record<number, string> = {
      40: "…/shellq───Enter insert (never runs)",
      50: "…/shellqEnter insert (never runs) · ^X actions",
      60: "~/Projects/shellq─Enter insert (never runs) · ^X actions",
      70: "~/Projects/shellq\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500Enter insert (never runs) \u00b7 ^X actions",
    }
    for (const [width, text] of Object.entries(expected)) {
      const budget = frameLayout(Number(width)).titleBudget
      const line = bottomRailLine(state, budget, true)
      expect(line).toBe(text)
      expect(line).toContain("Enter insert (never runs)")
      expect(terminalWidth(line)).toBeLessThanOrEqual(budget)
    }
  })

  test("drops `^X` only when there is a shown action to protect", () => {
    // The new four-rung ladder's last rung is conditional: with no action
    // to protect, `^X` is never dropped by the ladder and survives even
    // under real width pressure. With an action present, the same rung
    // fires and clears the entire span so the action gets the room instead.
    const cwd = join(HOME_CWD, "spikes", "shellq")
    for (const width of [30, 20, 15]) {
      const r = bottomRail(
        { action: "", contextBytes: 2100, cwd, included: false, message: null },
        width,
        true,
      )
      // Either form counts: at some widths the disclosure drops first and
      // the restore pass puts the long `^X actions` back. What this pins is
      // that the keys token itself is never dropped with no action to protect.
      expect(r.text).toMatch(/\^X( actions)?$/u)
      expect(r.spans.ctrlX).not.toBeNull()
      expect(terminalWidth(r.text)).toBeLessThanOrEqual(width)
    }

    const protectedAction = bottomRail(
      { action: "a".repeat(20), contextBytes: 2100, cwd, included: false, message: null },
      30,
      true,
    )
    expect(protectedAction.spans.ctrlX).toBeNull()
    expect(protectedAction.text).toContain("a".repeat(20))
    expect(protectedAction.spans.action).not.toBeNull()
  })

  test("railCwd substitutes the home directory and truncates the prefix", () => {
    const home = homedir()
    expect(railCwd(home, 40)).toBe("~")
    expect(railCwd(`${home}/Projects/shellq`, 40)).toBe("~/Projects/shellq")
    expect(railCwd(`${home}/Projects/shellq`, 8)).toBe(
      truncateCells("~/Projects/shellq", 8),
    )
    expect(railCwd("/tmp/outside-home", 40)).toBe("/tmp/outside-home")
  })

  test("modeTabs spans point at each tab's exact text, current tab included", () => {
    const labels: Record<SessionIntent, string> = {
      ask: "Ask",
      correct: "Fix",
      generate: "Command",
    }
    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget
      for (const intent of ["ask", "generate", "correct"] as const) {
        const { spans, text } = modeTabs(intent, budget, true)
        for (const target of ["ask", "generate", "correct"] as const) {
          const span = spans[target]
          const slice = [...text].slice(span.start, span.end).join("")
          expect(slice).toBe(
            target === intent ? `[${labels[target]}]` : labels[target],
          )
        }
      }
    }
  })

  test("topRail spans point only at each mode tab, the model, and reasoning", () => {
    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget
      for (const intent of ["ask", "generate", "correct"] as const) {
        const { spans, text } = topRail(
          { intent, model: "gpt-5.3-codex-spark", reasoning: "low" },
          budget,
          true,
        )
        const chars = [...text]
        // Cross-checked against `modeTabs` itself: the top rail's mode spans
        // must never drift from the tabs it embeds.
        const tabs = modeTabs(intent, budget, true)
        expect(spans.mode).toEqual(tabs.spans)

        expect(spans.model).not.toBeNull()
        const modelSlice = chars
          .slice(spans.model!.start, spans.model!.end)
          .join("")
        expect(modelSlice).toBe("Spark")
        expect(spans.reasoning).not.toBeNull()
        const reasoningSlice = chars
          .slice(spans.reasoning!.start, spans.reasoning!.end)
          .join("")
        expect(reasoningSlice).toBe("low")
        // The model/reasoning range is flush against the right corner: its
        // span always ends at the visible text's own length.
        expect(spans.reasoning!.end).toBe(chars.length)
      }
    }

    // At a width where reasoning is dropped but the model survives, its
    // span is null while the model's is not.
    const reasoningDropped = topRail(
      { intent: "generate", model: "gpt-5.3-codex-spark", reasoning: "medium" },
      32,
      true,
    )
    expect(reasoningDropped.spans.reasoning).toBeNull()
    expect(reasoningDropped.spans.model).not.toBeNull()

    // At a width where the model is dropped too, both are null — a caller
    // must never dereference a range that no longer exists on the border.
    const modelDropped = topRail(
      { intent: "generate", model: "gpt-5.3-codex-spark", reasoning: "medium" },
      22,
      true,
    )
    expect(modelDropped.spans.model).toBeNull()
    expect(modelDropped.spans.reasoning).toBeNull()
  })

  test("bottomRail spans point only at disclosure, the action, and Ctrl-X", () => {
    const base: BottomRailState = {
      action: "",
      contextBytes: 2100,
      cwd: HOME_CWD,
      included: false,
      message: null,
    }
    const budget = frameLayout(140).titleBudget
    const slice = (text: string, span: { end: number; start: number }) =>
      [...text].slice(span.start, span.end).join("")

    for (const included of [false, true]) {
      const { spans, text } = bottomRail({ ...base, included }, budget, true)
      expect(spans.disclosure).not.toBeNull()
      expect(slice(text, spans.disclosure!)).toBe(
        included ? "Output attached (~600 tokens)" : "Attach output",
      )
      expect(spans.ctrlX).not.toBeNull()
      const ctrlXSlice = slice(text, spans.ctrlX!)
      expect(ctrlXSlice.startsWith("^X")).toBe(true)
      expect(spans.ctrlX!.end).toBe([...text].length)
    }

    // With no captured bytes there is nothing to disclose and nothing to
    // click — a null span, never a zero-width one a hit test could still
    // land inside.
    expect(bottomRail({ ...base, contextBytes: 0 }, budget, true).spans.disclosure).toBeNull()

    for (const action of ["Esc back", "^X W save", "Enter insert (never runs)", "↵ insert"]) {
      const { spans, text } = bottomRail({ ...base, action }, budget, true)
      expect(spans.action).not.toBeNull()
      expect(slice(text, spans.action!)).toBe(action)
    }

    // No action, no span. The UI decides which actions a pointer may reach;
    // this only guarantees the range it hit-tests against is the real token.
    expect(bottomRail(base, budget, true).spans.action).toBeNull()

    // Severe width pressure with no action to protect: `^X` still gets a
    // span (see "drops `^X` only when there is a shown action to protect"),
    // but this pins the null case once an action forces it out entirely.
    const noRoom = bottomRail(
      { ...base, action: "a".repeat(20) },
      30,
      true,
    )
    expect(noRoom.spans.ctrlX).toBeNull()
  })

  test("the right group is `[action ·] disclosure · keys`, with the disclosure anchored beside the keys either way", () => {
    const cwd = HOME_CWD
    for (const width of SUPPORTED_WIDTHS) {
      const budget = frameLayout(width).titleBudget

      // No action: disclosure sits directly ahead of the keys, and nothing
      // survives in the left group but cwd.
      const resting = bottomRail(
        { action: "", contextBytes: 2100, cwd, included: true, message: null },
        budget,
        true,
      )
      expect(resting.text).toMatch(
        /^~\/Projects\/shellq[─]+Output attached \(~600 tokens\) · \^X actions$/u,
      )
      const slice = (text: string, span: { end: number; start: number }) =>
        [...text].slice(span.start, span.end).join("")
      expect(resting.spans.disclosure).not.toBeNull()
      expect(slice(resting.text, resting.spans.disclosure!)).toBe(
        "Output attached (~600 tokens)",
      )
      // Disclosure ends exactly where ` · ^X actions` begins.
      expect(resting.spans.disclosure!.end + terminalWidth(" · ")).toBe(
        resting.spans.ctrlX!.start,
      )

      // With an action: disclosure is still the token immediately left of
      // the keys — now after the action and its own separator — so its
      // position moves only because the action pushed in ahead of it, never
      // because the grammar itself changed.
      const withAction = bottomRail(
        { action: "Esc back", contextBytes: 2100, cwd, included: true, message: null },
        budget,
        true,
      )
      expect(withAction.text).toMatch(
        /^~\/Projects\/shellq[─]+Esc back · Output attached \(~600 tokens\) · \^X actions$/u,
      )
      expect(withAction.spans.disclosure).not.toBeNull()
      expect(slice(withAction.text, withAction.spans.disclosure!)).toBe(
        "Output attached (~600 tokens)",
      )
      expect(withAction.spans.action!.end + terminalWidth(" · ")).toBe(
        withAction.spans.disclosure!.start,
      )
      expect(withAction.spans.disclosure!.end + terminalWidth(" · ")).toBe(
        withAction.spans.ctrlX!.start,
      )

      // The left group is cwd alone now — never cwd-plus-disclosure.
      expect(resting.text.startsWith(`${railCwd(cwd, 40)}${railGlyphs(true).horizontal}`)).toBe(
        true,
      )
    }
  })

  test("only dismissive rail actions are pointer-reachable", () => {
    // The safety rule that keeps `never runs` meaningful: a click must never
    // insert, submit, or cancel. `contextualAction` can return six non-empty
    // strings; exactly two of them may be reached by pointer, and the four
    // that act on the shell or the provider must not be.
    // Asserted against the shipped constant the UI hit-tests with, not a copy
    // of it — a copy would keep passing while production drifted.
    const reachable = new Set(POINTER_REACHABLE_ACTIONS)
    expect([...reachable].sort()).toEqual(["Esc back", "^X W save"].sort())

    // Every string `contextualAction` can produce, checked exhaustively so a
    // new action cannot quietly become clickable by being added upstream.
    const everyAction = [
      contextualAction({
        actionsOpen: true,
        editorMode: "composer",
        insertActionTaught: false,
        phase: "ready",
        settingsOpen: false,
        view: "main",
      }),
      contextualAction({
        actionsOpen: false,
        editorMode: "command",
        insertActionTaught: false,
        phase: "candidate",
        settingsOpen: false,
        view: "main",
      }),
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: false,
        phase: "loading",
        settingsOpen: false,
        view: "main",
      }),
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: false,
        phase: "failed",
        settingsOpen: false,
        view: "main",
      }),
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: false,
        phase: "candidate",
        settingsOpen: false,
        view: "main",
      }),
      contextualAction({
        actionsOpen: false,
        editorMode: "view",
        insertActionTaught: true,
        phase: "candidate",
        settingsOpen: false,
        view: "main",
      }),
    ]
    expect(everyAction).toEqual([
      "Esc back",
      "^X W save",
      "Esc cancel",
      "Enter retry",
      "Enter insert (never runs)",
      "↵ insert",
    ])
    for (const action of everyAction) {
      const mutates =
        action === "Enter insert (never runs)" ||
        action === "↵ insert" ||
        action === "Enter retry" ||
        action === "Esc cancel"
      expect(reachable.has(action)).toBe(!mutates)
    }
  })


  test("candidateRowMarker shows only rank and selection with ASCII parity", () => {
    expect(candidateRowMarker(0, true)).toBe("› 1  ")
    expect(candidateRowMarker(0, false)).toBe("  1  ")
    expect(candidateRowMarker(2, true, false)).toBe("> 3  ")
    for (const unicode of [true, false]) {
      for (const selected of [true, false]) {
        expect(terminalWidth(candidateRowMarker(4, selected, unicode))).toBe(CANDIDATE_MARKER_WIDTH)
      }
    }
  })

  test("actionsSheetLines reproduces the approved layout 'K' at 80 columns, with an ASCII fallback", () => {
    const state = {
      canRequestAlternative: true,
      editing: false,
      editorMode: "command" as const,
      hasCandidateList: true,
      hasEngine: false,
      includeContext: false,
      intent: "generate" as const,
      model: "gpt-5.3-codex-spark",
      reasoning: "low",
    }
    const interior = frameLayout(80).interior

    const unicode = actionsSheetLines(state, interior, true)
    expect(unicode.rows[0].text).toContain("S settings")
    expect(unicode.actions).not.toContain("settings")
    expect(unicode.rows[0].cells).toEqual([])
    expect(unicode.rows.map((row) => row.text)).toEqual([
      "Actions · S settings · only A sends · Esc close",
      "─────────────────────────────────┬──────────────────────────────────────────",
      " C   edit output                 │  I    include output Held",
      " M   model       Spark           │  R    effort       low",
      " E   edit command                │  A    another suggestion · key only",
      " H   details                     │  Esc  close",
    ])
    // Every row fits the interior; the sheet stays inside the existing
    // 8-row envelope (header, rule, four content rows).
    expect(unicode.rows.length).toBeLessThanOrEqual(8)
    for (const row of unicode.rows) {
      expect(terminalWidth(row.text)).toBeLessThanOrEqual(interior)
    }
    // The rule is computed to the interior width, not a literal — at a
    // different width it scales instead of staying pinned.
    expect(terminalWidth(unicode.rows[1].text)).toBe(interior)
    const wider = actionsSheetLines(state, frameLayout(100).interior, true)
    expect(terminalWidth(wider.rows[1].text)).toBe(frameLayout(100).interior)
    expect(terminalWidth(wider.rows[1].text)).not.toBe(terminalWidth(unicode.rows[1].text))

    // ASCII fallback swaps the rule and the vertical divider — the only two
    // glyphs the capsule calls out — for `-`/`+` and `|`. The header's `·`
    // bullet is the same universal separator `RAIL_SEP` uses regardless of
    // `unicode`, so it is deliberately not part of this fallback.
    const ascii = actionsSheetLines(state, interior, false)
    expect(ascii.rows[1].text).toBe(
      "-".repeat(33) + "+" + "-".repeat(interior - 34),
    )
    for (const row of ascii.rows.slice(2)) {
      expect(row.text).toContain(" | ")
      expect(row.text).not.toContain("│")
    }
    for (const glyph of ascii.rows[1].text) {
      expect(glyph.codePointAt(0)!).toBeLessThan(0x80)
    }
  })

  test("actionsSheetLines cell ranges resolve exactly the row's own painted action", () => {
    const state = {
      canRequestAlternative: true,
      editing: false,
      editorMode: "command" as const,
      hasCandidateList: true,
      hasEngine: false,
      includeContext: false,
      intent: "generate" as const,
      model: "gpt-5.3-codex-spark",
      reasoning: "low",
    }
    const interior = frameLayout(80).interior
    const sheet = actionsSheetLines(state, interior, true)
    const expectedRows: { left: ActionsSheetAction; right?: ActionsSheetAction }[] = [
      { left: "context", right: "include" },
      { left: "model", right: "reasoning" },
      { left: "edit" },
      { left: "details", right: "close" },
    ]
    const contentRows = sheet.rows.slice(2)
    expect(contentRows).toHaveLength(expectedRows.length)
    contentRows.forEach((row, index) => {
      const expected = [expectedRows[index].left, expectedRows[index].right].filter(
        (action): action is ActionsSheetAction => Boolean(action),
      )
      expect(row.cells.map((cell) => cell.action)).toEqual(expected)
      for (const cell of row.cells) {
        expect(cell.start).toBeGreaterThanOrEqual(0)
        expect(cell.end).toBeGreaterThan(cell.start)
        expect(cell.end).toBeLessThanOrEqual(terminalWidth(row.text))
        expect(sliceCells(row.text, cell.start, cell.end - cell.start)).not.toBe("")
      }
    })
    expect(sheet.actions).toContain("another")
    expect(contentRows[2].cells.some((cell) => cell.action === "another")).toBe(false)

    const unavailable = actionsSheetLines(
      { ...state, canRequestAlternative: false },
      interior,
      true,
    )
    expect(unavailable.rows[0].text).toBe(
      "Actions · S settings · nothing sends · Esc close",
    )
    expect(unavailable.actions).not.toContain("another")
    expect(unavailable.rows[4].text).not.toContain("another suggestion")

    const doctor = actionsSheetLines(
      { ...state, canRequestAlternative: false, doctorAvailable: true },
      interior,
      true,
    )
    expect(doctor.rows[0].text).toContain("D doctor")
    expect(doctor.rows[0].cells.map((cell) => cell.action)).toEqual(["doctor"])
    expect(doctor.actions).toContain("doctor")
    expect(doctor.rows.at(-1)?.text).toContain("Esc  close")

    // Every editing-mode row resolves to `close` (Esc) or a valid editing
    // action, and the header names the surface being edited.
    const editingSheet = actionsSheetLines({ ...state, editing: true }, interior, true)
    expect(editingSheet.rows[0].text).toBe(
      "Editing command · S settings · nothing sends · Esc close",
    )
    expect(editingSheet.rows[5].text).toContain("include saved output Held")
    expect(editingSheet.rows[3].text).toContain("edit output after save")
    expect(editingSheet.rows[3].text).toContain("editing command")
    const editingActions = editingSheet.rows.slice(2).flatMap((row) => row.cells.map((c) => c.action))
    expect(editingActions).toEqual(["save", "close", "context", "edit", "model", "reasoning", "include", "details"])

    const askSheet = actionsSheetLines(
      { ...state, hasEngine: true, intent: "ask" },
      interior,
      true,
    )
    expect(askSheet.rows[0].text).toBe("Actions · S settings · nothing sends · Esc close")
    expect(askSheet.rows.at(-1)?.cells.at(-1)?.action).toBe("engine")
    expect(askSheet.rows.at(-1)?.text).toContain("G    engine setting")

    const askPromptSheet = actionsSheetLines(
      {
        ...state,
        editing: true,
        editorMode: "prompt",
        hasCandidateList: false,
        intent: "ask",
      },
      interior,
      true,
    )
    expect(askPromptSheet.rows[0].text).toBe(
      "Editing question · S settings · nothing sends · Esc close",
    )
    expect(askPromptSheet.rows[3].text).toContain("edit output after save")
    expect(askPromptSheet.rows[3].text).toContain("editing question")

    const contextSheet = actionsSheetLines(
      { ...state, editing: true, editorMode: "context" },
      interior,
      true,
    )
    expect(contextSheet.rows[3].text).toContain("editing output")
    expect(contextSheet.rows[3].text).toContain("edit command after save")

    const included = actionsSheetLines(
      { ...state, includeContext: true },
      interior,
      true,
    )
    expect(included.rows[2].text).toContain("hold output  Included")
  })

  test("actionsSheetLines keeps wide values inside their painted cell geometry", () => {
    const values = [
      "12345678",
      "1234567890123456",
      "12345678901234567",
      "1234567890123456789012345678901234567890",
      "界界界界界界界界界",
    ]
    for (const columns of [80, 100, 140]) {
      for (const unicode of [false, true]) {
        for (const model of values) {
          const width = frameLayout(columns).interior
          const sheet = actionsSheetLines(
            {
              canRequestAlternative: true,
              editing: false,
              editorMode: "command",
              hasCandidateList: true,
              hasEngine: false,
              includeContext: false,
              intent: "generate",
              model,
              reasoning: "high",
            },
            width,
            unicode,
          )
          expect(sheet.rows).toHaveLength(6)
          for (const row of sheet.rows) {
            expect(terminalWidth(row.text)).toBeLessThanOrEqual(width)
            for (const cell of row.cells) {
              expect(cell.end).toBeLessThanOrEqual(terminalWidth(row.text))
            }
          }
          expect(terminalWidth(sheet.rows[2].text.split(unicode ? "│" : "|")[0])).toBe(33)
        }
      }
    }
  })

  test("windows the complete ranked result set around focus", () => {
    const results = Array.from({ length: 9 }, (_, index) => index)
    expect(settingsPickerWindow(results, 0)).toEqual([0, 1, 2, 3, 4])
    expect(settingsPickerWindow(results, 5)).toEqual([1, 2, 3, 4, 5])
    expect(settingsPickerWindow(results, 8)).toEqual([4, 5, 6, 7, 8])
  })

  test("provider Setup keeps managed-null controls inert and width-safe", () => {
    for (const width of SUPPORTED_WIDTHS) {
      const setup = providerSetupLines(
        {
          configured: false,
          controlsEnabled: false,
          field: "provider",
          modelIndex: 0,
          models: ["Spark", "Luna"],
          providerId: null,
          providers: [
            { id: "codex", selectable: false },
            { id: "claude", selectable: false },
          ],
          reasoningIndex: 0,
          reasoningLevels: ["low", "medium", "high"],
        },
        width - 4,
        false,
      )
      expect(setup.lines).toHaveLength(6)
      expect(setup.ranges.model).toEqual([])
      expect(setup.ranges.reasoning).toEqual([])
      for (const line of setup.lines) expect(terminalWidth(line.text)).toBeLessThanOrEqual(width - 4)
      expect(setup.lines[0].text).toContain("PATH only")
      expect(setup.lines[0].text).toContain("auth/network not checked")
      expect(setup.lines[0].text).toContain("nothing sends")
      expect(setup.lines[4].text).toContain("Codex CLI UNAVAILABLE")
      expect(setup.lines[4].text).toContain("Claude CLI UNAVAILABLE")
      expect(setup.lines[5].text).toContain("Enter/Esc back")
    }
  })

  test("provider Setup covers the required availability snapshots", () => {
    const emptyPath = mkdtempSync(join(tmpdir(), "shellq-setup-snapshot-"))
    const oldPath = process.env.PATH
    try {
      process.env.PATH = emptyPath
      const snapshots = [
        {
          name: "managed-null",
          configured: false,
          controlsEnabled: false,
          providerId: null,
          providers: [
            { id: "codex" as const, selectable: false },
            { id: "claude" as const, selectable: false },
          ],
          providerIndices: [],
          statuses: ["Codex CLI UNAVAILABLE", "Claude CLI UNAVAILABLE"],
        },
        {
          name: "configured-custom",
          configured: true,
          controlsEnabled: true,
          providerId: null,
          providers: [
            { id: "codex" as const, selectable: false },
            { id: "claude" as const, selectable: false },
          ],
          providerIndices: [],
          statuses: ["Codex CLI UNAVAILABLE", "Claude CLI UNAVAILABLE"],
        },
        {
          name: "codex-only",
          configured: false,
          controlsEnabled: true,
          providerId: "codex" as const,
          providers: [
            { id: "codex" as const, selectable: true },
            { id: "claude" as const, selectable: false },
          ],
          providerIndices: [0],
          statuses: ["Codex CLI AVAILABLE", "Claude CLI UNAVAILABLE"],
        },
        {
          name: "claude-only",
          configured: false,
          controlsEnabled: true,
          providerId: "claude" as const,
          providers: [
            { id: "codex" as const, selectable: false },
            { id: "claude" as const, selectable: true },
          ],
          providerIndices: [1],
          statuses: ["Codex CLI UNAVAILABLE", "Claude CLI AVAILABLE"],
        },
        {
          name: "both",
          configured: false,
          controlsEnabled: true,
          providerId: "codex" as const,
          providers: [
            { id: "codex" as const, selectable: true },
            { id: "claude" as const, selectable: true },
          ],
          providerIndices: [0, 1],
          statuses: ["Codex CLI AVAILABLE", "Claude CLI AVAILABLE"],
        },
        {
          name: "neither",
          configured: false,
          controlsEnabled: false,
          providerId: null,
          providers: [
            { id: "codex" as const, selectable: false },
            { id: "claude" as const, selectable: false },
          ],
          providerIndices: [],
          statuses: ["Codex CLI UNAVAILABLE", "Claude CLI UNAVAILABLE"],
        },
      ]

      for (const snapshot of snapshots) {
        const setup = providerSetupLines(
          {
            configured: snapshot.configured,
            controlsEnabled: snapshot.controlsEnabled,
            field: "provider",
            modelIndex: 0,
            models: ["Spark"],
            providerId: snapshot.providerId,
            providers: snapshot.providers,
            reasoningIndex: 0,
            reasoningLevels: ["low"],
          },
          76,
          false,
        )
        expect(setup.lines[1].text, snapshot.name).toContain(
          snapshot.configured ? "configured externally" : "Provider",
        )
        for (const status of snapshot.statuses) {
          expect(setup.lines[4].text, snapshot.name).toContain(status)
        }
        expect(setup.ranges.provider.map(({ index }) => index), snapshot.name)
          .toEqual(snapshot.providerIndices)
        expect(setup.ranges.model.length, snapshot.name)
          .toBe(snapshot.controlsEnabled ? 1 : 0)
        expect(setup.ranges.reasoning.length, snapshot.name)
          .toBe(snapshot.controlsEnabled ? 1 : 0)
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
      rmSync(emptyPath, { force: true, recursive: true })
    }
  })

  // Asserts the WCAG relative-luminance contrast formula for the new outline
  // token against the two backgrounds the spec scenario names.
  test("clears a 3:1 contrast floor against #000000 and #1E1E1E", () => {
    const contrastRatio = (foreground: string, background: string) => {
      const luminance = (hex: string) => {
        const channel = (value: number) => {
          const srgb = value / 255
          return srgb <= 0.03928
            ? srgb / 12.92
            : ((srgb + 0.055) / 1.055) ** 2.4
        }
        const r = Number.parseInt(hex.slice(1, 3), 16)
        const g = Number.parseInt(hex.slice(3, 5), 16)
        const b = Number.parseInt(hex.slice(5, 7), 16)
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
      }
      const [l1, l2] = [luminance(foreground), luminance(background)].sort(
        (a, b) => b - a,
      )
      return (l1 + 0.05) / (l2 + 0.05)
    }
    expect(contrastRatio("#6B7280", "#000000")).toBeGreaterThanOrEqual(3)
    expect(contrastRatio("#6B7280", "#1E1E1E")).toBeGreaterThanOrEqual(3)
    // The retired token never cleared the floor on either background.
    expect(contrastRatio("#4B5563", "#000000")).toBeLessThan(3)
    expect(contrastRatio("#4B5563", "#1E1E1E")).toBeLessThan(3)
  })

  test("names every state in words rather than colour alone", () => {
    const states = (
      [
        "ready",
        "loading",
        "streaming",
        "failed",
        "cancelled",
        "candidate",
        "answer",
        "analysis",
      ] as const
    ).map((phase) =>
      verdict({
        confidence: 0.99,
        model: "gpt-5.3-codex-spark",
        phase,
        risk: "read-only",
      }),
    )
    expect(new Set(states.map((state) => state.text)).size).toBe(states.length)
    expect(states[0].text).toContain("nothing sent yet")
    expect(states[1].text).toContain("esc cancels the request")
    expect(states[2].text).toContain("streaming from Spark")
    expect(states[3].text).toContain("nothing was inserted")
    expect(states[4].text).toContain("request cancelled")
    expect(states[5].text).toContain("high confidence")
    expect(states[6].text).toContain("nothing can be inserted")
    expect(states[7].text).toContain("no command inserted")

    expect(isEditingMode("prompt")).toBe(true)
    expect(isEditingMode("composer")).toBe(false)

    const low = verdict({
      confidence: 0.4,
      model: "gpt-5.3-codex-spark",
      phase: "candidate",
      risk: "removes files",
    })
    expect(low.text).toContain("low confidence")
    expect(low.variant).toBe("warning")

    expect(
      outputState({
        contextBytes: 4,
        contextSource: "herdr",
        included: true,
      }),
    ).toBe("Included")
    expect(
      outputState({
        contextBytes: 4,
        contextSource: "tmux",
        included: false,
      }),
    ).toBe("Held")
    expect(
      outputState({
        contextBytes: 0,
        contextSource: "herdr",
        included: false,
      }),
    ).toBe("Available")
    expect(
      outputState({
        contextBytes: 0,
        contextSource: "none",
        included: false,
      }),
    ).toBe("Unavailable")
  })

  test("details expose the contract fields and stay inside the width", () => {
    const items = metadataItems({
      askChatState: "saved",
      candidate: {
        confidence: 0.99,
        corrected_command: "git status",
        risk: "read  only 🙂",
        tldr: "shows the working tree",
      },
      candidateCount: 3,
      candidateIndex: 1,
      contextBytes: 32,
      contextLabel: "matched command",
      contextSource: "herdr",
      // Short synthetic absolute cwd: the details value window truncates at
      // 54 columns, so a full-length home path cannot appear verbatim.
      cwd: "/tmp/shellq",
      included: false,
      lastCommand: {
        command: "gti status",
        cwd: "/tmp/shellq",
        exit_status: 127,
        pipeline_statuses: [127],
      },
      engine: "App Server",
      model: "gpt-5.3-codex-spark",
      reasoning: "low",
      repositoryAccess: true,
    })

    expect(items).toContainEqual({ key: "engine", value: "App Server" })
    // App Server's isolated boundary (spec: stable ShellQ-owned codex-home,
    // native file login, no user/project/AGENTS/skill/MCP inheritance).
    expect(items).toContainEqual({
      key: "Codex boundary",
      value:
        "native file login · private history · no user/project instructions, skills or MCP · Ask read-only · answers never execute",
    })

    const keyWidth =
      Math.max(...items.map((item) => terminalWidth(item.key))) + 2
    const valueWidth = frameLayout(80).interior - keyWidth - 3
    const rendered = items.map(
      (item) =>
        `${item.key.padEnd(keyWidth)} : ${metadataWindow(
          item.value,
          0,
          valueWidth,
        )}`,
    )
    for (const line of rendered) {
      expect(terminalWidth(line)).toBeLessThanOrEqual(frameLayout(80).interior)
    }
    expect(rendered.join("\n")).toContain('"gti status"')
    expect(rendered.join("\n")).toContain("/tmp/shellq")
    expect(rendered.join("\n")).toContain("127 · pipeline [127]")
    expect(rendered.join("\n")).toContain("herdr matched command")
    expect(rendered.join("\n")).toContain("output Held")
    expect(rendered.join("\n")).toContain("gpt-5.3-codex-spark · effort low")
    expect(rendered.join("\n")).toContain("confidence 0.99")
    expect(items.find((item) => item.key === "Ask chat")?.value).toBe(
      "saved for this cwd",
    )
    expect(items.find((item) => item.key === "candidate")?.value)
      .toContain('risk "read  only 🙂"')
    expect(items.find((item) => item.key === "candidate command")?.value)
      .toBe('"git status"')
    // Details drop "mode" (the top border already names it) and both "keys"
    // rows (the separate help surface owns the full keymap) so nothing here
    // duplicates the rail or the help surface.
    expect(items.some((item) => item.key === "mode")).toBe(false)
    expect(items.some((item) => item.key === "keys")).toBe(false)
    // The confidence caveat trails the candidate rows (spec: confidence is a
    // provider estimate, also surfaced in Details).
    expect(items.at(-1)?.key).toBe("confidence")

    const longValue = `"${"x".repeat(120)} tail"`
    expect(metadataWindow(longValue, 0, 20)).toEndWith("›")
    expect(
      metadataWindow(longValue, terminalWidth(longValue) - 18, 20),
    ).toContain("tail")
  })

  test("reports a cancelled request differently from a provider failure", () => {
    const cancelled = requestOutcome(new Error("provider exited 143"), true)
    expect(cancelled.phase).toBe("cancelled")
    expect(cancelled.message).toContain("kept every earlier suggestion")
    expect(cancelled.message).not.toContain("143")

    const failed = requestOutcome(new Error("provider exited 1: boom"), false)
    expect(failed.phase).toBe("failed")
    expect(failed.message).toBe("provider exited 1: boom")

    expect(verdict({
      confidence: null,
      model: "gpt-5.3-codex-spark",
      phase: "cancelled",
      risk: "",
    }).variant).toBe("pending")
  })

  test("the attached-output preview shows only when the composer is the idle primary surface and output is attached", () => {
    const base = {
      actionsOpen: false,
      contextBytes: 4200,
      editorMode: "composer",
      included: true,
      phase: "ready",
      settingsOpen: false,
      view: "main",
    } as const

    expect(contextPreviewVisible(base)).toBe(true)

    // Held back (not included) or nothing captured: nothing to preview.
    expect(contextPreviewVisible({ ...base, included: false })).toBe(false)
    expect(contextPreviewVisible({ ...base, contextBytes: 0 })).toBe(false)

    // Every other surface already owns the body — a candidate list folds
    // into `phase === "candidate"`, an Ask answer into `phase === "answer"`,
    // and analysis/loading/failed/cancelled are also phases other than
    // `"ready"`.
    for (const phase of [
      "loading",
      "answer",
      "analysis",
      "candidate",
      "failed",
      "cancelled",
    ] as const) {
      expect(contextPreviewVisible({ ...base, phase })).toBe(false)
    }
    expect(contextPreviewVisible({ ...base, actionsOpen: true })).toBe(false)
    expect(contextPreviewVisible({ ...base, settingsOpen: true })).toBe(false)
    expect(contextPreviewVisible({ ...base, view: "details" })).toBe(false)
    for (const editorMode of ["prompt", "command", "context"] as const) {
      expect(contextPreviewVisible({ ...base, editorMode })).toBe(false)
    }
    // "view" (a promoted candidate/answer reader mid-request) is not an
    // editing mode, but it never actually reaches `phase === "ready"`
    // alongside it in the real UI; the gate itself only cares that it is
    // not one of the editing modes.
    expect(contextPreviewVisible({ ...base, editorMode: "view" })).toBe(true)
  })

  test("the preview shows the tail of the sanitized context, bounded to three rows and width-truncated", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`)
    const preview = contextPreview(lines.join("\n"), 40)
    expect(CONTEXT_PREVIEW_MAX_ROWS).toBe(3)
    expect(preview.rows).toEqual(["line 7", "line 8", "line 9"])
    expect(preview.label).toBe(CONTEXT_PREVIEW_LABEL)

    // A trailing newline's empty split segment carries no content of its
    // own and is dropped rather than spent on a blank row.
    const trailing = contextPreview(`${lines.join("\n")}\n`, 40)
    expect(trailing.rows).toEqual(["line 7", "line 8", "line 9"])

    // Fewer lines than the bound: every line shows, nothing padded in.
    expect(contextPreview("only one line", 40).rows).toEqual(["only one line"])

    // Width-truncated with the same helper the rest of the body uses —
    // never a raw slice that could split a multi-cell grapheme.
    const wide = contextPreview("x".repeat(80), 10)
    expect(wide.rows).toEqual([truncateCells("x".repeat(80), 10)])
    expect(terminalWidth(wide.rows[0])).toBeLessThanOrEqual(10)
    expect(terminalWidth(wide.label)).toBeLessThanOrEqual(10)

    // The marker is a plain textual label: pure ASCII, so it reads
    // identically with or without Unicode/color and never leans on either
    // to be distinguishable from an answer or a candidate.
    expect(CONTEXT_PREVIEW_LABEL).toMatch(/^[\x20-\x7e]+$/)
  })

  test("the preview promotes the footer to the reader envelope, monotonically", () => {
    const compact = {
      actionsOpen: false,
      composerLines: 1,
      editorMode: "composer",
      intent: "generate",
      phase: "ready",
      previewVisible: false,
      settingsOpen: false,
      view: "main",
    } as const

    expect(requestedFooterHeight(compact)).toBe(COMPACT_FOOTER_HEIGHT)
    expect(requestedFooterHeight({ ...compact, previewVisible: true })).toBe(
      READER_FOOTER_HEIGHT,
    )
  })
})

/* Rendering assertions.
 *
 * These build the real production frame through OpenTUI's own renderer and
 * read the resulting character grid. They exist because the defects this
 * slice repairs — a bottom border that stopped short of the terminal edge,
 * interior rows with no side borders, and a status rail that a native title
 * silently drops when it is one cell too wide — are invisible to any
 * assertion made on the helper strings alone. */
describe("native frame rendering", () => {
  const ASCII_BORDER_CHARS: BorderCharacters = {
    bottomLeft: "+",
    bottomRight: "+",
    bottomT: "+",
    cross: "+",
    horizontal: "-",
    leftT: "+",
    rightT: "+",
    topLeft: "+",
    topRight: "+",
    topT: "+",
    vertical: "|",
  }

  const railState = (overrides: Partial<BottomRailState> = {}) => ({
    action: "",
    contextBytes: 2100,
    cwd: HOME_CWD,
    included: false,
    message: null,
    ...overrides,
  })

  const renderFrame = async (options: {
    width: number
    height: number
    intent?: SessionIntent
    rail?: Partial<BottomRailState>
    unicode?: boolean
  }) => {
    const { height, width } = options
    const unicode = options.unicode ?? true
    const layout = frameLayout(width)
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      height,
      width,
    })
    const box = new BoxRenderable(renderer, {
      border: true,
      borderStyle: "rounded",
      bottomTitle: truncateCells(
        bottomRailLine(railState(options.rail), layout.titleBudget, unicode),
        layout.titleBudget,
      ),
      bottomTitleAlignment: "left",
      customBorderChars: unicode ? undefined : ASCII_BORDER_CHARS,
      height,
      id: `frame-${width}-${height}-${unicode}`,
      paddingLeft: 1,
      paddingRight: 1,
      title: truncateCells(
        topRailLine(
          {
            intent: options.intent ?? "ask",
            model: "gpt-5.3-codex-spark",
            reasoning: "low",
          },
          layout.titleBudget,
          unicode,
        ),
        layout.titleBudget,
      ),
      titleAlignment: "left",
      width,
    })
    renderer.root.add(box)
    await renderOnce()
    return captureCharFrame()
      .split("\n")
      .filter((line) => line.length > 0)
      .slice(0, height)
  }

  const glyphs = (unicode: boolean) =>
    unicode
      ? { bl: "╰", br: "╯", side: "│", tl: "╭", tr: "╮" }
      : { bl: "+", br: "+", side: "|", tl: "+", tr: "+" }

  // Every screenshot defect about the frame itself is one of these three
  // properties failing on at least one row.
  const assertSingleOwner = (
    rows: string[],
    width: number,
    unicode: boolean,
  ) => {
    const { bl, br, side, tl, tr } = glyphs(unicode)
    expect(rows.length).toBeGreaterThan(2)
    rows.forEach((row, index) => {
      const cells = [...row]
      expect(terminalWidth(row)).toBe(width)
      if (index === 0) {
        expect(cells[0]).toBe(tl)
        expect(cells.at(-1)).toBe(tr)
      } else if (index === rows.length - 1) {
        expect(cells[0]).toBe(bl)
        expect(cells.at(-1)).toBe(br)
      } else {
        expect(cells[0]).toBe(side)
        expect(cells.at(-1)).toBe(side)
      }
    })
  }

  test("draws one owner of every edge at 3, 8, and 12 rows", async () => {
    for (const width of SUPPORTED_WIDTHS) {
      for (const height of [3, 4, 8, 12]) {
        const rows = await renderFrame({ height, width })
        assertSingleOwner(rows, width, true)
      }
    }
  })

  test("puts the bottom-right corner on the last terminal cell", async () => {
    for (const width of SUPPORTED_WIDTHS) {
      const rows = await renderFrame({ height: 3, width })
      const bottom = [...rows.at(-1)!]
      expect(bottom.length).toBe(width)
      expect(bottom.at(-1)).toBe("╯")
      // The defect this replaces left a run of blank cells before the edge.
      expect(bottom.at(-2)).not.toBe(" ")
    }
  })

  test("keeps all three modes on the top border in every mode", async () => {
    for (const intent of ["ask", "generate", "correct"] as const) {
      const rows = await renderFrame({ height: 3, intent, width: 80 })
      const top = rows[0]
      for (const label of ["Ask", "Command", "Fix"]) {
        expect(top).toContain(label)
      }
      const selected =
        intent === "ask" ? "Ask" : intent === "generate" ? "Command" : "Fix"
      expect(top).toContain(`[${selected}]`)
    }
  })

  test("never lets a native title be silently dropped", async () => {
    // A title or bottomTitle wider than `width - 4` is not truncated by the
    // renderer — it is discarded whole, taking the mode strip or the entire
    // status rail off screen.
    const hostile = {
      action: "Enter insert (never runs)",
      cwd: `/Users/dev/${"deeply/nested/".repeat(12)}project`,
      message: "the provider returned a materially different command to compare",
    }
    for (const width of SUPPORTED_WIDTHS) {
      const rows = await renderFrame({ height: 8, rail: hostile, width })
      assertSingleOwner(rows, width, true)
      expect(rows[0]).toContain("Fix")
      expect(rows.at(-1)).toContain("^X")
      expect(rows.at(-1)).toContain("never runs")
    }

    // Below the supported widths both borders must still render something
    // rather than vanish: a dropped native title is the failure mode being
    // guarded. Model/reasoning moved to the top border, so that is where the
    // anchor now lives; the bottom border still carries real text of its own.
    const narrow = await renderFrame({ height: 8, rail: hostile, width: 40 })
    assertSingleOwner(narrow, 40, true)
    expect(narrow[0]).toContain("Fix")
    expect(narrow[0]).toContain("Spark")
    expect(narrow.at(-1)!.trim().length).toBeGreaterThan(0)
  })

  test("keeps the native bottomTitle when cwd carries ANSI, newlines, or bidi overrides", async () => {
    // Bun.stringWidth under-measures a raw ANSI escape, so an unsanitized
    // cwd can make `fits()` pass while the assembled string is still wider
    // than the terminal — opentui then discards the whole bottomTitle,
    // taking `never runs` off screen with it.
    const hostileCwds = [
      "/Users/dev/Projects/\x1b[31mshellq",
      "/Users/dev/Projects/\nshellq",
      "/Users/dev/Projects/‮shellq",
    ]
    for (const cwd of hostileCwds) {
      const hostile = {
        action: "Enter insert (never runs)",
        cwd,
        message: "the provider returned a materially different command to compare",
      }
      for (const width of SUPPORTED_WIDTHS) {
        const rows = await renderFrame({ height: 8, rail: hostile, width })
        assertSingleOwner(rows, width, true)
        expect(rows[0]).toContain("Fix")
        expect(rows.at(-1)).toContain("^X")
        expect(rows.at(-1)).toContain("never runs")
      }
    }
  })

  test("falls back to an ASCII frame with no drawing or private-use glyph", async () => {
    for (const width of SUPPORTED_WIDTHS) {
      const rows = await renderFrame({ height: 8, unicode: false, width })
      assertSingleOwner(rows, width, false)
      // The fallback targets glyphs a terminal font may not have: box drawing,
      // block elements, and private-use Powerline codepoints. Latin-1 text
      // punctuation such as `\u00b7` stays, exactly as the rail always used it.
      expect(rows.join("\n")).not.toMatch(/[\u2500-\u259f\ue000-\uf8ff]/u)
      // The frame structure and the mode strip must stay strictly ASCII.
      expect(rows[0]).not.toMatch(/[^\x00-\x7f]/u)
      expect(rows[0]).toContain("[Ask]")
      expect(rows.at(-1)).toContain("^X")
    }
  })

  test("pins the title origin so a span's cell offset lands on the real screen column", async () => {
    const width = 80
    const rows = await renderFrame({ height: 3, intent: "generate", width })
    const top = rows[0]
    const { spans } = modeTabs("generate", frameLayout(width).titleBudget, true)
    const span = spans.generate
    const cell = [...top]
      .slice(TITLE_ORIGIN_X + span.start, TITLE_ORIGIN_X + span.end)
      .join("")
    // An upstream change to the border/padding origin must fail loudly here
    // rather than silently misrouting every pointer click.
    expect(cell).toBe("[Command]")
  })
})

describe("multiline composer contract", () => {
  test("preserves pasted line structure while normalizing terminal newlines", () => {
    expect(composerText("what is\n\nthis repo?")).toBe(
      "what is\n\nthis repo?",
    )
    expect(composerText("line one\r\n\r\nline two")).toBe(
      "line one\n\nline two",
    )
    expect(queryIsValid(composerText("what is\n\nthis repo?"))).toBe(true)
  })
})

describe("selected candidate review", () => {
  test("shows real line breaks on real rows and truncates at the budget", () => {
    const multi = 'echo "Hi"\necho "Hi"\necho "Hi"'
    expect(selectedCommandLines(multi, 40, 6)).toEqual([
      'echo "Hi"',
      'echo "Hi"',
      'echo "Hi"',
    ])
    // The folded form the unselected rows keep must NOT be what the selected
    // row shows — that inline `↵` is exactly what made review harder.
    expect(selectedCommandLines(multi, 40, 6).join("")).not.toContain("↵")
    expect(visibleShellText(multi)).toContain("↵")

    // Long single lines wrap to the available width.
    const wrapped = selectedCommandLines("git ".repeat(40), 20, 6)
    expect(wrapped.length).toBeGreaterThan(1)
    for (const line of wrapped) {
      expect(terminalWidth(line)).toBeLessThanOrEqual(20)
    }

    // Running out of rows reads as truncation, never as a shorter command.
    const clipped = selectedCommandLines(multi, 40, 2)
    expect(clipped).toHaveLength(2)
    expect(clipped.at(-1)).toEndWith("…")

    expect(selectedCommandLines("echo ok", 0, 4)).toEqual([])
    expect(selectedCommandLines("echo ok", 40, 0)).toEqual([])
  })

  test("never lets the candidate surface exceed its promoted envelope", () => {
    const interior = READER_FOOTER_HEIGHT - 2
    for (const count of [1, 2, 3, 4, CANDIDATE_LIMIT]) {
      const selectedBudget = Math.max(1, interior - Math.max(0, count - 1))
      const selectedRows = selectedCommandLines(
        'echo "Hi"\n'.repeat(9),
        40,
        selectedBudget,
      ).length
      expect(selectedRows + (count - 1)).toBeLessThanOrEqual(interior)
    }
  })
})

describe("local provider palette and adapter seams", () => {
  // Discovery is endpoint-aware: catalogs are keyed by exact endpoint URL and
  // every local model leaf carries its endpoint in identity and destination.
  const localEndpoint = "http://127.0.0.1:8000/v1"
  const localCatalog = parseLocalCatalog(
    JSON.stringify({
      object: "list",
      data: [{ id: "qwen3-coder-30b-a3b-instruct" }, { id: "gemma-3-12b-it" }],
    }),
    ["endpoint default"],
  )!

  const localBase = {
    availableProviders: [
      { id: "codex" as const, models: ["gpt-5.6-luna"], reasoningLevels: ["low"], selectable: true },
      { id: LOCAL_PROVIDER_ID, models: [] as string[], reasoningLevels: ["endpoint default"], selectable: true },
    ],
    anotherAvailable: false,
    codexEngine: null,
    codexEngineAvailable: false,
    doctorAvailable: false,
    engine: null,
    model: "gpt-5.6-luna",
    providerId: "codex" as const,
    providerSource: "default" as const,
    reasoning: "low",
    // The live picker always supplies the resolved effective endpoint; the
    // fixtures exercise that same real interface, never an endpoint-free one.
    localEndpoint,
  }

  test("admits an ordered exact catalog and rejects anything unexpected", () => {
    expect(localCatalog.providerId).toBe(LOCAL_PROVIDER_ID)
    expect(localCatalog.models.map((item) => item.model)).toEqual([
      "qwen3-coder-30b-a3b-instruct",
      "gemma-3-12b-it",
    ])
    expect(parseLocalCatalog(JSON.stringify({ object: "list", data: [] }), ["n/a"])?.models).toEqual([])
    for (const hostile of [
      "",
      "not json",
      JSON.stringify({ object: "other", data: [] }),
      JSON.stringify({ object: "list" }),
      JSON.stringify({ object: "list", data: [{ id: "dup" }, { id: "dup" }] }),
      JSON.stringify({ object: "list", data: [{ id: "has space" }] }),
      JSON.stringify({ object: "list", data: [{ id: 7 }] }),
      JSON.stringify({ object: "list", data: ["qwen"] }),
      JSON.stringify({
        object: "list",
        data: Array.from({ length: 513 }, (_, index) => ({ id: `m${index}` })),
      }),
    ]) {
      expect(parseLocalCatalog(hostile, ["n/a"])).toBeNull()
    }
  })

  test("parent reader and parser admit 512 maximum-length local IDs, but not 513", async () => {
    const data = Array.from({ length: 512 }, (_, i) => ({ id: String(i).padStart(3, "0") + "x".repeat(125) }))
    const raw = JSON.stringify({ object: "list", data })
    expect(Buffer.byteLength(raw)).toBe(70_682)
    expect(RESPONSE_MAX_BYTES).toBe(65_536)
    const read = (value: string) => readBounded(new Blob([value]).stream(), LOCAL_DISCOVERY_MAX_BYTES)
    expect(parseLocalCatalog(await read(raw), ["endpoint default"])?.models.map(item => item.id)).toEqual(data.map(item => item.id))
    data.push({ id: "last" })
    expect(parseLocalCatalog(await read(JSON.stringify({ object: "list", data })), ["endpoint default"])).toBeNull()
  })

  test("hands the adapter a fresh allowlisted environment, never the parent's", () => {
    const parent = {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/nobody",
      HTTP_PROXY: "http://evil:3128",
      HTTPS_PROXY: "http://evil:3128",
      ALL_PROXY: "socks5://evil:1080",
      NO_PROXY: "",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      SHELLQ_CODEX_SESSION_FILE: "/tmp/pointer.json",
      SHELLQ_LOCAL_OPENAI_ENDPOINT: "http://127.0.0.1:8000/v1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    }
    const env = localAdapterEnvironment(parent, "http://127.0.0.1:9000/v1", { model: "qwen3-coder-30b-a3b-instruct" })
    expect(Object.keys(env).sort()).toEqual([
      "PATH",
      "SHELLQ_LOCAL_OPENAI_ENDPOINT",
      "SHELLQ_LOCAL_OPENAI_MODEL",
    ])
    expect(Object.values(env)).not.toContain("sk-secret")
    for (const leaked of Object.keys(parent)) {
      if (leaked === "PATH" || leaked === "SHELLQ_LOCAL_OPENAI_ENDPOINT") continue
      expect(env).not.toHaveProperty(leaked)
    }
    const discovery = localAdapterEnvironment({ PATH: "/usr/bin" }, "http://127.0.0.1:8000/v1", { mode: "discover" })
    expect(env.SHELLQ_LOCAL_OPENAI_ENDPOINT).toBe("http://127.0.0.1:9000/v1")
    expect(discovery).toEqual({ PATH: "/usr/bin", SHELLQ_LOCAL_OPENAI_ENDPOINT: "http://127.0.0.1:8000/v1", SHELLQ_LOCAL_OPENAI_MODE: "discover" })
  })

  test("publishes exact model leaves and never a local provider leaf", () => {
    const withoutCatalog = buildUniversalPaletteSources({ ...localBase, localCheckAvailable: true })
    expect(withoutCatalog.some((source) => source.authorityKey === LOCAL_PROVIDER_ID)).toBe(false)
    expect(withoutCatalog.filter((source) => source.action === "check-local-models")).toHaveLength(1)

    const withCatalog = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      localEndpointCatalogs: { [localEndpoint]: localCatalog },
    })
    expect(
      withCatalog.filter(
        (source) => source.field === "provider" && source.value === LOCAL_PROVIDER_ID,
      ),
    ).toEqual([])
    expect(withCatalog.filter((source) => source.field === "provider").map((source) => source.value))
      .toEqual(["codex"])
    const localModels = withCatalog.filter(
      (source) => source.field === "model" && source.authorityKey === localEndpoint,
    )
    expect(localModels.map((source) => source.value)).toEqual([
      "qwen3-coder-30b-a3b-instruct",
      "gemma-3-12b-it",
    ])
    expect(localModels[0].label).toBe("Local/qwen3-coder-30b-a3b-instruct")
    expect(localModels.every((source) => source.destination?.providerId === LOCAL_PROVIDER_ID)).toBe(true)
    expect(localModels.every((source) => source.destination?.endpoint === localEndpoint)).toBe(true)
    // The activation target is the raw catalog value, byte for byte.
    expect(localModels.map((source) => source.destination?.model)).toEqual([
      "qwen3-coder-30b-a3b-instruct",
      "gemma-3-12b-it",
    ])
  })

  test("a typed distinctive substring reaches the exact local model leaf", () => {
    const sources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      localEndpointCatalogs: { [localEndpoint]: localCatalog },
    })
    expect(fuzzySettingsCandidates("a3b", sources)[0]?.value).toBe("qwen3-coder-30b-a3b-instruct")
    expect(fuzzySettingsCandidates("gemma", sources)[0]?.value).toBe("gemma-3-12b-it")
    expect(fuzzySettingsCandidates("qwen3-coder-30b-a3b-instruct", sources)[0]?.destination?.model)
      .toBe("qwen3-coder-30b-a3b-instruct")
  })

  test("omits the check action when the local provider is not offered", () => {
    const sources = buildUniversalPaletteSources({ ...localBase })
    expect(sources.some((source) => source.action === "check-local-models")).toBe(false)
  })

  test("a saved local model is restored as selected preference immediately", () => {
    const session = {
      provider_id: LOCAL_PROVIDER_ID,
      models: [] as string[],
      reasoning_levels: ["endpoint default"],
      model: "",
      reasoning: "endpoint default",
    } as unknown as WorkbenchSession
    expect(
      applyPersistedInferenceSettings(session, {
        model: "qwen3-coder-30b-a3b-instruct",
        reasoning: "endpoint default",
      }),
    ).toBeNull()
    expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")
    expect(session.reasoning).toBe("endpoint default")
    expect(session.models).toEqual([])
  })

  test("rejects unsupported local effort and falls back to session default", () => {
    const session = {
      provider_id: LOCAL_PROVIDER_ID,
      models: [] as string[],
      reasoning_levels: ["endpoint default"],
      model: "",
      reasoning: "endpoint default",
    } as unknown as WorkbenchSession
    const notice = applyPersistedInferenceSettings(session, {
      model: "qwen3-coder-30b-a3b-instruct",
      reasoning: "unsupported-effort",
    })
    expect(notice).toContain("saved effort unavailable")
    expect(session.model).toBe("qwen3-coder-30b-a3b-instruct")
    expect(session.reasoning).toBe("endpoint default")
  })

  test("bad saved IDs and no tuple never become synthetic choices", () => {
    const session = {
      provider_id: LOCAL_PROVIDER_ID,
      models: [] as string[],
      reasoning_levels: ["endpoint default"],
      model: "",
      reasoning: "endpoint default",
    } as unknown as WorkbenchSession
    // Hostile model with injection / spaces rejected
    expect(
      applyPersistedInferenceSettings(session, {
        model: "bad model with spaces; rm -rf /",
        reasoning: "endpoint default",
      }),
    ).not.toBeNull()
    expect(session.model).toBe("")

    // With no tuple, no synthetic choice is created in the palette
    const sources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      persisted: {},
    })
    expect(sources.some((s) => s.authorityKey === LOCAL_PROVIDER_ID && s.field === "provider")).toBe(false)
  })

  test("provisional local provider destination uses only saved exact tuple", () => {
    const sources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      persisted: {
        [LOCAL_PROVIDER_ID]: { model: "qwen3-coder-30b-a3b-instruct", reasoning: "endpoint default" },
      },
    })
    const providerRecord = sources.find((s) => s.field === "provider" && s.value === LOCAL_PROVIDER_ID)
    expect(providerRecord).toBeDefined()
    expect(providerRecord?.destination?.model).toBe("qwen3-coder-30b-a3b-instruct")
    expect(providerRecord?.destination?.reasoning).toBe("endpoint default")

    const currentSources = buildUniversalPaletteSources({
      ...localBase,
      model: "current-local-model",
      providerId: LOCAL_PROVIDER_ID,
      persisted: {
        [LOCAL_PROVIDER_ID]: { model: "stale-local-model", reasoning: "endpoint default" },
      },
    })
    expect(currentSources.find((s) => s.field === "provider" && s.value === LOCAL_PROVIDER_ID)
      ?.destination?.model).toBe("current-local-model")
  })

  test("provisional saved local model distinguishes not-yet-checked from confirmed unavailable", () => {
    // Before discovery runs (dynamic catalog null/missing):
    const uncheckedSources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      persisted: {
        [LOCAL_PROVIDER_ID]: { model: "qwen3-coder-30b-a3b-instruct", reasoning: "endpoint default" },
      },
    })
    const uncheckedModel = uncheckedSources.find(
      (s) => s.field === "model" && s.value === "qwen3-coder-30b-a3b-instruct",
    )
    expect(uncheckedModel?.display).toContain("saved preference")
    expect(uncheckedModel?.display).not.toContain("unavailable")

    // After discovery runs and returns a catalog without the saved model:
    const checkedSources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      localEndpointCatalogs: {
        [localEndpoint]: explicitModelCatalog(LOCAL_PROVIDER_ID, ["other-model"], ["endpoint default"]),
      },
      persisted: {
        [LOCAL_PROVIDER_ID]: { model: "qwen3-coder-30b-a3b-instruct", reasoning: "endpoint default" },
      },
    })
    const checkedModel = checkedSources.find(
      (s) => s.field === "model" && s.value === "qwen3-coder-30b-a3b-instruct",
    )
    expect(checkedModel?.display).toContain("unavailable")
    expect(checkedModel?.display).not.toContain("saved preference")
  })

  test("provisional saved and catalog local models accurately display blocked status", () => {
    const sources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      localEndpointCatalogs: {
        [localEndpoint]: explicitModelCatalog(
          LOCAL_PROVIDER_ID,
          ["qwen3-coder-30b-a3b-instruct", "deepseek-coder"],
          ["endpoint default"],
        ),
      },
      // Blocks are endpoint-scoped pairs: the same ID on another endpoint or a
      // later refresh must never inherit this block.
      blockedLocalModels: [`${localEndpoint} qwen3-coder-30b-a3b-instruct`],
      persisted: {
        [LOCAL_PROVIDER_ID]: { model: "qwen3-coder-30b-a3b-instruct", reasoning: "endpoint default" },
      },
    })
    const blockedModel = sources.find(
      (s) => s.field === "model" && s.value === "qwen3-coder-30b-a3b-instruct",
    )
    expect(blockedModel?.display).toContain("blocked")
    expect(blockedModel?.display).not.toContain("saved preference")
    const blockedProvider = sources.find(
      (s) => s.field === "provider" && s.value === LOCAL_PROVIDER_ID,
    )
    expect(blockedProvider?.display).toContain("blocked")

    const unblockedModel = sources.find(
      (s) => s.field === "model" && s.value === "deepseek-coder",
    )
    expect(unblockedModel?.display).not.toContain("blocked")
  })

  test("stale dynamic catalog retains entries and displays them as unavailable", () => {
    const sources = buildUniversalPaletteSources({
      ...localBase,
      localCheckAvailable: true,
      localEndpointCatalogs: {
        [localEndpoint]: {
          ...explicitModelCatalog(
            LOCAL_PROVIDER_ID,
            ["qwen3-coder-30b-a3b-instruct", "deepseek-coder"],
            ["endpoint default"],
          ),
          stale: true,
        },
      },
    })
    const model = sources.find(
      (s) => s.field === "model" && s.value === "deepseek-coder",
    )
    expect(model).toBeDefined()
    expect(model?.display).toContain("unavailable")
  })
})


test("isolated App Server pointers and store metadata are distinct from Exec", () => {
  const env = { HOME: "/tmp", SHELLQ_STATE_DIR: "/tmp/shellq-pointer-fixture" }
  const isolated = codexSessionFile("/tmp", env, "app-server")
  const legacy = codexSessionFile("/tmp", env, "exec")
  expect(isolated).toContain("/ask/codex-app-server-isolated-")
  expect(isolated).not.toBe(legacy)
  expect(codexSessionFile("/tmp", env, "app-server")).toBe(isolated)
  expect(providerRegistry(env).find((item) => item.id === "codex")?.storeRoot).toBe("/tmp/shellq-pointer-fixture/codex-home")
  expect(providerRegistry({ ...env, SHELLQ_CODEX_ASK_ENGINE: "exec" }).find((item) => item.id === "codex")?.storeRoot).toBe("/tmp/.codex")
})

// ---------------------------------------------------------------------------
// SPIKE(local-stream-ask): thinking preview records and the stepped envelope
// ---------------------------------------------------------------------------

describe("streamed local Ask pure layer (spike)", () => {
  test("thinking records are admitted only from the trusted streaming transport", async () => {
    const thinking = JSON.stringify({ t: "thinking", text: "private reasoning step" })
    const final = '{"answer":"authoritative"}'
    const payload = `${thinking}\n${final}`

    const trusted: unknown[] = []
    const trustedRaw = await readAskStream(
      new Response(payload).body!,
      (event) => trusted.push(event),
      false,
      true,
    )
    expect(trusted).toEqual([{ t: "thinking", text: "private reasoning step" }])
    expect(trustedRaw).toBe(final)

    // Every other path treats a thinking line as final bytes, unchanged.
    const untrusted: unknown[] = []
    const untrustedRaw = await readAskStream(
      new Response(payload).body!,
      (event) => untrusted.push(event),
    )
    expect(untrusted).toEqual([])
    expect(untrustedRaw).toBe(payload)
    expect(parseAskResponse(untrustedRaw)).toBeNull()
  })

  test("thinking is sanitized on admission, kept out of the answer text, and bounded separately", async () => {
    const hostile = JSON.stringify({ t: "thinking", text: "thinking\u001b[31m\u202estep" })
    const sanitized: unknown[] = []
    await readAskStream(
      new Response(`${hostile}\n{"answer":"body"}`).body!,
      (event) => sanitized.push(event),
      false,
      true,
    )
    // The CSI sequence is stripped and the bidi control is escaped, exactly
    // as answer deltas are treated.
    expect(sanitized).toEqual([{ t: "thinking", text: "thinking\\u{202e}step" }])

    let state = appendAskPreview(
      { note: "", text: "", thinking: "" },
      { t: "thinking", text: "private reasoning" },
    )
    state = appendAskPreview(state, { t: "delta", text: "answer body" })
    expect(state.thinking).toBe("private reasoning")
    expect(state.text).toBe("answer body")

    const oversized = appendAskPreview(
      { note: "", text: "", thinking: "" },
      { t: "thinking", text: "x".repeat(ASK_ANSWER_MAX_BYTES + 1) },
    )
    expect(new TextEncoder().encode(oversized.thinking).byteLength).toBe(ASK_ANSWER_MAX_BYTES)
    // Answer and thinking bounds never consume each other.
    expect(new TextEncoder().encode(oversized.text).byteLength).toBe(0)
  })

  test("the Ask streaming envelope steps 4/8/12/16 and caps at the terminal", () => {
    expect(ASK_STREAM_MAX_FOOTER_HEIGHT).toBe(16)
    // contentLines includes the composer row; the two border rows are added
    // before stepping, so six content rows fit the eight-row envelope.
    expect(steppedAskFooterHeight(1, 40)).toBe(4)
    expect(steppedAskFooterHeight(READER_FOOTER_HEIGHT - 2, 40)).toBe(READER_FOOTER_HEIGHT)
    expect(steppedAskFooterHeight(READER_FOOTER_HEIGHT - 1, 40)).toBe(DETAILS_FOOTER_HEIGHT)
    expect(steppedAskFooterHeight(DETAILS_FOOTER_HEIGHT - 2, 40)).toBe(DETAILS_FOOTER_HEIGHT)
    expect(steppedAskFooterHeight(DETAILS_FOOTER_HEIGHT - 1, 40)).toBe(ASK_STREAM_MAX_FOOTER_HEIGHT)
    expect(steppedAskFooterHeight(400, 40)).toBe(ASK_STREAM_MAX_FOOTER_HEIGHT)
    // Physical-terminal ceiling: the ZLE prompt keeps one row.
    expect(steppedAskFooterHeight(400, 10)).toBe(9)
    expect(steppedAskFooterHeight(400, 3)).toBe(2)
    // The receipt accepts the new maximum and nothing beyond it.
    expect(steppedAskFooterHeight(400, 17)).toBe(16)
  })

  test("streaming and completed answers request the stepped envelope; other states are unchanged", () => {
    const base = {
      actionsOpen: false,
      composerLines: 1,
      editorMode: "composer" as const,
      intent: "ask" as const,
      previewVisible: false,
      settingsOpen: false,
      view: "main" as const,
    }
    expect(requestedFooterHeight({ ...base, phase: "loading" })).toBe(4)
    expect(
      requestedFooterHeight({ ...base, phase: "streaming", askContentLines: 2, terminalRows: 40 }),
    ).toBe(4)
    expect(
      requestedFooterHeight({ ...base, phase: "streaming", askContentLines: 8, terminalRows: 40 }),
    ).toBe(DETAILS_FOOTER_HEIGHT)
    expect(
      requestedFooterHeight({ ...base, phase: "streaming", askContentLines: 9, terminalRows: 12 }),
    ).toBe(11)
    expect(
      requestedFooterHeight({ ...base, phase: "answer", askContentLines: 30, terminalRows: 40 }),
    ).toBe(ASK_STREAM_MAX_FOOTER_HEIGHT)
    // Command loading before a candidate stays a compact three-row frame.
    expect(
      requestedFooterHeight({ ...base, intent: "generate", phase: "loading" }),
    ).toBe(COMPACT_FOOTER_HEIGHT)
  })

  test("a configured maximum bounds every surface while omitted maxRows changes nothing", () => {
    expect([...FOOTER_MAX_ROWS_OPTIONS]).toEqual([8, 12, 16])
    expect(DEFAULT_FOOTER_MAX_ROWS).toBe(12)
    const base = {
      actionsOpen: false,
      composerLines: 1,
      editorMode: "composer" as const,
      intent: "ask" as const,
      previewVisible: false,
      settingsOpen: false,
      terminalRows: 40,
      view: "main" as const,
    }
    for (const maxRows of FOOTER_MAX_ROWS_OPTIONS) {
      // Ask streaming and the completed answer stop at the cap.
      expect(steppedAskFooterHeight(400, 40, maxRows)).toBe(maxRows)
      expect(
        requestedFooterHeight({ ...base, phase: "streaming", askContentLines: 400, maxRows }),
      ).toBe(maxRows)
      expect(
        requestedFooterHeight({ ...base, phase: "answer", askContentLines: 400, maxRows }),
      ).toBe(maxRows)
      // Candidate content is pinned by the eight-row promotion floor; at cap
      // eight that floor and the cap coincide.
      expect(
        requestedFooterHeight({
          ...base, intent: "generate" as const, phase: "candidate",
          candidateContentLines: 400, maxRows,
        }),
      ).toBe(Math.max(READER_FOOTER_HEIGHT, maxRows))
      // Details and Doctor take the smallest fitting of twelve and the cap.
      expect(requestedFooterHeight({ ...base, phase: "loading", view: "details", maxRows })).toBe(
        Math.min(DETAILS_FOOTER_HEIGHT, maxRows),
      )
      expect(requestedFooterHeight({ ...base, phase: "loading", view: "doctor", maxRows })).toBe(
        Math.min(DETAILS_FOOTER_HEIGHT, maxRows),
      )
      // Fixed eight-row surfaces stay untouched; they are the floor at the
      // minimum offered cap.
      expect(requestedFooterHeight({ ...base, phase: "loading", settingsOpen: true, maxRows })).toBe(READER_FOOTER_HEIGHT)
      expect(requestedFooterHeight({ ...base, phase: "loading", actionsOpen: true, maxRows })).toBe(READER_FOOTER_HEIGHT)
      expect(requestedFooterHeight({ ...base, phase: "loading", editorMode: "prompt", maxRows })).toBe(READER_FOOTER_HEIGHT)
      // The wrapping compact composer is bounded by the same cap.
      expect(
        requestedFooterHeight({
          ...base, intent: "generate" as const, phase: "loading", composerLines: 400, maxRows,
        }),
      ).toBe(Math.min(maxRows, READER_FOOTER_HEIGHT, COMPACT_FOOTER_HEIGHT + 399))
    }
    // The physical terminal still wins over any cap.
    expect(steppedAskFooterHeight(400, 10, 16)).toBe(9)
    expect(
      requestedFooterHeight({ ...base, phase: "answer", askContentLines: 400, terminalRows: 10, maxRows: 16 }),
    ).toBe(9)
    // Smaller caps keep Ask's four-row starting frame usable.
    expect(steppedAskFooterHeight(1, 40, 8)).toBe(4)
  })
})


test("paused streaming follows retained sequences through eviction and repeated lines", () => {
  expect(retainedPreviewOffset(["label", "same", "same", "tail"], ["label", "same", "same", "tail more"], 2)).toBe(2)
  expect(retainedPreviewOffset(["label", "old", "same", "anchor", "same", "unique", "tail"], ["label", "same", "unique", "tail more"], 4)).toBe(1)
  expect(retainedPreviewOffset(["label", "evicted", "old", "tail"], ["label", "new", "tail more"], 1)).toBe(0)
})


test("reader rows are chronological and roles do not come from answer prose", () => {
  const conversation = appendAskTurn(appendAskTurn(emptyAskConversation(), {question:"First",answer:"you: literal answer"}), {question:"Second",answer:"Thinking: still an answer"})
  const rows = askConversationRows(conversation, 80)
  expect(rows.map(row => row.text)).toEqual(["You: First", "you: literal answer", "", "You: Second", "Thinking: still an answer"])
  expect(rows.map(row => row.kind)).toEqual(["question", "answer", "separator", "question", "answer"])
  expect(conversation.turns[0]!.question).toBe("Second")
  const rail = topRail({intent:"ask",provider:"Local",model:"Qwen",reasoning:"endpoint default"}, 100, true)
  expect(rail.text).not.toContain("endpoint default")
  expect(rail.text.endsWith("Local · Qwen")).toBe(true)
  expect(rail.spans.reasoning).toBeNull()
})


test("thinking preferences stay scoped, preserve selections and reset independently", () => {
  const root = mkdtempSync(join(tmpdir(), "shellq-thinking-"))
  const env = { SHELLQ_STATE_DIR: root }
  const endpoint = "http://127.0.0.1:8080/v1"
  try {
    writePersistedInferenceSettings("gpt-5.6-luna", "low", env, "codex")
    writePersistedLocalThinking(endpoint, "qwen", false, env)
    writePersistedLocalThinking(endpoint, "other", true, env)
    writePersistedLocalThinking("http://127.0.0.1:9000/v1", "qwen", true, env)
    let state = readPersistedInferenceDocumentState(env)
    expect(state.kind).toBe("valid")
    if (state.kind !== "valid") throw new Error("missing settings")
    expect(state.document.localThinking).toHaveLength(3)
    expect(state.document.providers.codex).toEqual({model:"gpt-5.6-luna",reasoning:"low"})
    writePersistedLocalThinking(endpoint, "qwen", undefined, env)
    state = readPersistedInferenceDocumentState(env)
    expect(state.kind === "valid" && state.document.localThinking?.length).toBe(2)
    expect(localAdapterEnvironment({PATH:"/bin",SHELLQ_LOCAL_OPENAI_THINKING:"on"},endpoint,{model:"qwen"})).not.toHaveProperty("SHELLQ_LOCAL_OPENAI_THINKING")
    expect(localAdapterEnvironment({PATH:"/bin"},endpoint,{model:"qwen",thinking:false}).SHELLQ_LOCAL_OPENAI_THINKING).toBe("off")
  } finally { rmSync(root, {recursive:true,force:true}) }
})


test("response metrics accept only numeric reported values and stay out of answers", async () => {
  expect(parseResponseMetrics({outputTokens:84,tokensPerSecond:40})).toEqual({outputTokens:84,tokensPerSecond:40})
  for (const invalid of [{outputTokens:-1},{outputTokens:1.5},{tokensPerSecond:Infinity},{tokensPerSecond:"40"},{outputTokens:2,secret:"x"}]) expect(parseResponseMetrics(invalid)).toBeNull()
  expect(responseSummary(2100)).toBe("2.1s")
  expect(responseSummary(2100,{outputTokens:84,tokensPerSecond:40},true)).toBe("2.1s · 84 tokens · 40.0 tok/s")
  let metrics: unknown
  const wire='{"t":"metrics","metrics":{"outputTokens":84}}\n{"answer":"validated text"}'
  const result=await readAskStream(new Response(wire).body!,()=>{},true,true,value=>{metrics=value})
  expect(JSON.parse(result)).toEqual({answer:"validated text"})
  expect(metrics).toEqual({outputTokens:84})
  const untrusted=await readAskStream(new Response(wire).body!,()=>{})
  expect(untrusted).toBe(wire)
})


test("global metrics display preference survives other settings writes and validates strictly", () => {
  const root=mkdtempSync(join(tmpdir(),"shellq-metrics-preference-"))
  const env={SHELLQ_STATE_DIR:root}
  try {
    writePersistedMetricsExpanded(false,env)
    writePersistedInferenceSettings("gpt-5.6-luna","low",env,"codex")
    writePersistedLocalThinking("http://127.0.0.1:8080/v1","qwen",true,env)
    let state=readPersistedInferenceDocumentState(env)
    expect(state.kind==="valid" && state.document.metricsExpanded).toBe(false)
    writePersistedMetricsExpanded(true,env)
    state=readPersistedInferenceDocumentState(env)
    if(state.kind!=="valid") throw new Error("missing preferences")
    expect(state.document.metricsExpanded).toBe(true)
    expect(state.document.localThinking).toHaveLength(1)
    expect(state.document.providers.codex?.model).toBe("gpt-5.6-luna")
    writeFileSync(inferenceSettingsFile(env),JSON.stringify({...state.document,metricsExpanded:"false"}))
    expect(readPersistedInferenceDocumentState(env).kind).toBe("invalid")
    expect(()=>writePersistedMetricsExpanded(false,env)).toThrow("settings need repair")
  } finally {rmSync(root,{recursive:true,force:true})}
})


test("SQ-10 ranks exact confidence with stable ties and preserves rejected admission", () => {
  const first = {...candidate("echo first"), confidence:0.8}
  const high = {...candidate("echo high"), confidence:0.95}
  const low = {...candidate("echo low"), confidence:0.7}
  const tied = {...candidate("echo tied"), confidence:0.8}
  let items = appendCandidate([], first)
  items = appendCandidate(items, high)
  items = appendCandidate(items, low)
  items = appendCandidate(items, tied)
  expect(items).toEqual([high, first, tied, low])
  expect(items.indexOf(tied)).toBe(2)
  expect(appendCandidate(items, {...first, confidence:1})).toBe(items)
  expect(appendCandidate(items, {...first, corrected_command:null})).toBe(items)
  const fifth = {...candidate("echo fifth"),confidence:0.80001}
  items = appendCandidate(items, fifth)
  expect(items).toEqual([high, fifth, first, tied, low])
  expect(appendCandidate(items, candidate("echo sixth"))).toBe(items)
})


describe("batch candidates", () => {
  test("opts in without changing single consumers and validates the entire batch", () => {
    const initial = buildProviderRequest(session, "generate", "list files", "", false, [], 3)
    expect(initial.candidate_count).toBe(3)
    expect(initial.instructions).toContain("important flags")
    expect(initial.response_schema).toHaveProperty("candidates")
    expect(buildProviderRequest(session, "generate", "list files", "", false, [])).not.toHaveProperty("candidate_count")
    const responses = [candidate("ls -a"), {...candidate("find . -maxdepth 1"), confidence:0.95}, candidate("printf '%s\\n' ./*")]
    const parsed = parseProviderResponses(JSON.stringify({candidates:responses}), true, 3)!
    expect(parsed.reduce(appendCandidate, []).map(c=>c.corrected_command)).toEqual([responses[1]!.corrected_command, responses[0]!.corrected_command, responses[2]!.corrected_command])
    expect(parseProviderResponses(JSON.stringify(responses[0]))).toEqual([responses[0]!])
    expect(parseProviderResponses(JSON.stringify({candidates:[responses[0]]}), true, 3)).toEqual([responses[0]!])
    const diagnostic = {...candidate("unused"), corrected_command:null}
    expect(parseProviderResponses(JSON.stringify({candidates:[diagnostic]}), false, 3)).toEqual([diagnostic])
    for (const value of [
      {candidates:[]}, {candidates:[...responses,responses[0]]},
      {candidates:[responses[0],responses[0]]}, {candidates:[responses[0],{...responses[1],confidence:2}]},
      {candidates:[{...responses[0],extra:true}]}, {candidates:responses,extra:true},
      {candidates:[diagnostic,responses[0]]}, {candidates:[diagnostic,diagnostic]},
    ]) expect(parseProviderResponses(JSON.stringify(value), false, 3)).toBeNull()
    expect(parseProviderResponses(JSON.stringify({candidates:[diagnostic]}), true, 3)).toBeNull()
    expect(parseProviderResponses(JSON.stringify(responses[0]),true,3)).toBeNull()
    expect(parseProviderResponses('{',true,3)).toBeNull()
  })
})

 test("initial choice counts persist globally and preserve unrelated settings", () => {
  const root=mkdtempSync(join(tmpdir(),"shellq-counts-"));const env={SHELLQ_STATE_DIR:root}
  try {
    writePersistedMetricsExpanded(false,env)
    for(const count of [1,2,3,4,5] as const) {
      writePersistedInitialChoices(count,env)
      expect(readPersistedInferenceDocument(env)?.initialChoices).toBe(count)
      expect(readPersistedInferenceDocument(env)?.metricsExpanded).toBe(false)
    }
    expect(()=>writePersistedInitialChoices(6 as 5,env)).toThrow("invalid initial choices")
    const settings=JSON.parse(readFileSync(inferenceSettingsFile(env),"utf8"));settings.initialChoices="3"
    writeFileSync(inferenceSettingsFile(env),JSON.stringify(settings))
    expect(readPersistedInferenceDocument(env)).toBeNull()
    expect(()=>writePersistedInitialChoices(3,env)).toThrow("settings need repair")
  } finally {rmSync(root,{recursive:true,force:true})}
})
test("the maximum footer rows persists globally and preserves unrelated settings", () => {
  const root=mkdtempSync(join(tmpdir(),"shellq-footer-max-"));const env={SHELLQ_STATE_DIR:root}
  try {
    writePersistedMetricsExpanded(false,env)
    writePersistedInitialChoices(3,env)
    writePersistedInferenceSettings("gpt-5.6-luna","low",env,"codex")
    writePersistedLocalThinking("http://127.0.0.1:8080/v1","qwen",true,env)
    for(const rows of FOOTER_MAX_ROWS_OPTIONS) {
      writePersistedMaxFooterRows(rows,env)
      const document=readPersistedInferenceDocument(env)
      expect(document?.maxFooterRows).toBe(rows)
      expect(document?.metricsExpanded).toBe(false)
      expect(document?.initialChoices).toBe(3)
      expect(document?.providers.codex).toEqual({model:"gpt-5.6-luna",reasoning:"low"})
      expect(document?.localThinking).toHaveLength(1)
    }
    expect(()=>writePersistedMaxFooterRows(6 as 16,env)).toThrow("invalid footer maximum")
    const settings=JSON.parse(readFileSync(inferenceSettingsFile(env),"utf8"));settings.maxFooterRows="12"
    writeFileSync(inferenceSettingsFile(env),JSON.stringify(settings))
    expect(readPersistedInferenceDocument(env)).toBeNull()
    expect(()=>writePersistedMaxFooterRows(12,env)).toThrow("settings need repair")
    // A pre-existing document without the key reads back absent; the caller
    // applies its default.
    writeFileSync(inferenceSettingsFile(env),JSON.stringify({version:2,provider:"codex",providers:{codex:{model:"m",reasoning:"low"}}}))
    expect(readPersistedInferenceDocument(env)?.maxFooterRows).toBeUndefined()
  } finally {rmSync(root,{recursive:true,force:true})}
})
test("Command and Fix previews stop growing at twelve while results can grow to sixteen", () => {
  const base={actionsOpen:false, composerLines:1,editorMode:"composer" as const,previewVisible:false,settingsOpen:false,view:"main" as const,terminalRows:40}
  for(const intent of ["generate","correct"] as const) {
    expect(requestedFooterHeight({...base,intent,phase:"streaming",askContentLines:100})).toBe(12)
    expect(requestedFooterHeight({...base,intent,phase:"candidate",candidateContentLines:14})).toBe(16)
    expect(requestedFooterHeight({...base,intent,phase:"streaming",askContentLines:100,terminalRows:9})).toBe(8)
  }
  expect(requestedFooterHeight({...base,intent:"ask",phase:"streaming",askContentLines:100})).toBe(16)
})
