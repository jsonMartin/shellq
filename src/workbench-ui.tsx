/* @jsxImportSource @opentui/react */
import { parseLocalEndpoint } from "./local-endpoint"
import { writeFileSync } from "node:fs"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { CliRenderEvents, TextAttributes, ScrollBarRenderable } from "@opentui/core"
import type {
  BorderCharacters,
  CliRenderer,
  MouseEvent as OpenTuiMouseEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core"
import {
  createRoot,
  extend,
  flushSync,
  useKeyboard,
  useTerminalDimensions,
} from "@opentui/react"

import { KeyValue } from "@/components/ui/key-value"
import { Spinner } from "@/components/ui/spinner"
import { StatusMessage } from "@/components/ui/status-message"
import { ThemeProvider, useTheme, useUnicode } from "@/components/ui/theme-provider"
import { defaultTheme } from "@/lib/terminal-themes/default"

declare module "@opentui/react" {
  interface OpenTUIComponents { shellqScrollbar: typeof ScrollBarRenderable }
}
extend({shellqScrollbar: ScrollBarRenderable})

import {
  ASK_QUERY_MAX_BYTES,
  CANDIDATE_LIMIT,
  COMPACT_FOOTER_HEIGHT,
  ASK_PREVIEW_INPUT_MAX_BYTES,
  INTERIOR_ORIGIN_X,
  LOCAL_NO_ACTIVE_MODEL_DETAIL,
  LOCAL_PROVIDER_ID,
  LOCAL_SCAN_MAX_BYTES,
  LOCAL_SCAN_MODE,
  LOCAL_TERMINATION_GRACE_MS,
  RESPONSE_MAX_BYTES,
  responseSummary,
  type ResponseMetrics,
  TITLE_ORIGIN_X,
  actionsSheetLines,
  appServerFailureMessage,
  appServerCandidateFile,
  appServerPointerDecision,
  adapterPath,
  adapterIsExecutable,
  descriptorForProvider,
  appendAskPreview,
  retainedPreviewOffset,
  appendAskTurn,
  appendCandidate,
  askConversationRows,
  type AskReaderRow,
  askChatWasSaved,
  askProviderArgv,
  bottomRail,
  buildAskRequest,
  buildProviderRequest,
  candidateRowMarker,
  candidateRisk,
  confidenceBand,
  codexInferenceTupleIsTransportSafe,
  codexAskSessionEnvironment,
  commandIsValid,
  composerText,
  contextPreview,
  contextPreviewVisible,
  captureDoctorRows,
  contextualAction,
  ctrlXAction,
  emptyAskConversation,
  explicitModelCatalog,
  finalizeAskSessionPointer,
  frameLayout,
  buildUniversalPaletteSources,
  settingsPaletteSources,
  settingsPaletteRestoredIndex,
  validateCodexModelPages,
  isEditingMode,
  localAdapterEnvironment,
  resolveLocalEndpoint,
  localEndpointUnavailableMessage,
  localScanEndpoints,
  DEFAULT_LOCAL_ENDPOINT,
  EndpointSettingsWriteError,
  writePersistedLocalEndpoint,
  writePersistedLocalSelection,
  localFailureMessage,
  metadataItems,
  metadataWindow,
  modelLabel,
  paletteProviderLabel,
  parseLocalScan,
  normalizeSettingsQuery,
  oneLine,
  parseAskResponse,
  POINTER_REACHABLE_ACTIONS,
  parseProviderResponses,
  providerAskSessionEnvironment,
  providerPointerDecision,
  providerAvailability,
  providerSessionFile,
  providerSetupLines,
  readPersistedInferenceSettings,
  readPersistedInferenceDocumentState,
  readAskStream,
  readBounded,
  requestOutcome,
  resolveProviderId,
  requestedFooterHeight,
  SAFE_MODEL,
  saveContextDraft,
  selectedCommandLines,
  sanitizeContext,
  sliceCells,
  settingsPickerCandidates,
  SETTINGS_PICKER_VISIBLE_ROWS,
  settingsPickerWindow,
  settingsParentIntent,
  steppedConversationOffset,
  switchAskEngine,
  terminalWidth,
  topRail,
  truncateCells,
  universalPaletteStatus,
  verdict,
  visibleShellText,
  wrappedTextLines,
  writePersistedInferenceSettings,
  writePersistedLocalThinking,
  writePersistedMetricsExpanded,
  writePersistedInitialChoices,
  writePersistedMaxFooterRows,
  DEFAULT_FOOTER_MAX_ROWS,
  type ActionsSheetAction,
  type ActionsSheetCell,
  type AskPreviewEvent,
  type EditorMode,
  type DoctorRow,
  type AskChatState,
  type CtrlXAction,
  type CodexAskEngine,
  type ProviderResponse,
  type ProviderId,
  type SessionIntent,
  type SettingsField,
  type SettingsPaletteView,
  type ProviderCapabilityCatalog,
  type UniversalPaletteDestination,
  type UniversalPaletteRecord,
  type WorkbenchPhase,
  type WorkbenchSession,
  type WorkbenchView,
} from "./workbench"
import {
  AppServerSession,
  validateAppServerSessionTurn,
} from "./codex-app-server-session"
import { ProviderFailure } from "./codex-app-server-provider"
import { StructuredPreviewProjector } from "./structured-preview"

export type ActiveProcess = {
  process: { kill: () => void } | null
  session?: AppServerSession | null
  closing?: Promise<void> | null
  preparing?: Promise<void> | null
  prepareCancel?: (() => void) | null
  appServerGeneration?: number
  closed?: boolean
  cancel?: (() => void) | null
  discoveryProcess?: { kill: (signal?: any) => void } | null
  discoveryCancel?: (() => void) | null
  discoveryClosing?: Promise<void> | null
}

type WorkbenchProps = {
  active: ActiveProcess
  askSessionFile: string | null
  askSessionFiles?: Record<CodexAskEngine, string> | null
  initialAskChatSaved: boolean
  initialNotice: string | null
  renderer: CliRenderer
  resultPath: string
  session: WorkbenchSession
  trustedWorkdir: string
}

const INTENTS: SessionIntent[] = ["ask", "generate", "correct"]
const ENGINES: CodexAskEngine[] = ["app-server", "exec"]
const ENGINE_LABELS = ["App Server", "Codex Exec"]

// Sourced from the pure layer so the safety rule has one definition and a
// test can assert against the real thing rather than a copy.
const CLICKABLE_ACTIONS = new Set(POINTER_REACHABLE_ACTIONS)

// customBorderChars requires all eleven fields; passing undefined instead
// lets borderStyle="rounded" apply when Unicode is available.
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

const Workbench = ({
  active,
  askSessionFile: initialAskSessionFile,
  askSessionFiles,
  initialAskChatSaved,
  initialNotice,
  renderer,
  resultPath,
  session,
  trustedWorkdir,
}: WorkbenchProps) => {
  const theme = useTheme()
  const unicode = useUnicode()
  const { width, height } = useTerminalDimensions()
  const layout = frameLayout(width)

  const [intent, setIntent] = useState(session.initial_intent)
  const [providerId, setProviderId] = useState<ProviderId | null>(
    session.provider_id !== undefined
      ? session.provider_id
      : resolveProviderId(session.provider),
  )
  const [drafts, setDrafts] = useState<Record<SessionIntent, string>>({
    ask: String(session.requests.ask.input.query ?? ""),
    generate: String(session.requests.generate.input.command ?? ""),
    correct: String(session.requests.correct?.input.command ?? ""),
  })
  const [conversation, setConversation] = useState(emptyAskConversation)
  const [conversationOffset, setConversationOffset] = useState<number | null>(null)
  const [showThinking, setShowThinking] = useState(true)
  const [requestStartedAt, setRequestStartedAt] = useState<number | null>(null)
  const [clockNow, setClockNow] = useState(0)
  const [responseInfo, setResponseInfo] = useState<{elapsedMs:number; firstTextMs?:number; metrics:ResponseMetrics} | null>(null)
  const [metricsExpanded, setMetricsExpanded] = useState(() => {
    const state = readPersistedInferenceDocumentState()
    return state.kind === "valid" ? state.document.metricsExpanded ?? true : true
  })
  const metricsExpandedRef = useRef(metricsExpanded)
  const streamMaxOffsetRef = useRef(0)
  const conversationMaxOffsetRef = useRef(0)
  const [responseActivity, setResponseActivity] = useState("Waiting")

  const [streamOffset, setStreamOffset] = useState<number | null>(null)
  const streamLinesRef = useRef<string[]>([])
  const [askPreview, setAskPreview] = useState({ note: "", text: "", thinking: "" })
  const [diagnosis, setDiagnosis] = useState<string | null>(null)
  const [lastAskQuery, setLastAskQuery] = useState(
    String(session.requests.ask.input.query ?? ""),
  )
  const [askChatSaved, setAskChatSaved] = useState(initialAskChatSaved)
  const [newAskSession, setNewAskSession] = useState(false)
  const [candidates, setCandidates] = useState<ProviderResponse[]>([])
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [context, setContext] = useState(sanitizeContext(session.context.text))
  const [includeByIntent, setIncludeByIntent] = useState<
    Record<SessionIntent, boolean>
  >({
    ask: false,
    generate: false,
    correct: session.actionable_failure && session.context.included,
  })
  const [modelIndex, setModelIndex] = useState(
    Math.max(0, session.models.indexOf(session.model)),
  )
  const [reasoningIndex, setReasoningIndex] = useState(
    Math.max(0, session.reasoning_levels.indexOf(session.reasoning)),
  )
  const [engineIndex, setEngineIndex] = useState(
    session.codex_ask_engine === "exec" ? 1 : 0,
  )
  const [editorMode, setEditorMode] = useState<EditorMode>("composer")
  const [view, setView] = useState<WorkbenchView>("main")
  const [actionsOpen, setActionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<false | "setup" | "picker">(
    session.provider_source === "default" &&
      (session.provider_id !== undefined
        ? session.provider_id
        : resolveProviderId(session.provider)) === null
      ? "setup"
      : false,
  )
  const [settingsField, setSettingsField] = useState<SettingsField>(
    session.provider_source === "default" &&
      (session.provider_id !== undefined
        ? session.provider_id
        : resolveProviderId(session.provider)) === null
      ? "provider"
      : "model",
  )
  const [pickerScope, setPickerScope] = useState<SettingsField | null>(null)
  const [paletteView, setPaletteView] = useState<SettingsPaletteView>("root")
  const [codexCatalog, setCodexCatalog] = useState<ProviderCapabilityCatalog | null>(null)
  const [codexDiscoveryState, setCodexDiscoveryState] = useState<"loading" | "dynamic" | "fallback">("fallback")
  // The published per-endpoint local catalogs, keyed by exact endpoint URL.
  // They start empty on every mount — nothing is restored from settings — so
  // opening any surface only ever sends the bounded automatic probe list.
  const [localCatalogs, setLocalCatalogs] = useState<Record<string, ProviderCapabilityCatalog>>({})
  const [localChecking, setLocalChecking] = useState(false)
  const [pickerQuery, setPickerQuery] = useState("")
  const [pickerIndex, setPickerIndex] = useState(0)
  const [pickerStatus, setPickerStatus] = useState("")
  const [pickerRevision, setPickerRevision] = useState(0)
  const [footerHeight, setFooterHeight] = useState(COMPACT_FOOTER_HEIGHT)
  const requestedPeakRef = useRef(COMPACT_FOOTER_HEIGHT)
  const [phase, setPhase] = useState<WorkbenchPhase>("ready")
  const [detail, setDetail] = useState(initialNotice ?? "")
  const [contextEdited, setContextEdited] = useState(false)
  const [detailIndex, setDetailIndex] = useState(0)
  const [detailOffset, setDetailOffset] = useState(0)
  const [doctorRows, setDoctorRows] = useState<DoctorRow[]>([])
  const [composerLines, setComposerLines] = useState(1)
  const [composerRevision, setComposerRevision] = useState(0)

  const composerRef = useRef<TextareaRenderable | null>(null)
  const pickerInputRef = useRef<TextareaRenderable | null>(null)
  const editorRef = useRef<TextareaRenderable | null>(null)
  const endpointRef = useRef<TextareaRenderable | null>(null)
  const endpointDraftRef = useRef("")
  const [initialChoices, setInitialChoices] = useState<1 | 2 | 3 | 4 | 5>(() => {
    const state = readPersistedInferenceDocumentState()
    return state.kind === "valid" ? state.document.initialChoices ?? 3 : 3
  })
  const initialChoicesRef = useRef(initialChoices)
  // The cap is frozen for this invocation: the live band must not re-read a
  // mid-session save, so mount-time state and the picker's saved marker stay
  // separate values.
  const [sessionMaxFooterRows] = useState<8 | 12 | 16>(() => {
    const state = readPersistedInferenceDocumentState()
    return state.kind === "valid" ? state.document.maxFooterRows ?? DEFAULT_FOOTER_MAX_ROWS : DEFAULT_FOOTER_MAX_ROWS
  })
  const [savedMaxFooterRows, setSavedMaxFooterRows] = useState<8 | 12 | 16>(() => {
    const state = readPersistedInferenceDocumentState()
    return state.kind === "valid" ? state.document.maxFooterRows ?? DEFAULT_FOOTER_MAX_ROWS : DEFAULT_FOOTER_MAX_ROWS
  })
  const savedMaxFooterRowsRef = useRef(savedMaxFooterRows)
  const [initialEndpoint] = useState(() => session.localEndpoint ?? resolveLocalEndpoint(readPersistedInferenceDocumentState(), process.env))
  const endpointStateRef = useRef(initialEndpoint)
  const [localThinkingPreferences, setLocalThinkingPreferences] = useState(() => {
    const state = readPersistedInferenceDocumentState()
    return state.kind === "valid" ? state.document.localThinking ?? [] : []
  })
  const localThinkingPreferencesRef = useRef(localThinkingPreferences)
  const endpointReturnRef = useRef<{ mode: EditorMode; view: WorkbenchView } | null>(null)
  const endpointConfirmationRef = useRef<"save" | "reset" | null>(null)
  const [endpointConfirmation, setEndpointConfirmation] = useState<"save" | "reset" | null>(null)
  const [endpointWarning, setEndpointWarning] = useState(false)
  const [endpointError, setEndpointError] = useState("")
  const endpointApplyingRef = useRef(false)
  const editorDraftRef = useRef<string | null>(null)
  const editorSyncRef = useRef(false)
  // Set immediately before the resync effect below calls the composer's own
  // `setText` so its `onContentChange` (fired for every content change, both
  // programmatic and user-typed) can tell this one apart from a real
  // keystroke and skip clearing `detail` — otherwise a message set the same
  // tick as a phase transition (e.g. "chat saved …") is wiped out moments
  // after its first paint, the same hazard the editor's own resync guards
  // against for `initialNotice`.
  const composerSyncRef = useRef(false)
  // Snapshots the composer's plainText at submit time. The native buffer
  // updates synchronously as each character is typed, but its
  // `onContentChange` notifications can still be in flight when Enter is
  // pressed right after a fast/pasted burst of typing, arriving only after
  // submit already read and acted on the same text (e.g. rejecting an
  // invalid Ask chat pointer). Comparing against this snapshot lets
  // `onContentChange` recognize those as stale echoes of already-handled
  // content and skip clearing `detail`, without suppressing a genuinely new
  // keystroke typed after submit.
  const submittedComposerTextRef = useRef<string | null>(null)
  const candidateDescriptionRef = useRef<ScrollBoxRenderable | null>(null)
  const busyRef = useRef(false)
  const doctorActiveRef = useRef(false)
  const cancelledRef = useRef(false)
  const requestTokenRef = useRef(0)
  const candidatesRef = useRef<ProviderResponse[]>([])
  const candidateIndexRef = useRef(0)
  const editedCandidatesRef = useRef(new WeakSet<ProviderResponse>())
  const ctrlXRef = useRef(false)
  const actionsOpenRef = useRef(false)
  const editorModeRef = useRef<EditorMode>("composer")
  const intentRef = useRef(session.initial_intent)
  // One stdin chunk can contain Tab, Ctrl-X, and a letter before the user has
  // seen the new mode; that chunk must not resolve an action for either mode.
  const intentChangedThisTickRef = useRef(false)
  // Counts every genuinely new candidate the whole session has ever
  // produced (never reset by an intent switch, unlike `candidates` itself).
  // `insertActionTaught` below is `count > 1`: the very first candidate the
  // session ever shows reads `count === 1` at the moment its own render
  // happens, so it still gets the full "Enter insert (never runs)" text;
  // every candidate after it reads `count >= 2` and gets the short form.
  const candidatesEverCreatedRef = useRef(0)
  const setupRetirementRef = useRef<Promise<void> | null>(null)
  const setupDismissalPendingRef = useRef(false)
  const pickerIndexRef = useRef(0)
  const paletteViewRef = useRef<SettingsPaletteView>("root")
  const pickerApplyingRef = useRef(false)
  const pickerRetirementRejectedRef = useRef(false)
  const pickerExitCauseRef = useRef<"escape" | "route" | null>(null)
  const pickerQuerySyncRef = useRef<string | null>(null)
  const pickerNavigationQueryRef = useRef<string | null>(null)
  const pickerActivationEpochRef = useRef(0)
  const pickerPaintedEpochRef = useRef(0)
  const codexDiscoveryStartedRef = useRef(false)
  const stagedCodexCatalogRef = useRef<ProviderCapabilityCatalog | null>(null)
  const stagedLocalCatalogRef = useRef<{ catalogs: Record<string, ProviderCapabilityCatalog>; isExplicit: boolean } | null>(null)
  const localDiscoveryExplicitRef = useRef(false)
  const localCatalogsRef = useRef<Record<string, ProviderCapabilityCatalog>>({})
  const mountedRef = useRef(true)
  const blockedLocalModelsRef = useRef(new Set<string>())
  const localDiscoveryRunningRef = useRef(false)
  const localDiscoveryIdentityRef = useRef(0)
  const localDiscoveryProcessRef = useRef<Bun.Subprocess<"pipe", "pipe", "pipe"> | null>(null)
  const localDiscoveryRetiringRef = useRef<Promise<void> | null>(null)
  const localDiscoveryCancelRef = useRef<(() => void) | null>(null)

  // One place decides whether a local turn may be submitted. The pair, not
  // the model alone, must still be current: the same ID on another endpoint
  // is a different choice.
  const localActivationIsCurrent = (candidateEndpoint: string | null | undefined, candidateModel: string) =>
    Boolean(
      candidateEndpoint &&
      candidateModel &&
      SAFE_MODEL.test(candidateModel) &&
      !blockedLocalModelsRef.current.has(`${candidateEndpoint} ${candidateModel}`),
    )

  // Confirmed termination, not merely requested. An adapter blocked on a
  // socket read can miss a single graceful signal and would otherwise survive
  // to its own 900s ceiling — or past terminal hangup — so escalate to an
  // unmaskable kill after a bounded grace period and settle only on the real
  // exit. Callers await this before treating the work as finished.
  const confirmTermination = (
    child: { exited: Promise<number>; kill: (signal?: number | NodeJS.Signals) => void },
    graceMs = LOCAL_TERMINATION_GRACE_MS,
  ): Promise<void> => {
    try {
      child.kill("SIGTERM")
    } catch {}
    const forced = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {}
    }, graceMs)
    return child.exited.then(
      () => clearTimeout(forced),
      () => clearTimeout(forced),
    )
  }

  const trackLocalTermination = (
    child: { exited: Promise<number>; kill: (signal?: number | NodeJS.Signals) => void },
    graceMs = LOCAL_TERMINATION_GRACE_MS,
  ): Promise<void> => {
    const prior = active.closing?.catch(() => {}) ?? Promise.resolve()
    const terminating = confirmTermination(child, graceMs)
    const retiring = Promise.all([prior, terminating]).then(() => {})
    active.closing = retiring
    const release = () => {
      if (active.closing === retiring) active.closing = null
    }
    void retiring.then(release, release)
    return retiring
  }

  const stopLocalDiscovery = (): Promise<void> => {
    localDiscoveryIdentityRef.current += 1
    const child = localDiscoveryProcessRef.current
    localDiscoveryProcessRef.current = null
    localDiscoveryRunningRef.current = false
    stagedLocalCatalogRef.current = null
    if (mountedRef.current) setLocalChecking(false)
    if (active.discoveryProcess === child) active.discoveryProcess = null
    if (active.discoveryCancel === localDiscoveryCancelRef.current) active.discoveryCancel = null
    localDiscoveryCancelRef.current = null
    if (child) {
      const prior = (active.discoveryClosing ?? localDiscoveryRetiringRef.current)?.catch(() => {}) ?? Promise.resolve()
      const terminating = confirmTermination(child)
      const retiring = Promise.all([prior, terminating]).then(() => {})
      localDiscoveryRetiringRef.current = retiring
      active.discoveryClosing = retiring
      const release = () => {
        if (localDiscoveryRetiringRef.current === retiring) localDiscoveryRetiringRef.current = null
        if (active.discoveryClosing === retiring) active.discoveryClosing = null
      }
      void retiring.then(release, release)
      return retiring
    }
    return active.discoveryClosing ?? localDiscoveryRetiringRef.current ?? Promise.resolve()
  }

  const applyCandidates = (next: ProviderResponse[]) => {
    candidatesRef.current = next
    setCandidates(next)
  }

  const changePaletteView = (next: SettingsPaletteView) => {
    paletteViewRef.current = next
    setPaletteView(next)
  }

  const changeEditorMode = (next: EditorMode) => {
    if (editorModeRef.current === "endpoint" && endpointReturnRef.current) return
    editorModeRef.current = next
    setEditorMode(next)
  }

  const changeIntent = (next: SessionIntent) => {
    intentRef.current = next
    setIntent(next)
  }

  const closeActions = () => {
    ctrlXRef.current = false
    actionsOpenRef.current = false
    setActionsOpen(false)
  }

  const openActions = () => {
    actionsOpenRef.current = true
    setActionsOpen(true)
  }

  const moveCandidate = (direction: -1 | 1) => {
    const total = candidatesRef.current.length
    if (!total) return
    candidateIndexRef.current =
      (candidateIndexRef.current + direction + total) % total
    setCandidateIndex(candidateIndexRef.current)
    setDetail("")
  }

  // Clicking a candidate selects it — the same review-only outcome as
  // Up/Down/Left/Right — and never inserts, submits, or executes.
  const selectCandidateIndex = (index: number) => {
    if (index === candidateIndexRef.current) return
    candidateIndexRef.current = index
    setCandidateIndex(index)
    setDetail("")
  }

  const allProviderChoices = providerAvailability().map((item) => ({
    ...item,
    enabled: item.selectable && !(
      item.id === "codex" &&
      codexCatalog !== null &&
      codexCatalog.models.length === 0
    ) &&
      // Setup reports the local provider as managed but never selects it: a
      // provider-granularity switch is exactly the move that would bind local
      // without naming an exact model. The palette owns that choice.
      item.id !== LOCAL_PROVIDER_ID,
  }))
  const setupOpen = settingsOpen === "setup"
  const providerChoices = (setupOpen
    ? allProviderChoices
    : allProviderChoices.filter((item) => item.enabled))
  const providerIndex = Math.max(
    0,
    providerChoices.findIndex((item) => item.id === providerId),
  )
  const providerDescriptor = providerId ? descriptorForProvider(providerId) : null
  const dynamicCodexModels = providerId === "codex" && codexCatalog
    ? codexCatalog.models.map((item) => item.model)
    : null
  const dynamicCodexEfforts = providerId === "codex" && codexCatalog
    ? codexCatalog.models.find((item) => item.model === session.model)?.efforts ?? []
    : null
  const modelChoices = dynamicCodexModels ?? session.models
  const reasoningChoices = dynamicCodexEfforts ?? session.reasoning_levels
  const effectiveModelIndex = dynamicCodexModels
    ? Math.max(0, dynamicCodexModels.indexOf(session.model))
    : modelIndex
  const effectiveReasoningIndex = dynamicCodexEfforts
    ? Math.max(0, dynamicCodexEfforts.indexOf(session.reasoning))
    : reasoningIndex
  const provisionalCodexTuple = providerId === "codex" &&
    session.provider_source === "default" &&
    codexInferenceTupleIsTransportSafe(session.model, session.reasoning)
  const model = dynamicCodexModels || provisionalCodexTuple
    ? session.model
    : modelChoices[modelIndex] ?? session.model
  const reasoning = dynamicCodexEfforts || provisionalCodexTuple
    ? session.reasoning
    : reasoningChoices[reasoningIndex] ?? session.reasoning
  const codexEngineAvailable = session.provider_source === "default" &&
    allProviderChoices.some((item) => item.id === "codex" && item.selectable)
  const codexEngine = codexEngineAvailable
    ? session.codex_ask_engine ?? ENGINES[engineIndex]
    : null
  const engine = providerId === "codex" ? codexEngine : null
  // Local Ask is one-shot with no pointer: no file is read, written, or
  // finalized, and Doctor's existing no-pointer row therefore reports the
  // truth without Doctor changing.
  const askSessionFile =
    providerId === LOCAL_PROVIDER_ID
      ? null
      : providerId === "codex" && engine && askSessionFiles
        ? askSessionFiles[engine]
        : providerId
          ? providerSessionFile(providerId, trustedWorkdir)
          : initialAskSessionFile
  const managedProviderAvailable = () =>
    session.provider_source !== "default" ||
    (providerId !== null && providerAvailability().some(
      (item) => item.id === providerId && item.selectable,
    ))
  const candidate = candidates[candidateIndex] ?? null
  useEffect(() => {
    candidateDescriptionRef.current?.scrollTo(0)
  }, [candidate])
  const includeContext = includeByIntent[intent]
  const contextBytes = new TextEncoder().encode(context).byteLength
  const contextSource = contextEdited ? "none" : session.context.source
  const contextLabel = contextEdited ? "unavailable" : session.context.label

  const retireAppServerSession = (): Promise<void> => {
    active.appServerGeneration = (active.appServerGeneration ?? 0) + 1
    active.prepareCancel?.()
    active.prepareCancel = null
    active.preparing = null
    const current = active.session
    active.session = null
    if (!current) return active.closing ?? Promise.resolve()
    const prior = active.closing?.catch(() => {}) ?? Promise.resolve()
    const closing = prior.then(() => current.dispose())
    active.closing = closing
    void closing.then(
      () => {
        if (active.closing === closing) active.closing = null
      },
      () => {
        if (active.closing === closing) active.closing = null
      },
    )
    return closing
  }
  const repositoryAccess =
    intent === "ask" && askSessionFile !== null
  const askChatState: AskChatState = !askSessionFile
    ? "one-shot"
    : newAskSession || !askChatSaved
      ? "new"
      : "saved"
  const codexExecStartsNewChat =
    providerId === "codex" &&
    engine === "exec" &&
    (newAskSession || !askChatSaved)

  // A candidate list only exists for Command/Fix, and it is the one surface
  // whose presence isn't already captured by editorMode/view/actionsOpen —
  // this predicate is shared by the render chain and the keyboard routing
  // below so the two can never disagree about which surface is showing.
  const hasCandidateList = intent !== "ask" && candidates.length > 0
  const showComposerRow =
    !actionsOpen &&
    !settingsOpen &&
    !isEditingMode(editorMode) &&
    view === "main" &&
    !hasCandidateList

  const previewVisible = contextPreviewVisible({
    actionsOpen,
    contextBytes,
    editorMode,
    included: includeContext,
    phase,
    settingsOpen: Boolean(settingsOpen),
    view,
  })

  useEffect(() => {
    if (requestStartedAt === null || (phase !== "loading" && phase !== "streaming")) return
    const timer = setInterval(() => setClockNow(performance.now()), 100)
    return () => clearInterval(timer)
  }, [requestStartedAt, phase])
  useEffect(() => { setResponseInfo(null) }, [providerId, model, intent])
  const readerWidth = Math.max(1, layout.interior - 2)
  const hasConversation = intent === "ask" && conversation.turns.length > 0
  const conversationRows = useMemo(
    () => hasConversation ? askConversationRows(conversation, readerWidth) : [],
    [conversation, hasConversation, readerWidth],
  )
  const conversationLines = conversationRows.map(row => row.text)
  const streamRowsModel: AskReaderRow[] = [
    ...(showThinking && askPreview.thinking
      ? wrappedTextLines(askPreview.thinking, readerWidth, "word").map(text => ({ kind: "thinking" as const, text }))
      : []),
    ...(showThinking && askPreview.thinking && askPreview.text ? [{ kind: "separator" as const, text: "" }] : []),
    ...wrappedTextLines(askPreview.text || askPreview.note, readerWidth, "word").map(text => ({ kind: "answer" as const, text })),
  ]
  const streamLines = streamRowsModel.map(row => row.text)
  const thinkingControlVisible = providerId === LOCAL_PROVIDER_ID &&
    view === "main" && !settingsOpen && !actionsOpen && !isEditingMode(editorMode)
  const currentLocalThinking = () => localThinkingPreferencesRef.current.find(item =>
    item.endpoint === endpointStateRef.current.endpoint && item.model === model)?.enabled
  const localThinking = currentLocalThinking()
  const thinkingControl = thinkingControlVisible
    ? `^T thinking ${localThinking === undefined ? "default" : localThinking ? "on" : "off"}${phase === "streaming" || phase === "loading" ? " · next" : ""}` : ""
  const setThinkingPreference = (enabled: boolean | undefined) => {
    const endpoint = endpointStateRef.current.endpoint
    if (!endpoint || !model) { setDetail("select a local model first"); return }
    try {
      const preferences = writePersistedLocalThinking(endpoint, model, enabled)
      // Native key events can submit before React commits this state update.
      localThinkingPreferencesRef.current = preferences
      setLocalThinkingPreferences(preferences)
      setDetail(`next request: thinking ${enabled === undefined ? "uses endpoint default" : enabled ? "on" : "off"}`)
    } catch {
      setDetail("thinking choice not saved · settings need attention")
    }
  }
  const toggleModelThinking = () => setThinkingPreference(!(currentLocalThinking() ?? true))
  const toggleThinking = () => { setShowThinking(value => !value); setStreamOffset(null) }

  const askStreamContentLines = phase === "answer"
    ? conversationLines.length + 1
    : phase === "streaming" ? streamLines.length + 2 : 2

  const risk = candidateRisk(candidate?.risk ?? "Unknown")
  const assessmentColor = (level: "low" | "medium" | "high" | null) =>
    level === "low" ? theme.colors.success : level === "medium" ? theme.colors.warning
      : level === "high" ? theme.colors.error : theme.colors.foreground
  const confidenceLevel = candidate ? confidenceBand(candidate.confidence) : "low"
  const assessmentEdited = candidate !== null && editedCandidatesRef.current.has(candidate)
  const confidenceLabel = candidate ? `${Math.floor(candidate.confidence * 100)}%` : "—"
  const confidenceColor = assessmentEdited ? theme.colors.mutedForeground
    : confidenceLevel === "high" ? theme.colors.success : confidenceLevel === "good" ? theme.colors.warning : theme.colors.error
  const riskLabel = truncateCells(risk.label, Math.max(3, layout.interior - terminalWidth(`Risk:  · Confidence: ${confidenceLabel}`)))
  const riskReason = risk.level && candidate
    ? candidate.risk.trim().replace(/^(low|medium|med|moderate|high)\b[\s:;,.–—-]*/i, "")
    : ""
  const candidateDescription = candidate
    ? `${assessmentEdited ? "Edited; not reassessed\n" : ""}${riskReason ? `Impact: ${riskReason}\n\n` : ""}${candidate.tldr}`
    : ""
  const targetFooterHeight = requestedFooterHeight({
    actionsOpen,
    // Physical height, never useTerminalDimensions().height: in split-footer
    // mode that can report the footer's own current height, which would let
    // the ceiling cap growth at whatever was already promoted.
    askContentLines: askStreamContentLines,
    candidateContentLines: candidates.length + 1 +
      selectedCommandLines(candidate?.corrected_command ?? "", Math.max(8, layout.interior - 5), 16).length +
      wrappedTextLines(candidateDescription, Math.max(4, layout.interior - 1)).length,
    composerLines,
    editorMode,
    intent,
    maxRows: sessionMaxFooterRows,
    phase,
    previewVisible,
    settingsOpen: Boolean(settingsOpen),
    terminalRows: Number.MAX_SAFE_INTEGER,
    view,
  })

  useEffect(() => {
    requestedPeakRef.current = Math.max(requestedPeakRef.current, targetFooterHeight)
    const available = Math.max(1, renderer.terminalHeight - 1)
    const next = Math.min(requestedPeakRef.current, available)
    if (next <= renderer.footerHeight) return
    renderer.footerHeight = next
    setFooterHeight(next)
  }, [renderer, targetFooterHeight, renderer.terminalHeight])

  useEffect(() => {
    if (
      actionsOpen ||
      settingsOpen ||
      !isEditingMode(editorMode) || editorMode === "endpoint"
    ) return
    const editor = editorRef.current
    if (!editor) return
    const draft =
      editorDraftRef.current ??
        (editorMode === "context"
          ? context
          : editorMode === "command"
            ? (candidate?.corrected_command ?? "")
            : drafts[intent])
    if (editor.plainText !== draft) {
      editorSyncRef.current = true
      editor.editBuffer.setText(draft)
    }
    // setText leaves the caret at offset 0, which would make the next
    // keystroke prepend to the restored text instead of continuing it.
    editor.cursorOffset = editor.plainText.length
    editor.showCursor = true
    editor.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsOpen, settingsOpen, editorMode])

  useEffect(() => {
    if (editorMode !== "endpoint" || !endpointRef.current) return
    endpointRef.current.editBuffer.setText(endpointDraftRef.current)
    endpointRef.current.cursorOffset = endpointDraftRef.current.length
    endpointRef.current.focus()
  }, [editorMode])

  // Resyncs the uncontrolled composer textarea's content whenever the
  // resting composer row (re)appears, the mode changes, the phase changes
  // (loading settling into ready/failed/answer), or an explicit chord
  // (Ctrl-X E, Ctrl-X N) requests a fresh value that wouldn't otherwise
  // change these dependencies. The `plainText` guard skips a no-op
  // `setText` (draft already matches, e.g. every fresh mount): the native
  // edit buffer notifies `onContentChange` asynchronously on every `setText`
  // regardless of whether the text actually changed, and that handler
  // clears `detail` — an unrelated `run()`-supplied startup notice would
  // otherwise be clobbered moments after its first paint.
  // Layout timing clears the submitted native text before an answer paints
  // and can accept follow-up typing; a passive effect leaves a concatenation race.
  useLayoutEffect(() => {
    if (!showComposerRow) return
    const editor = composerRef.current
    if (!editor) return
    if (editor.plainText !== drafts[intent]) {
      composerSyncRef.current = true
      editor.editBuffer.setText(drafts[intent])
    }
    editor.cursorOffset = editor.plainText.length
    editor.showCursor = true
    if (phase !== "loading" && phase !== "streaming") editor.focus()
    setComposerLines(Math.max(1, editor.lineInfo.lineWraps.length))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, showComposerRow, phase, composerRevision])

  useEffect(() => {
    if (settingsOpen !== "picker") return
    const input = pickerInputRef.current
    if (!input) return
    if (input.plainText !== pickerQuery) input.editBuffer.setText(pickerQuery)
    input.cursorOffset = pickerQuery.length
    input.showCursor = true
    input.focus()
  }, [settingsOpen])

  useEffect(() => {
    mountedRef.current = true
    const stop = () => {
      // A retirement can outlive the React tree. Invalidate both the
      // activation and painted-row identities before its continuation can
      // commit state into a closed workbench.
      pickerActivationEpochRef.current += 1
      pickerPaintedEpochRef.current += 1
      endpointDraftRef.current = ""
      endpointReturnRef.current = null
      mountedRef.current = false
      active.cancel?.()
      void stopLocalDiscovery()
    }
    renderer.on(CliRenderEvents.DESTROY, stop)
    return () => {
      renderer.off(CliRenderEvents.DESTROY, stop)
      stop()
    }
  }, [])

  useEffect(() => {
    if (
      !showComposerRow ||
      intent !== "ask" ||
      phase === "loading" ||
      phase === "streaming" ||
      conversation.turns.length === 0
    ) {
      return
    }
    setConversationOffset(null)
  }, [conversation.turns.length, intent, phase, showComposerRow])

  const setDraft = (selected: SessionIntent, value: string) => {
    setDrafts((current) => ({ ...current, [selected]: value }))
  }

  // Shared by keyboard (Tab/Shift-Tab) and the mouse tab click: both must
  // reach the exact same reset, never two paths that could drift apart.
  const applyIntent = (next: SessionIntent) => {
    if (editorModeRef.current === "endpoint") return
    if (isEditingMode(editorModeRef.current)) {
      setDetail("save or discard the edit first")
      return
    }
    changeIntent(next)
    intentChangedThisTickRef.current = true
    queueMicrotask(() => {
      intentChangedThisTickRef.current = false
    })
    editorDraftRef.current = null
    closeActions()
    changeEditorMode("composer")
    setView("main")
    setPhase("ready")
    setConversation(emptyAskConversation())
    setConversationOffset(null)
    setLastAskQuery("")
    setDiagnosis(null)
    applyCandidates([])
    candidateIndexRef.current = 0
    setCandidateIndex(0)
    setDetail(
      next === "ask" && newAskSession
        ? "new chat ready · the saved chat stays until the first answer"
        : next === "correct" && !session.actionable_failure
          ? "Fix needs an actionable failed command"
          : "",
    )
  }

  const selectIntent = (direction: -1 | 1) => {
    const current = INTENTS.indexOf(intentRef.current)
    const next = INTENTS[(current + direction + INTENTS.length) % INTENTS.length]
    applyIntent(next)
  }

  const toggleContext = () => {
    if (!context) {
      setDetail("output is empty · use ctrl-x c to paste it")
      return
    }
    // No confirmation message: the label itself flips between `Attach
    // output` and `Output attached (…)`, which says the same thing in place.
    // The disclosure lives in the right group now, anchored beside the keys,
    // so a left-slot message no longer shifts its click range either way.
    const selected = intentRef.current
    setIncludeByIntent((current) => ({
      ...current,
      [selected]: !current[selected],
    }))
    setDetail("")
  }

  const appServerSessionIntent = () => {
    const decision = askSessionFile
      ? appServerPointerDecision(askSessionFile, {
          provider: "codex-app-server",
          cwd: trustedWorkdir,
        })
      : null
    const starts = Boolean(askSessionFile) &&
      (newAskSession || decision?.kind === "missing")
    return {
      decision,
      starts,
      resumeId:
        !starts && decision?.kind === "valid"
          ? decision.sessionId
          : undefined,
    }
  }

  const doctorAvailable =
    !settingsOpen &&
    !busyRef.current &&
    view === "main" &&
    !isEditingMode(editorMode) &&
    !hasCandidateList &&
    ["ready", "answer", "analysis", "failed", "cancelled"].includes(phase)

  const openDoctor = (fromPicker = false): boolean => {
    if (editorModeRef.current === "endpoint") return false
    const eligible = fromPicker
      ? !busyRef.current && view === "main" && !isEditingMode(editorMode) && !hasCandidateList
      : doctorAvailable
    if (!eligible) {
      return false
    }
    doctorActiveRef.current = true
    const activeIntent = intentRef.current
    const preservedDraft = composerRef.current?.plainText ?? drafts[activeIntent]
    const selectedProvider = providerId
      ? providerAvailability().find((item) => item.id === providerId)
      : null
    const pointerExpectation = providerId
      ? {
          provider:
            providerId === "codex" && engine === "app-server"
              ? "codex-app-server"
              : providerId,
          cwd: trustedWorkdir,
        }
      : null
    const pointer = askSessionFile && pointerExpectation
      ? providerPointerDecision(askSessionFile, pointerExpectation)
      : null
    const capturedRows = captureDoctorRows({
      cwd: trustedWorkdir,
      providerId,
      providerSource: session.provider_source ?? "configured",
      providerAvailable: selectedProvider?.selectable ?? false,
      adapterAvailable: providerId
        ? adapterIsExecutable(adapterPath(descriptorForProvider(providerId)))
        : false,
      settings: readPersistedInferenceDocumentState(),
      localEndpoint: endpointStateRef.current,
      pointer,
      pointerRequired: askSessionFile !== null,
      pointerWillStartNew: newAskSession || codexExecStartsNewChat,
    })
    flushSync(() => {
      setDraft(activeIntent, preservedDraft)
      setDoctorRows(capturedRows)
      setDetailIndex(0)
      setDetailOffset(0)
      setView("doctor")
    })
    return true
  }

  const leaveDoctor = () => {
    if (!doctorActiveRef.current && view !== "doctor") return
    flushSync(() => {
      setView("main")
      setComposerRevision((current) => current + 1)
    })
    doctorActiveRef.current = false
    ctrlXRef.current = false
    submittedComposerTextRef.current = null
  }

  const prepareAppServer = (
    forceNewAsk = newAskSession,
    generation = active.appServerGeneration ?? 0,
  ) => {
    if (!settingsOpen && pickerExitCauseRef.current !== null) {
      const cause = pickerExitCauseRef.current
      pickerExitCauseRef.current = null
      if (cause !== "escape") return
    }
    if (
      active.closed ||
      generation !== (active.appServerGeneration ?? 0) ||
      busyRef.current ||
      settingsOpen ||
      pickerApplyingRef.current ||
      pickerRetirementRejectedRef.current ||
      setupDismissalPendingRef.current ||
      !managedProviderAvailable() ||
      engine !== "app-server" ||
      session.codex_ask_engine === null ||
      process.env.SHELLQ_APP_SERVER_REUSE === "0" ||
      active.session ||
      active.preparing
    ) {
      return
    }
    if (active.closing) return
    const { decision, starts, resumeId } = appServerSessionIntent()
    try {
      const prepareAsk = Boolean(askSessionFile) &&
        (decision?.kind !== "invalid" || forceNewAsk)
      const identity = {
        workdir: trustedWorkdir,
        model,
        effort: reasoning,
        threadId: prepareAsk
          ? (forceNewAsk || starts ? null : (resumeId ?? null))
          : undefined,
        sessionFile: askSessionFile ?? undefined,
      }
      const controller = new AbortController()
      const current = new AppServerSession(identity)
      const preparation = current.ready(controller.signal)
      active.session = current
      active.preparing = preparation
      active.prepareCancel = () => controller.abort()
      void preparation.then(
        () => {
          if (active.preparing === preparation) {
            active.preparing = null
            active.prepareCancel = null
          }
        },
        () => {
          if (active.session === current) void retireAppServerSession()
          else void current.dispose()
        },
      )
    } catch {
      // Mount preparation is opportunistic; submit owns user-visible failure handling.
    }
  }

  useEffect(() => {
    prepareAppServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, model, reasoning, newAskSession, askSessionFile, settingsOpen])

  // `delta` is usually ±1 (keyboard) but also carries an arbitrary jump
  // (a Settings value click) — the modular arithmetic wraps correctly
  // either way. A selection persists to disk immediately, alongside the
  // in-memory change, so it survives closing and reopening the workbench; a
  // write failure never blocks the in-memory choice, it only replaces the
  // usual confirmation with a failure notice.
  const stepModel = (delta: number): Promise<void> => {
    if (session.provider_source === "default" && providerId === null) return Promise.resolve()
    const choices = modelChoices
    const currentIndex = effectiveModelIndex
    if (!choices.length) return Promise.resolve()
    const next =
      (currentIndex + delta + choices.length) % choices.length
    if (next === currentIndex) return Promise.resolve()
    const retiring = retireAppServerSession()
    if (setupOpen) setupRetirementRef.current = retiring
    const nextModel = choices[next]
    const nextCapability = providerId === "codex" && codexCatalog
      ? codexCatalog.models.find((item) => item.model === nextModel)
      : null
    const nextReasoning = nextCapability
      ? nextCapability.efforts.includes(reasoning)
        ? reasoning
        : nextCapability.defaultEffort
      : reasoning
    session.model = nextModel
    session.reasoning = nextReasoning
    try {
      writePersistedInferenceSettings(nextModel, nextReasoning, process.env, providerId ?? "configured")
      setDetail(`next request uses ${modelLabel(nextModel)}`)
    } catch {
      // The failure clause leads so it survives the rail's truncation
      // ladder (which always cuts from the right) at every supported
      // width — the model name is still visible in the top border either
      // way, so it is not worth protecting here too.
      setDetail(
        `could not save choice · next request uses ${modelLabel(nextModel)}`,
      )
    }
    setModelIndex(next)
    setReasoningIndex(Math.max(0, reasoningChoices.indexOf(nextReasoning)))
    return retiring
  }

  const stepReasoning = (delta: number): Promise<void> => {
    if (session.provider_source === "default" && providerId === null) return Promise.resolve()
    const choices = reasoningChoices
    const currentIndex = effectiveReasoningIndex
    if (!choices.length) return Promise.resolve()
    const next =
      (currentIndex + delta + choices.length) % choices.length
    if (next === currentIndex) return Promise.resolve()
    const retiring = retireAppServerSession()
    if (setupOpen) setupRetirementRef.current = retiring
    const nextReasoning = choices[next]
    session.reasoning = nextReasoning
    try {
      writePersistedInferenceSettings(model, nextReasoning, process.env, providerId ?? "configured")
      setDetail(`next request uses ${nextReasoning} effort`)
    } catch {
      setDetail(
        `could not save choice · next request uses ${nextReasoning} effort`,
      )
    }
    setReasoningIndex(next)
    return retiring
  }

  const selectProvider = (id: ProviderId): Promise<void> => {
    if (session.provider_source === "configured") {
      setDetail("provider selection unavailable · SHELLQ_PROVIDER is configured")
      return Promise.resolve()
    }
    const next = providerChoices.find((item) => item.id === id && item.enabled)
    if (!next) return Promise.resolve()
    if (next.id === providerId) return Promise.resolve()
    const destination = livePickerLeaves().find(
      (item) => item.field === "provider" && item.value === id,
    )?.destination
    if (!destination) return Promise.resolve()
    if (isEditingMode(editorModeRef.current)) {
      editorDraftRef.current = editorRef.current?.plainText ?? editorDraftRef.current
    }
    const retiring = retireAppServerSession()
    if (setupOpen) setupRetirementRef.current = retiring
    const saved = readPersistedInferenceSettings(process.env, next.id)
    if (!commitPaletteDestination(destination)) {
      setDetail("provider selection unavailable")
      return retiring
    }
    const fallbackNotice = saved &&
      (saved.model !== destination.model || saved.reasoning !== destination.reasoning)
      ? "saved provider settings unavailable · using defaults"
      : null
    try {
      writePersistedInferenceSettings(
        destination.model,
        destination.reasoning,
        process.env,
        next.id,
      )
      setDetail([
        fallbackNotice,
        `using ${next.id}`,
      ].filter(Boolean).join(" · "))
    } catch {
      setDetail([
        fallbackNotice,
        `using ${next.id} · could not save choice`,
      ].filter(Boolean).join(" · "))
    }
    return retiring
  }

  const stepProvider = (delta: number) => {
    const selectableProviders = providerChoices.filter((item) => item.enabled)
    if (!selectableProviders.length) return Promise.resolve()
    const currentIndex = selectableProviders.findIndex((item) => item.id === providerId)
    const nextIndex = currentIndex < 0
      ? delta > 0 ? 0 : selectableProviders.length - 1
      : (currentIndex + delta + selectableProviders.length) % selectableProviders.length
    return selectProvider(selectableProviders[nextIndex].id)
  }

  const stepEngine = (delta: number): Promise<void> => {
    if (engine === null) return Promise.resolve()
    if (isEditingMode(editorModeRef.current)) {
      setDetail("save or discard the edit first")
      return Promise.resolve()
    }
    const nextIndex = (engineIndex + delta + ENGINES.length) % ENGINES.length
    if (nextIndex === engineIndex) return Promise.resolve()
    const preservedDraft = composerRef.current?.plainText ?? drafts[intentRef.current]
    setDraft(intentRef.current, preservedDraft)
    const retiring = retireAppServerSession()
    const nextEngine = ENGINES[nextIndex]
    const nextFile = askSessionFiles?.[nextEngine] ?? null
    const saved = askChatWasSaved(
      nextFile,
      nextEngine === "app-server"
        ? { provider: "codex-app-server", cwd: trustedWorkdir }
        : undefined,
    )
    const next = switchAskEngine(
      {
        conversation,
        askPreview,
        diagnosis,
        editorMode,
        intent,
        lastAskQuery,
        newAskSession,
        phase,
      },
      nextEngine,
      saved,
    )
    setEngineIndex(nextIndex)
    setConversation(next.conversation)
    setConversationOffset(null)
    setAskPreview(next.askPreview)
    setDiagnosis(next.diagnosis)
    setLastAskQuery(next.lastAskQuery)
    setAskChatSaved(saved)
    setNewAskSession(next.newAskSession)
    changeEditorMode(next.editorMode)
    setPhase(next.phase)
    setDetail(next.detail)
    setComposerRevision((current) => current + 1)
    return retiring
  }

  const localSelectable = () =>
    providerAvailability().some(
      (item) => item.id === LOCAL_PROVIDER_ID && item.selectable,
    )

  const openPicker = (scope: SettingsField | null = null) => {
    if (busyRef.current || doctorActiveRef.current || editorModeRef.current === "endpoint") return
    if (isEditingMode(editorModeRef.current)) {
      editorDraftRef.current = editorRef.current?.plainText ?? editorDraftRef.current
    }
    closeActions()
    ctrlXRef.current = false
    setPickerStatus("")
    pickerApplyingRef.current = false
    pickerExitCauseRef.current = null
    pickerQuerySyncRef.current = null
    pickerNavigationQueryRef.current = null
    pickerActivationEpochRef.current += 1
    pickerPaintedEpochRef.current += 1
    pickerIndexRef.current = 0
    const nextView: SettingsPaletteView = scope === "model"
      ? "model"
      : scope === "reasoning"
        ? "effort"
        : scope === "engine"
          ? "engine"
          : "root"
    changePaletteView(nextView)
    startCodexDiscovery()
    // Automatic discovery runs on every palette opening regardless of which
    // provider is active; startLocalDiscovery owns the safe-settings,
    // override, and eligibility gates and stays quiet when they fail.
    rereadEndpointState()
    startLocalDiscovery(false)
    if (pickerInputRef.current) {
      pickerInputRef.current.editBuffer.setText("")
      pickerInputRef.current.cursorOffset = 0
    }
    setPickerIndex(0)
    setPickerQuery("")
    setPickerScope(scope)
    setSettingsField(scope ?? "model")
    setSettingsOpen("picker")
    setDetail("")
  }

  const movePicker = (direction: -1 | 1) => {
    if (pickerApplyingRef.current) return
    const query = normalizeSettingsQuery(pickerInputRef.current?.plainText ?? pickerQuery)
    const results = settingsPickerCandidates(query, livePickerSources())
    if (!results.length) return
    setPickerStatus("")
    pickerNavigationQueryRef.current = query
    if (query !== pickerQuery) {
      setPickerQuery(query)
      pickerPaintedEpochRef.current += 1
    }
    pickerIndexRef.current =
      (pickerIndexRef.current + direction + results.length) % results.length
    setPickerIndex(pickerIndexRef.current)
  }

  const paletteIdentityMatches = (
    left: UniversalPaletteRecord,
    right: UniversalPaletteRecord,
  ) => {
    if (left.kind !== right.kind || left.value !== right.value) return false
    if (!left.identity || !right.identity) return !left.identity && !right.identity
    return left.identity.field === right.identity.field &&
      left.identity.authorityKey === right.identity.authorityKey &&
      left.identity.value === right.identity.value
  }

  const paletteDestinationsMatch = (
    left: UniversalPaletteDestination,
    right: UniversalPaletteDestination,
  ) => left.authority.kind === right.authority.kind &&
    left.providerSource === right.providerSource &&
    left.providerId === right.providerId &&
    left.model === right.model &&
    left.reasoning === right.reasoning &&
    left.engine === right.engine &&
    left.endpoint === right.endpoint

  const livePickerLeaves = (
    catalog: ProviderCapabilityCatalog | null = codexCatalog,
    local: Record<string, ProviderCapabilityCatalog> = localCatalogs,
  ) => buildUniversalPaletteSources({
    initialChoices: initialChoicesRef.current,
    maxFooterRows: savedMaxFooterRowsRef.current,
      availableProviders: providerAvailability().map(({ id, models, reasoningLevels, selectable }) => ({
        id,
        models,
        reasoningLevels,
        selectable,
      })),
      anotherAvailable: canRequestAlternative(intentRef.current),
      codexEngine,
      codexEngineAvailable,
      codexLunaReasoning: readPersistedInferenceSettings(process.env, "codex")?.reasoning,
      configuredModels: session.models,
      configuredReasoningLevels: session.reasoning_levels,
      doctorAvailable: !busyRef.current && view === "main" && !isEditingMode(editorModeRef.current) && !hasCandidateList,
      engine,
      model,
      providerId,
      persisted: {
        codex: readPersistedInferenceSettings(process.env, "codex"),
        claude: readPersistedInferenceSettings(process.env, "claude"),
        [LOCAL_PROVIDER_ID]: readPersistedInferenceSettings(process.env, LOCAL_PROVIDER_ID),
      },
      providerSource: session.provider_source ?? "configured",
      reasoning,
      intent: intentRef.current,
      phase,
      view,
      editorMode: editorModeRef.current,
      editing: isEditingMode(editorModeRef.current),
      hasCandidateList: intentRef.current !== "ask" && candidatesRef.current.length > 0,
      hasCapturedContext: Boolean(context),
      includeContext: includeByIntent[intentRef.current],
      fixAvailable: session.actionable_failure,
      codexCatalog: catalog,
      codexDiscoveryState,
      providerCatalogs: {},
      localEndpointCatalogs: local,
      localEndpoint: endpointStateRef.current.endpoint,
      localCheckAvailable: session.provider_source === "default" && localSelectable(),
      localChecking,
      blockedLocalModels: Array.from(blockedLocalModelsRef.current),
    })

  const livePickerSources = (
    catalog: ProviderCapabilityCatalog | null = codexCatalog,
    local: Record<string, ProviderCapabilityCatalog> = localCatalogs,
  ) => {
    const leaves = livePickerLeaves(catalog, local)
    const query = pickerInputRef.current?.plainText ?? pickerQuery
    return settingsPaletteSources(leaves, paletteViewRef.current, query)
  }

  const startCodexDiscovery = () => {
    if (
      codexDiscoveryStartedRef.current ||
      session.provider_source !== "default" ||
      !providerAvailability().some((item) => item.id === "codex" && item.selectable)
    ) return
    codexDiscoveryStartedRef.current = true
    setCodexDiscoveryState("loading")
    const descriptor = descriptorForProvider("codex")
    const discoveryModel = descriptor.models[0] ?? "gpt-5.6-luna"
    const discoveryEffort = descriptor.reasoningLevels.find((value) =>
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value),
    ) ?? "low"
    const controller = new AbortController()
    let transient: AppServerSession | null = null
    void (async () => {
      try {
        transient = new AppServerSession({
          workdir: trustedWorkdir,
          model: discoveryModel,
          effort: discoveryEffort,
          threadId: undefined,
        })
        await transient.ready(controller.signal)
        const pages = await transient.listModels(controller.signal)
        const catalog: ProviderCapabilityCatalog = {
          providerId: "codex",
          source: "codex-model-list",
          models: validateCodexModelPages(pages),
        }
        if (pickerApplyingRef.current) {
          stagedCodexCatalogRef.current = catalog
        } else {
          const query = normalizeSettingsQuery(pickerInputRef.current?.plainText ?? pickerQuery)
          const currentResults = settingsPickerCandidates(query, livePickerSources())
          const focused = currentResults[pickerIndexRef.current]
          const nextResults = settingsPickerCandidates(query, livePickerSources(catalog))
          const nextIndex = settingsPaletteRestoredIndex(focused, nextResults)
          pickerIndexRef.current = nextIndex
          setPickerIndex(nextIndex)
          setCodexCatalog(catalog)
          setCodexDiscoveryState("dynamic")
          pickerPaintedEpochRef.current += 1
          setPickerRevision((current) => current + 1)
        }
      } catch {
        setCodexDiscoveryState("fallback")
        setPickerStatus((current) => current || "Codex catalog unavailable / fallback shown")
      } finally {
        controller.abort()
        await transient?.dispose()
      }
    })()
  }

  const publishLocalCatalogs = (catalogs: Record<string, ProviderCapabilityCatalog>, isExplicit = false) => {
    if (isExplicit) {
      blockedLocalModelsRef.current.clear()
    }
    const query = normalizeSettingsQuery(pickerInputRef.current?.plainText ?? pickerQuery)
    const currentResults = settingsPickerCandidates(query, livePickerSources())
    const focused = currentResults[pickerIndexRef.current]
    const nextResults = settingsPickerCandidates(query, livePickerSources(codexCatalog, catalogs))
    const nextIndex = settingsPaletteRestoredIndex(focused, nextResults)
    pickerIndexRef.current = nextIndex
    setPickerIndex(nextIndex)
    setLocalCatalogs(catalogs)
    localCatalogsRef.current = catalogs
    const livePairs = Object.values(catalogs)
      .filter((catalog) => !catalog.stale)
      .reduce((count, catalog) => count + catalog.models.length, 0)
    if (Object.keys(catalogs).length && session.provider_id !== "codex" && providerId !== "codex") {
      if (!Object.values(catalogs).some((catalog) => catalog.stale)) {
        setPickerStatus(livePairs
          ? `${livePairs} local model${livePairs === 1 ? "" : "s"} · choose one`
          : "no local endpoint advertises a usable model")
      }
    } else {
      clearCheckingStatus()
    }
    pickerPaintedEpochRef.current += 1
    setPickerRevision((current) => current + 1)
  }

  // The transient probe status must never outlive the probe. Only that exact
  // text is cleared, so any newer status (navigation, applied choice) stays.
  const clearCheckingStatus = () => {
    setPickerStatus((current) => (current === "Checking local models…" ? "" : current))
  }

  // Marks every previously published catalog stale after a failed scan; with
  // no prior catalog, the effective endpoint carries one empty stale entry so
  // a saved preference reads "unavailable" rather than unchecked.
  const staleLocalCatalogs = (): Record<string, ProviderCapabilityCatalog> => {
    const stale: Record<string, ProviderCapabilityCatalog> = {}
    for (const [endpoint, catalog] of Object.entries(localCatalogsRef.current)) {
      stale[endpoint] = { ...catalog, stale: true }
    }
    if (!Object.keys(stale).length) {
      const endpoint = endpointStateRef.current.endpoint
      if (endpoint) stale[endpoint] = { providerId: LOCAL_PROVIDER_ID, source: "explicit", models: [], stale: true }
    }
    return stale
  }

  const startLocalDiscovery = (isExplicit = false) => {
    // An explicit check that lands on a running automatic round shares it but
    // keeps its explicit meaning, so that round's publication clears blocks.
    if (isExplicit && localDiscoveryRunningRef.current) localDiscoveryExplicitRef.current = true
    if (localDiscoveryRunningRef.current || busyRef.current || pickerApplyingRef.current || editorModeRef.current === "endpoint") return
    localDiscoveryExplicitRef.current = isExplicit
    // Malformed or unreadable settings block all probing until deliberately
    // repaired; a configured or locally unselectable invocation never probes.
    const settingsState = readPersistedInferenceDocumentState()
    if (settingsState.kind === "invalid" || settingsState.kind === "operational-error") return
    if (session.provider_source !== "default" || !localSelectable()) return
    const endpoints = localScanEndpoints(endpointStateRef.current)
    if (!endpoints) {
      setPickerStatus(localEndpointUnavailableMessage(endpointStateRef.current))
      return
    }
    const identity = ++localDiscoveryIdentityRef.current
    const ownsCheck = () => mountedRef.current && !active.closed && identity === localDiscoveryIdentityRef.current
    // An automatic round with no local server is routine for other providers;
    // its failure is reported only for an explicit check or the active local provider.
    const reportsFailure = () => session.provider_id !== "codex" && providerId !== "codex" &&
      (localDiscoveryExplicitRef.current || providerId === LOCAL_PROVIDER_ID)
    localDiscoveryRunningRef.current = true
    const cancel = () => { void stopLocalDiscovery() }
    localDiscoveryCancelRef.current = cancel
    active.discoveryCancel = cancel
    setLocalChecking(true)
    setPickerStatus("Checking local models…")
    const descriptor = descriptorForProvider(LOCAL_PROVIDER_ID)
    void (async () => {
      let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
      try {
        const priorRetiring = localDiscoveryRetiringRef.current?.catch(() => {}) ?? Promise.resolve()
        await priorRetiring
        if (!ownsCheck()) return
        child = Bun.spawn([adapterPath(descriptor)], {
          env: localAdapterEnvironment(process.env, endpoints[0], { mode: LOCAL_SCAN_MODE, scanEndpoints: endpoints }),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
        localDiscoveryProcessRef.current = child
        active.discoveryProcess = child
        child.stdin.end()
        const [raw, exitCode] = await Promise.all([
          readBounded(child.stdout as ReadableStream<Uint8Array>, LOCAL_SCAN_MAX_BYTES),
          // Adapter stderr carries only a fixed redacted line; it is drained so
          // the pipe cannot fill, and deliberately never read into the UI.
          readBounded(child.stderr as ReadableStream<Uint8Array>, 4096).catch(() => ""),
          child.exited,
        ]).then(([stdout, , code]) => [stdout, code] as const)
        if (!ownsCheck()) return
        const parsed = exitCode === 0 ? parseLocalScan(raw, endpoints) : null
        if (!parsed) {
          publishLocalCatalogs(staleLocalCatalogs(), false)
          if (reportsFailure()) {
            setPickerStatus(localFailureMessage(exitCode || 69))
          } else {
            clearCheckingStatus()
          }
          return
        }
        const catalogs: Record<string, ProviderCapabilityCatalog> = {}
        for (const [endpoint, models] of parsed) {
          catalogs[endpoint] = explicitModelCatalog(LOCAL_PROVIDER_ID, models, descriptor.reasoningLevels)
        }
        if (pickerApplyingRef.current) {
          stagedLocalCatalogRef.current = { catalogs, isExplicit: localDiscoveryExplicitRef.current }
          return
        }
        publishLocalCatalogs(catalogs, localDiscoveryExplicitRef.current)
      } catch {
        if (child) await confirmTermination(child)
        if (ownsCheck()) {
          publishLocalCatalogs(staleLocalCatalogs(), false)
          if (reportsFailure()) {
            setPickerStatus(localFailureMessage(1))
          } else {
            clearCheckingStatus()
          }
        }
      } finally {
        if (ownsCheck()) {
          localDiscoveryProcessRef.current = null
          localDiscoveryRunningRef.current = false
          if (active.discoveryProcess === child) active.discoveryProcess = null
          if (active.discoveryCancel === cancel) active.discoveryCancel = null
          localDiscoveryCancelRef.current = null
          setLocalChecking(false)
        }
      }
    })()
  }

  // Settings are reread on every palette/Setup entry, so a hand-edited valid
  // endpoint participates in the next opening. An invocation-only unsaved
  // editor value and a fixed environment override stay authoritative, and an
  // endpoint change retires the endpoint-keyed catalogs and blocks.
  const rereadEndpointState = () => {
    const current = endpointStateRef.current
    if (current.source === "not saved" || current.readOnly) return
    const next = resolveLocalEndpoint(readPersistedInferenceDocumentState(), process.env)
    if (next.endpoint === current.endpoint && next.source === current.source) return
    endpointStateRef.current = next
    session.localEndpoint = next
    localCatalogsRef.current = {}
    setLocalCatalogs({})
    blockedLocalModelsRef.current.clear()
  }

  // One shared surface gate: entering any settings surface rereads saved
  // configuration and shares any already-running probe; leaving every
  // settings surface — Escape, routes, apply-close, and endpoint editor
  // entry, which all set settingsOpen false — cancels the probe and reaps
  // the scan, so no late publication can follow an exit. Subview changes
  // keep settingsOpen truthy, so root/model/effort views share one scan.
  useEffect(() => {
    if (!settingsOpen) {
      void stopLocalDiscovery()
      return
    }
    rereadEndpointState()
    startLocalDiscovery(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  const currentPaletteRecord = (
    selected: UniversalPaletteRecord,
    sources: UniversalPaletteRecord[],
  ) => sources.find((source) => paletteIdentityMatches(source, selected)) ??
    sources.find((source) =>
      source.kind === selected.kind &&
      source.field === selected.field &&
      source.value === selected.value &&
      source.destination &&
      selected.destination &&
      paletteDestinationsMatch(source.destination, selected.destination),
    )

  const commitPaletteDestination = (destination: UniversalPaletteDestination) => {
    if (destination.authority.kind === "configured") {
      if (
        session.provider_source !== "configured" ||
        !session.models.includes(destination.model) ||
        !session.reasoning_levels.includes(destination.reasoning)
      ) return false
      session.model = destination.model
      session.reasoning = destination.reasoning
      setModelIndex(session.models.indexOf(destination.model))
      setReasoningIndex(session.reasoning_levels.indexOf(destination.reasoning))
      return true
    }
    const next = providerAvailability().find(
      (item) => item.id === destination.providerId && item.selectable,
    )
    const nextCatalog = next?.id === "codex"
      ? codexCatalog
      : next?.id === LOCAL_PROVIDER_ID
        ? localCatalogs[destination.endpoint ?? ""] ?? null
        : null
    if (next?.id === LOCAL_PROVIDER_ID && blockedLocalModelsRef.current.has(`${destination.endpoint ?? endpointStateRef.current.endpoint} ${destination.model}`)) return false
    const nextCapability = nextCatalog?.models.find((item) => item.model === destination.model)
    const nextModels = nextCatalog?.models.map((item) => item.model) ?? next?.models ?? []
    const nextEfforts = nextCapability?.efforts ?? next?.reasoningLevels ?? []
    const preservesCurrentCodexTuple = next?.id === "codex" &&
      destination.engine !== null &&
      session.provider_source === "default" &&
      providerId === "codex" &&
      destination.model === model &&
      destination.reasoning === reasoning &&
      codexInferenceTupleIsTransportSafe(destination.model, destination.reasoning)
    const preservesCurrentLocalTuple = next?.id === LOCAL_PROVIDER_ID &&
      localActivationIsCurrent(destination.endpoint ?? endpointStateRef.current.endpoint, destination.model) &&
      (nextCapability ? nextCapability.efforts.includes(destination.reasoning) : nextEfforts.includes(destination.reasoning))
    if (!next || (!preservesCurrentCodexTuple && !preservesCurrentLocalTuple && ((next.id === "codex" && codexCatalog !== null && !nextCapability) || !nextModels.includes(destination.model) || !nextEfforts.includes(destination.reasoning)))) {
      return false
    }
    const nextEngine = destination.engine
    const providerTransition =
      session.provider_source !== "default" || providerId !== next.id
    if (providerTransition) {
      void stopLocalDiscovery()
    }
    // Local Ask keeps no pointer, so no session file is consulted and no chat
    // can be "saved" for it.
    const nextFile = next.id === LOCAL_PROVIDER_ID
      ? null
      : next.id === "codex" && nextEngine && askSessionFiles
        ? askSessionFiles[nextEngine]
        : providerSessionFile(next.id, trustedWorkdir)
    const savedChat = nextFile !== null && askChatWasSaved(nextFile, {
      provider: next.id === "codex" && nextEngine === "app-server" ? "codex-app-server" : next.id,
      cwd: trustedWorkdir,
    })
    const engineTransition = next.id === "codex" && nextEngine !== null && nextEngine !== engine
    const switched = engineTransition
      ? switchAskEngine(
          {
            conversation,
            askPreview,
            diagnosis,
            editorMode,
            intent,
            lastAskQuery,
            newAskSession,
            phase,
          },
          nextEngine,
          savedChat,
        )
      : null
    if (isEditingMode(editorModeRef.current)) {
      editorDraftRef.current = editorRef.current?.plainText ?? editorDraftRef.current
    }
    session.provider_id = next.id
    session.provider_source = "default"
    session.provider = [adapterPath(next)]
    session.models = nextModels
    session.reasoning_levels = nextEfforts
    session.model = destination.model
    session.reasoning = destination.reasoning
    session.codex_ask_engine = next.id === "codex" ? nextEngine : null
    // A local pair activates its own endpoint and catalog together; thinking
    // preferences and submission targets follow endpointStateRef from here.
    if (next.id === LOCAL_PROVIDER_ID && destination.endpoint && destination.endpoint !== endpointStateRef.current.endpoint) {
      endpointStateRef.current = { endpoint: destination.endpoint, source: "saved", readOnly: false }
      session.localEndpoint = endpointStateRef.current
    }
    setProviderId(next.id)
    setModelIndex(nextModels.indexOf(destination.model))
    setReasoningIndex(nextEfforts.indexOf(destination.reasoning))
    if (next.id === "codex" && nextEngine !== null) {
      setEngineIndex(ENGINES.indexOf(nextEngine))
    }
    if (providerTransition || engineTransition) {
      setAskChatSaved(savedChat)
      setNewAskSession(switched?.newAskSession ?? false)
      setConversation(switched?.conversation ?? emptyAskConversation())
      setConversationOffset(null)
      setAskPreview(switched?.askPreview ?? { note: "", text: "", thinking: "" })
      setDiagnosis(switched?.diagnosis ?? null)
      setLastAskQuery(switched?.lastAskQuery ?? "")
      applyCandidates([])
      candidateIndexRef.current = 0
      setCandidateIndex(0)
      if (switched) {
        changeEditorMode(switched.editorMode)
        setPhase(switched.phase)
        setDetail(switched.detail)
      } else {
        setPhase("ready")
      }
    }
    return true
  }

  const resetPickerQuery = () => {
    if (pickerInputRef.current) {
      pickerQuerySyncRef.current = ""
      pickerInputRef.current.editBuffer.setText("")
      pickerInputRef.current.cursorOffset = 0
    }
    setPickerQuery("")
    pickerNavigationQueryRef.current = null
    pickerIndexRef.current = 0
    setPickerIndex(0)
    pickerPaintedEpochRef.current += 1
  }

  const applyPickerSet = async (selected: UniversalPaletteRecord) => {
    const activationEpoch = ++pickerActivationEpochRef.current
    const live = currentPaletteRecord(selected, livePickerLeaves())
    if (!live || !live.destination) {
      setPickerStatus("Selection is no longer available")
      return
    }
    const destination = live.destination
    const localDestination = destination.providerId === LOCAL_PROVIDER_ID
    if (localDestination && blockedLocalModelsRef.current.has(`${destination.endpoint ?? endpointStateRef.current.endpoint} ${destination.model}`)) {
      setPickerStatus("local model is blocked · check models again")
      return
    }
    const destinationIsActive = !localDestination || localActivationIsCurrent(destination.endpoint ?? endpointStateRef.current.endpoint, destination.model)
    const destinationLabel = destination.authority.kind === "configured"
      ? `Configured/${modelLabel(destination.model)}`
      : `${paletteProviderLabel(destination.authority.providerId)}/${modelLabel(destination.model)}`
    // Endpoint equality is a local-pair concept only: non-local destinations
    // carry no endpoint and must never compare against the local one.
    const endpointMatches = !localDestination || endpointStateRef.current.endpoint === destination.endpoint
    const isCurrent = destinationIsActive && (destination.authority.kind === "configured"
      ? session.provider_source === "configured" &&
        model === destination.model && reasoning === destination.reasoning
      : session.provider_source === "default" &&
        providerId === destination.providerId && model === destination.model &&
        reasoning === destination.reasoning && engine === destination.engine && endpointMatches)
    const isCurrentModel = destinationIsActive && live.field === "model" && (
      destination.authority.kind === "configured"
        ? session.provider_source === "configured" && model === destination.model
        : session.provider_source === "default" &&
          providerId === destination.providerId && model === destination.model && endpointMatches
    )
    if (isCurrentModel) {
      resetPickerQuery()
      setPickerStatus("")
      changePaletteView("effort")
      return
    }
    if (isCurrent) {
      if (live.field === "reasoning") {
        if (localDestination) setThinkingPreference(undefined)
        pickerExitCauseRef.current = "route"
        setSettingsOpen(false)
      }
      return
    }

    if (destination.engine !== engine && isEditingMode(editorModeRef.current)) {
      setPickerStatus("Save or discard the edit first")
      setDetail("save or discard the edit first")
      pickerExitCauseRef.current = "route"
      setSettingsOpen(false)
      return
    }

    pickerApplyingRef.current = true
    if (destination.providerId !== providerId) void stopLocalDiscovery()
    setPickerStatus(`Applying ${destinationLabel}…`)
    const retiring = retireAppServerSession()
    const expectedRetirementGeneration = active.appServerGeneration ?? 0
    try {
      await retiring
      if (mountedRef.current && !active.closed && stagedLocalCatalogRef.current) {
        const staged = stagedLocalCatalogRef.current
        stagedLocalCatalogRef.current = null
        publishLocalCatalogs(staged.catalogs, staged.isExplicit)
      }
      if (localDestination && (!localActivationIsCurrent(destination.endpoint ?? endpointStateRef.current.endpoint, destination.model) || blockedLocalModelsRef.current.has(`${destination.endpoint ?? endpointStateRef.current.endpoint} ${destination.model}`))) {
        throw new Error("selection is no longer available")
      }
      if (
        !mountedRef.current || active.closed ||
        activationEpoch !== pickerActivationEpochRef.current ||
        expectedRetirementGeneration !== (active.appServerGeneration ?? 0)
      ) {
        throw new Error("setting change became stale")
      }
      const postRetirement = currentPaletteRecord(selected, livePickerLeaves())
      if (!postRetirement?.destination) {
        throw new Error("selection is no longer available")
      }
      const finalDestination = postRetirement.destination
      if (!paletteDestinationsMatch(destination, finalDestination)) {
        throw new Error("selection is no longer available")
      }
      const durableChanged = (finalDestination.authority.kind === "managed"
        ? providerId !== finalDestination.providerId || session.provider_source !== "default"
        : session.provider_source !== "configured") ||
        model !== finalDestination.model ||
        reasoning !== finalDestination.reasoning ||
        (finalDestination.providerId === LOCAL_PROVIDER_ID &&
          endpointStateRef.current.endpoint !== finalDestination.endpoint)
      let persistenceFailed = false
      if (durableChanged) {
        try {
          if (finalDestination.providerId === LOCAL_PROVIDER_ID && finalDestination.endpoint) {
            // One atomic document update: endpoint plus the exact inference
            // triple, never two writes that could split the pair.
            writePersistedLocalSelection(finalDestination.endpoint, finalDestination.model, finalDestination.reasoning)
          } else {
            writePersistedInferenceSettings(
              finalDestination.model,
              finalDestination.reasoning,
              process.env,
              finalDestination.authority.kind === "managed" ? finalDestination.authority.providerId : "configured",
            )
          }
        } catch {
          persistenceFailed = true
        }
      }
      if (!commitPaletteDestination(finalDestination)) {
        throw new Error("selection is no longer available")
      }
      if (persistenceFailed) {
        if (finalDestination.providerId === LOCAL_PROVIDER_ID) {
          endpointStateRef.current = { ...endpointStateRef.current, source: "not saved" }
          session.localEndpoint = endpointStateRef.current
        }
        setPickerStatus("Could not save choice")
        setDetail("could not save choice")
        pickerApplyingRef.current = false
        setSettingsOpen(false)
        return
      }
      resetPickerQuery()
      const appliedLabel = finalDestination.authority.kind === "configured"
        ? `Configured/${modelLabel(finalDestination.model)}`
        : `${paletteProviderLabel(finalDestination.authority.providerId)}/${modelLabel(finalDestination.model)}`
      setPickerStatus(`Applied ${appliedLabel} · ${finalDestination.reasoning}`)
      pickerApplyingRef.current = false
      if (stagedCodexCatalogRef.current) {
        setCodexCatalog(stagedCodexCatalogRef.current)
        setCodexDiscoveryState("dynamic")
        stagedCodexCatalogRef.current = null
        pickerPaintedEpochRef.current += 1
        setPickerRevision((current) => current + 1)
      }
      if (selected.field === "provider") changePaletteView("model")
      else if (selected.field === "model") changePaletteView("effort")
      else if (selected.field === "reasoning") setSettingsOpen(false)
    } catch (error) {
      if (mountedRef.current && !active.closed && stagedLocalCatalogRef.current) {
        const staged = stagedLocalCatalogRef.current
        stagedLocalCatalogRef.current = null
        publishLocalCatalogs(staged.catalogs, staged.isExplicit)
      }
      pickerRetirementRejectedRef.current = true
      pickerApplyingRef.current = false
      const failure = `${error instanceof Error ? error.message : "Could not apply choice"} · no preparation`
      flushSync(() => {
        setPickerStatus(failure)
        setDetail(failure)
        setSettingsOpen(false)
      })
    }
  }

  const applyPickerSelection = (
    selected: UniversalPaletteRecord | undefined,
    paintedIndex?: number,
    paintedEpoch?: number,
  ) => {
    if (pickerApplyingRef.current || editorModeRef.current === "endpoint") return
    if (
      paintedEpoch !== undefined &&
      paintedEpoch !== pickerPaintedEpochRef.current
    ) {
      pickerPaintedEpochRef.current += 1
      setPickerStatus("Selection is no longer available")
      setPickerRevision((current) => current + 1)
      return
    }
    const query = normalizeSettingsQuery(pickerInputRef.current?.plainText ?? pickerQuery)
    const sources = livePickerSources()
    const ranked = settingsPickerCandidates(query, sources)
    const focusIndex = Math.min(
      pickerIndexRef.current,
      Math.max(0, ranked.length - 1),
    )
    const fresh = paintedIndex === undefined
      ? ranked[focusIndex]
      : settingsPickerWindow(ranked, focusIndex, pickerVisibleRows)[paintedIndex]
    const paintedDestinationChanged = selected?.kind === "set" && selected.action !== "set-initial-choices" &&
      selected.action !== "set-max-footer-rows" && (
      fresh?.kind !== "set" ||
      !selected.destination ||
      !fresh.destination ||
      !paletteDestinationsMatch(fresh.destination, selected.destination)
    )
    if (!fresh || (selected && !paletteIdentityMatches(fresh, selected)) || paintedDestinationChanged) {
      const nextIndex = Math.min(
        pickerIndexRef.current,
        Math.max(0, ranked.length - 1),
      )
      pickerIndexRef.current = nextIndex
      setPickerIndex(nextIndex)
      setPickerStatus("Selection is no longer available")
      pickerPaintedEpochRef.current += 1
      setPickerRevision((current) => current + 1)
      return
    }
    if (fresh.action === "set-initial-choices") {
      const count = Number(fresh.value) as 1 | 2 | 3 | 4 | 5
      try {
        writePersistedInitialChoices(count)
        initialChoicesRef.current = count
        setInitialChoices(count)
        resetPickerQuery()
        setPickerStatus(`${count} initial ${count === 1 ? "choice" : "choices"} saved globally`)
      } catch { setPickerStatus("choice count not saved · settings need attention") }
      return
    }
    if (fresh.action === "set-max-footer-rows") {
      const rows = Number(fresh.value) as 8 | 12 | 16
      try {
        writePersistedMaxFooterRows(rows)
        savedMaxFooterRowsRef.current = rows
        setSavedMaxFooterRows(rows)
        resetPickerQuery()
        setPickerStatus(`max height ${rows} rows saved for the next workbench`)
      } catch { setPickerStatus("max height not saved · settings need attention") }
      return
    }
    if (fresh.kind === "set") {
      void applyPickerSet(fresh)
      return
    }
    // Intercepted before the generic `open` branch: the check publishes into
    // the list the user is looking at, so the palette must stay open.
    if (fresh.action === "configure-local-endpoint") {
      openEndpointEditor()
      return
    }
    if (fresh.action === "check-local-models") {
      resetPickerQuery()
      startLocalDiscovery(true)
      return
    }
    const closePickerForRoute = () => {
      pickerExitCauseRef.current = "route"
      setSettingsOpen(false)
    }
    if (fresh.kind === "toggle") {
      const resultingInclusion = !includeByIntent[intentRef.current]
      toggleContext()
      resetPickerQuery()
      setPickerStatus(resultingInclusion ? "output attached" : "output held")
      return
    }
    if (fresh.kind === "open") {
      if (fresh.action === "open-palette-view" && fresh.paletteView) {
        changePaletteView(fresh.paletteView)
        resetPickerQuery()
        setPickerStatus("")
        return
      }
      closePickerForRoute()
      setPickerStatus("")
      switch (fresh.action) {
        case "mode-ask":
          if (intentRef.current !== "ask") applyIntent("ask")
          return
        case "mode-command":
          if (intentRef.current !== "generate") applyIntent("generate")
          return
        case "mode-fix":
          if (intentRef.current !== "correct") applyIntent("correct")
          return
        case "open-context":
          handleCtrlX("context")
          return
        case "open-doctor":
          openDoctor(true)
          return
        case "open-details":
        case "open-candidate-details":
          handleCtrlX("details")
          return
        case "open-candidate-edit":
          handleCtrlX("edit")
          return
        case "open-provider-setup":
          openProviderSetup()
          return
      }
      return
    }
    if (fresh.kind === "guard") {
      closePickerForRoute()
      setPickerStatus("")
      closeActions()
      switch (fresh.action) {
        case "guard-another":
          openActions()
          setDetail("Another suggestion · Ctrl-X A to request")
          return
        case "guard-insert":
          setView("main")
          setDetail("Enter insert (never runs)")
          return
        case "guard-save":
          setDetail("Ctrl-X W saves the edit")
          return
        case "guard-new-chat":
          if (intentRef.current !== "ask") applyIntent("ask")
          setDetail("New Ask chat · Ctrl-X N starts a new chat")
          return
      }
      return
    }
    if (fresh.kind === "n-a") {
      setPickerStatus(fresh.effect)
    }
  }

  const applyPicker = () => applyPickerSelection(undefined)

  const openProviderSetup = () => {
    if (busyRef.current || editorModeRef.current === "endpoint") return
    if (isEditingMode(editorModeRef.current)) {
      editorDraftRef.current =
        editorRef.current?.plainText ?? editorDraftRef.current
    }
    ctrlXRef.current = false
    pickerExitCauseRef.current = null
    closeActions()
    setSettingsField("provider")
    setPickerScope(null)
    setSettingsOpen("setup")
    setDetail("")
  }

  const requestProvider = async (query: string) => {
    if (doctorActiveRef.current || editorModeRef.current === "endpoint") return
    if (busyRef.current) return
    void stopLocalDiscovery()
    if (pickerRetirementRejectedRef.current) {
      setDetail("setting change refused · no preparation")
      return
    }
    if (!managedProviderAvailable()) {
      setDetail("no registered provider is available")
      return
    }
    if (session.provider_source === "default" && !adapterIsExecutable(session.provider[0])) {
      setDetail("provider adapter is unavailable")
      return
    }
    if (session.provider_source === "default" && providerId === LOCAL_PROVIDER_ID && !endpointStateRef.current.endpoint) {
      setDetail(localEndpointUnavailableMessage(endpointStateRef.current))
      return
    }
    // Submission gate. Reached before anything is spawned, so a local turn
    // without an exact unblocked model preference costs zero processes and
    // zero HTTP.
    if (
      session.provider_source === "default" &&
      providerId === LOCAL_PROVIDER_ID &&
      !localActivationIsCurrent(endpointStateRef.current.endpoint, model)
    ) {
      setDetail(LOCAL_NO_ACTIVE_MODEL_DETAIL)
      return
    }
    const requestedLocalThinking = currentLocalThinking()
    const requestedIntent = intentRef.current
    const commandPreview = requestedIntent !== "ask" && providerId !== null && session.provider_source === "default"
    const previewOffered = requestedIntent === "ask" || commandPreview
    const appServerEngine = engine === "app-server"
    const appServer = requestedIntent === "ask" && appServerEngine
    const reuseAppServer =
      appServerEngine &&
      session.codex_ask_engine !== null &&
      process.env.SHELLQ_APP_SERVER_REUSE !== "0"
    const existingCandidates = candidatesRef.current
    const candidateCount = requestedIntent !== "ask" && session.provider_source === "default" && !existingCandidates.length ? initialChoicesRef.current : 1
    if (
      requestedIntent !== "ask" &&
      existingCandidates.length >= CANDIDATE_LIMIT
    ) {
      setDetail("five suggestions is the limit · use ↑↓ to compare them")
      return
    }

    let request: Record<string, any>
    try {
      request =
        requestedIntent === "ask"
          ? buildAskRequest(
              session,
              query,
              context,
              includeByIntent[requestedIntent],
            )
          : buildProviderRequest(
              session,
              requestedIntent,
              query,
              context,
              includeByIntent[requestedIntent],
              existingCandidates,
              candidateCount,
            )
      if (requestedIntent !== "ask" && session.provider_source === "default") {
        request.instructions += " Start risk with Low, Medium, or High, followed by the concrete consequence. Use Unknown when the risk cannot be assessed."
      }
      if (requestedIntent !== "ask" && candidateCount === 1 && session.provider_source === "default") {
        request.instructions += " Each tldr starts with the outcome and scope in plain language, then explains important flags and when to choose it, within 500 characters. State consequential limitations; avoid vague claims such as more robust."
      }
    } catch (error) {
      setDetail(error instanceof Error ? error.message : "invalid request")
      return
    }

    const appServerIntent = appServerEngine ? appServerSessionIntent() : null
    const pointerDecision = appServerIntent?.decision ?? null
    if (appServer && pointerDecision?.kind === "invalid" && !newAskSession) {
      setDetail("invalid App Server chat state · ^X N starts a new chat")
      return
    }
    const appServerStarts = appServer && Boolean(appServerIntent?.starts)
    const appServerResumeId = appServer ? appServerIntent?.resumeId : undefined
    const claudeIntent =
      requestedIntent === "ask" && providerId === "claude" && askSessionFile
        ? (() => {
            const decision = providerPointerDecision(askSessionFile, {
              provider: "claude",
              cwd: trustedWorkdir,
            })
            const starts = newAskSession || decision.kind === "missing"
            return {
              decision,
              starts,
              resumeId:
                !starts && decision.kind === "valid" ? decision.sessionId : undefined,
            }
          })()
        : null
    if (claudeIntent?.decision.kind === "invalid" && !newAskSession) {
      setDetail("invalid Claude chat state · ^X N starts a new chat")
      return
    }
    const claudeStarts = Boolean(claudeIntent?.starts)
    const claudeResumeId = claudeIntent?.resumeId

    setDraft(requestedIntent, query)
    setLastAskQuery(query)
    busyRef.current = true
    cancelledRef.current = false
    const requestToken = ++requestTokenRef.current
    const startedAt = performance.now()
    let firstTextMs: number | undefined
    let reportedMetrics: ResponseMetrics = {}
    setRequestStartedAt(startedAt)
    setClockNow(startedAt)
    setResponseInfo(null)
    setResponseActivity("Waiting")

    const requiresPointerCommit =
      requestedIntent === "ask" &&
      askSessionFile !== null &&
      (appServer
        ? appServerStarts
        : providerId === "claude"
          ? claudeStarts
          : codexExecStartsNewChat)
    const askCandidateFile =
      providerId === "codex" && askSessionFile &&
      (appServerStarts || codexExecStartsNewChat)
        ? appServerCandidateFile(askSessionFile)
        : providerId === "claude" && claudeStarts && askSessionFile
          ? appServerCandidateFile(askSessionFile)
        : undefined
    if (requestedIntent === "ask") {
      if (providerId !== "claude" || askCandidateFile) {
        finalizeAskSessionPointer(askSessionFile, false, askCandidateFile)
      }
    }
    setAskPreview({ note: "", text: "", thinking: "" })
    setDiagnosis(null)
    changeEditorMode("view")
    setPhase("loading")
    setDetail("")

    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
    let localChild: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null
    let reusableSession = false
    let reusableTransportSealed = false
    const abortController = new AbortController()
    const onPreview = (event: AskPreviewEvent) => {
      if (
        requestTokenRef.current !== requestToken ||
        cancelledRef.current
      ) {
        return
      }
      if (event.t !== "note" && event.text) {
        firstTextMs ??= performance.now() - startedAt
        setResponseActivity(event.t === "thinking" ? "Thinking" : "Answering")
      }
      setAskPreview((current) =>
        requestTokenRef.current === requestToken && !cancelledRef.current
          ? appendAskPreview(current, event)
          : current,
      )
      setPhase((current) =>
        requestTokenRef.current === requestToken && !cancelledRef.current
          ? "streaming"
          : current,
      )
    }
    try {
      let raw: string
      let errorText = ""
      let exitCode = 0
      active.cancel = () => abortController.abort()
      await active.closing
      if (abortController.signal.aborted) throw new ProviderFailure(130)
      if (reuseAppServer) {
        reusableSession = true
        active.cancel = () => {
          abortController.abort()
          active.prepareCancel?.()
        }
        const identity = {
          workdir: trustedWorkdir,
          model,
          effort: reasoning,
          threadId:
            pointerDecision?.kind === "invalid" && !newAskSession
              ? undefined
              : appServerIntent?.starts
                ? null
                : (appServerIntent?.resumeId ?? null),
          sessionFile: askSessionFile ?? undefined,
        }
        if (appServer) {
          validateAppServerSessionTurn(
            identity,
            request,
            appServerStarts ? askCandidateFile : undefined,
          )
        }
        const preparing = active.preparing
        if (preparing) await preparing.catch(() => {})
        if (abortController.signal.aborted) throw new ProviderFailure(130)
        let current = active.session ?? null
        if (!current?.matches(identity)) {
          await retireAppServerSession()
          if (abortController.signal.aborted) throw new ProviderFailure(130)
          current = new AppServerSession(identity)
          active.session = current
          await current.ready(abortController.signal)
        }
        let previewBytes = 0
        const structuredPreview = commandPreview ? new StructuredPreviewProjector(requestedIntent as "generate" | "correct", candidateCount) : null
        const result = await current.runTurn(request, {
          candidateFile: appServerStarts ? askCandidateFile : undefined,
          mode: requestedIntent,
          onPreview: (event, costBytes) => {
            previewBytes += costBytes
            if (
              previewOffered &&
              previewBytes <= ASK_PREVIEW_INPUT_MAX_BYTES
            ) {
              if (structuredPreview && (event.t === "answer" || event.t === "delta")) {
                for (const preview of structuredPreview.push(event.text)) onPreview(preview)
              } else onPreview(event)
            }
          },
          signal: abortController.signal,
        })
        reusableTransportSealed = true
        raw = requestedIntent === "ask" ? JSON.stringify(result) : result.answer
        if (
          requestedIntent !== "ask" &&
          new TextEncoder().encode(raw).byteLength > RESPONSE_MAX_BYTES
        ) {
          throw new Error("provider returned a malformed response")
        }
      } else if (providerId === LOCAL_PROVIDER_ID) {
        // Trust boundary: a FRESH environment, never a spread of the parent's.
        // The adapter is the only ShellQ component that speaks HTTP, so no
        // proxy or credential variable may reach it even when this process
        // defines one. Preview opt-in is explicit, never inherited. Final
        // validation remains separate from the adapter's display-only NDJSON.
        child = Bun.spawn(session.provider, {
          env: localAdapterEnvironment(process.env, endpointStateRef.current.endpoint!, { model, thinking: requestedLocalThinking, preview: commandPreview }),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
        localChild = child
        active.process = child
        active.cancel = () => {
          void trackLocalTermination(child!)
        }
        if (cancelledRef.current) void trackLocalTermination(child)
        child.stdin.write(JSON.stringify(request))
        child.stdin.end()
        ;[raw, errorText, exitCode] = await Promise.all([
          previewOffered
            ? readAskStream(
                child.stdout as ReadableStream<Uint8Array>,
                onPreview,
                true,
                true,
                metrics => { reportedMetrics = metrics },
              )
            : readBounded(
                child.stdout as ReadableStream<Uint8Array>,
                RESPONSE_MAX_BYTES,
              ),
          readBounded(child.stderr as ReadableStream<Uint8Array>, 4096).catch(
            () => "",
          ),
          child.exited,
        ])
      } else {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...(providerDescriptor
            ? {
                [providerDescriptor.modelEnv]: model,
                [providerDescriptor.reasoningEnv]: reasoning,
              }
            : { SHELLQ_CODEX_MODEL: model, SHELLQ_CODEX_REASONING: reasoning }),
        }
        delete env.SHELLQ_CODEX_SESSION_FILE
        delete env.SHELLQ_CODEX_SESSION_ID
        delete env.SHELLQ_CODEX_NEW_SESSION
        delete env.SHELLQ_CLAUDE_SESSION_FILE
        delete env.SHELLQ_CLAUDE_SESSION_ID
        delete env.SHELLQ_CLAUDE_NEW_SESSION
        delete env.SHELLQ_ASK_PENDING_FILE
        delete env.SHELLQ_STREAM_PREVIEW
        if (commandPreview) env.SHELLQ_STREAM_PREVIEW = "1"
        if (requestedIntent === "ask") {
          if (providerDescriptor) env[providerDescriptor.workdirEnv] = trustedWorkdir
          else env.SHELLQ_CODEX_WORKDIR = trustedWorkdir
          env.SHELLQ_STREAM_PREVIEW = "1"
          if (providerId === "codex") {
            Object.assign(
              env,
              codexAskSessionEnvironment(
                session.provider,
                askSessionFile,
                appServer ? appServerStarts : codexExecStartsNewChat,
                engine ?? "exec",
                askCandidateFile,
                appServerResumeId,
              ),
            )
          } else {
            Object.assign(
              env,
              providerAskSessionEnvironment(
                session.provider,
                providerId,
                askSessionFile,
                claudeStarts,
                trustedWorkdir,
                askCandidateFile,
                claudeResumeId,
              ),
            )
          }
        } else {
          delete env.SHELLQ_CODEX_WORKDIR
        }
        child = Bun.spawn(
          requestedIntent === "ask"
            ? askProviderArgv(session, process.execPath, engine)
            : session.provider,
          {
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        active.process = child
        active.cancel = () => child?.kill()
        if (cancelledRef.current) child.kill()
        child.stdin.write(JSON.stringify(request))
        child.stdin.end()
        ;[raw, errorText, exitCode] = await Promise.all([
          previewOffered
            ? readAskStream(
                child.stdout as ReadableStream<Uint8Array>,
                onPreview,
                appServer || commandPreview,
                commandPreview,
                metrics => { reportedMetrics = metrics },
              )
            : readBounded(
                child.stdout as ReadableStream<Uint8Array>,
                RESPONSE_MAX_BYTES,
              ),
          readBounded(child.stderr as ReadableStream<Uint8Array>, 4096).catch(
            () => "",
          ),
          child.exited,
        ])
      }
      if (
        cancelledRef.current ||
        requestTokenRef.current !== requestToken ||
        !mountedRef.current || active.closed
      ) {
        throw new Error("cancelled")
      }
      if (exitCode !== 0) {
        if (providerId === LOCAL_PROVIDER_ID) {
          if (exitCode === 71 || exitCode === 74) {
            const blockedEndpoint = endpointStateRef.current.endpoint
            if (blockedEndpoint) blockedLocalModelsRef.current.add(`${blockedEndpoint} ${model}`)
            pickerPaintedEpochRef.current += 1
            setPickerRevision((current) => current + 1)
          }
          throw new ProviderFailure(exitCode)
        }
        if (appServer) {
          throw new Error(appServerFailureMessage(exitCode))
        }
        throw new Error(
          `provider exited ${exitCode}${
            errorText ? `: ${oneLine(sanitizeContext(errorText), 80)}` : ""
          }`,
        )
      }

      if (requestedIntent === "ask") {
        const next = parseAskResponse(raw)
        if (!next) {
          if (reusableSession && askCandidateFile) {
            active.session?.discardStagedPointer(askCandidateFile)
          }
          throw new Error("provider returned a malformed Ask response")
        }
        if (
          requiresPointerCommit &&
          !finalizeAskSessionPointer(
            askSessionFile,
            true,
            askCandidateFile,
            appServer
              ? { provider: "codex-app-server", cwd: trustedWorkdir }
              : providerId
                ? { provider: providerId, cwd: trustedWorkdir }
                : undefined,
          )
        ) {
          if (reusableSession) await retireAppServerSession()
          throw new Error("could not save the new Ask chat")
        }
        setAskPreview({ note: "", text: "", thinking: "" })
        setConversation((current) =>
          appendAskTurn(current, { question: query, answer: next.answer }),
        )
        setConversationOffset(null)
        if (askSessionFile) {
          setAskChatSaved(true)
          setNewAskSession(false)
        }
        setPhase("answer")
        // The follow-up composer is immediately focused and empty rather
        // than requiring the user to press Enter first.
        setDraft("ask", "")
        changeEditorMode("composer")
        setResponseInfo({elapsedMs:performance.now()-startedAt, firstTextMs, metrics:reportedMetrics})
        return
      }

      const received = parseProviderResponses(raw, requestedIntent === "generate", candidateCount)
      if (!received) throw new Error("provider returned a malformed response")
      setAskPreview({ note: "", text: "", thinking: "" })
      const next = received[0]!
      if (!next.corrected_command) {
        setDraft(requestedIntent, "")
        setDiagnosis(next.tldr)
        setPhase(existingCandidates.length ? "candidate" : "analysis")
        changeEditorMode(existingCandidates.length ? "view" : "composer")
        setDetail("no safe single command")
        return
      }

      setResponseInfo({elapsedMs:performance.now()-startedAt, firstTextMs, metrics:reportedMetrics})
      const grown = received.reduce(appendCandidate, existingCandidates)
      if (grown === existingCandidates) {
        setPhase(existingCandidates.length ? "candidate" : "ready")
        changeEditorMode(existingCandidates.length ? "view" : "composer")
        setDetail("the provider repeated a command already listed")
        return
      }
      applyCandidates(grown)
      candidateIndexRef.current = candidateCount > 1 ? 0 : grown.indexOf(next)
      setCandidateIndex(candidateIndexRef.current)
      candidatesEverCreatedRef.current += 1
      setPhase("candidate")
      setDetail("")
    } catch (error) {
      setAskPreview({ note: "", text: "", thinking: "" })
      // A local adapter is not merely signalled: the request is not finished
      // until it has actually exited, forced if the graceful signal is ignored.
      if (localChild) await trackLocalTermination(localChild)
      else child?.kill()
      if (reusableSession && !reusableTransportSealed) {
        await retireAppServerSession()
      }
      if (requestedIntent === "ask") {
        setAskPreview({ note: "", text: "", thinking: "" })
        if (
          requestTokenRef.current === requestToken &&
          (providerId !== "claude" || askCandidateFile)
        ) {
          finalizeAskSessionPointer(
            askSessionFile,
            false,
            askCandidateFile,
            providerId ? { provider: providerId, cwd: trustedWorkdir } : undefined,
          )
        }
      }
      const presentedError =
        providerId === LOCAL_PROVIDER_ID
          ? new Error(localFailureMessage(error instanceof ProviderFailure ? error.code : 1))
          : error instanceof ProviderFailure
          ? new Error(appServerFailureMessage(error.code))
          : error
      const outcome = requestOutcome(presentedError, cancelledRef.current)
      if (candidatesRef.current.length) {
        setPhase("candidate")
        changeEditorMode("view")
      } else {
        setPhase(outcome.phase)
        changeEditorMode("composer")
      }
      setDetail(outcome.message)
    } finally {
      active.process = null
      active.cancel = null
      busyRef.current = false
      cancelledRef.current = false
    }
  }

  // Mirrors what Escape does for whichever promoted surface is showing, so a
  // click on `Esc back` and the key it names cannot diverge. It never closes
  // the workbench itself — `Esc back` is only offered while a surface is open.
  const leavePromotedSurface = () => {
    if (editorModeRef.current === "endpoint") { closeEndpointEditor(); return }
    if (doctorActiveRef.current || view === "doctor") {
      leaveDoctor()
      return
    }
    if (settingsOpen) {
      if (settingsOpen === "picker") {
        if (!pickerApplyingRef.current) {
          const query = normalizeSettingsQuery(pickerInputRef.current?.plainText ?? pickerQuery)
          if (query) {
            pickerQuerySyncRef.current = ""
            pickerInputRef.current?.editBuffer.setText("")
            if (pickerInputRef.current) pickerInputRef.current.cursorOffset = 0
            setPickerQuery("")
            pickerIndexRef.current = 0
            setPickerIndex(0)
            pickerPaintedEpochRef.current += 1
            return
          }
          if (paletteView !== "root") {
            changePaletteView("root")
            pickerIndexRef.current = 0
            setPickerIndex(0)
            pickerPaintedEpochRef.current += 1
            return
          }
          pickerExitCauseRef.current = "escape"
          pickerActivationEpochRef.current += 1
          pickerPaintedEpochRef.current += 1
          // Escape aborts an in-flight check and destroys its socket by
          // reaping the adapter that owns it; the surface simply closes.
          void stopLocalDiscovery()
          setSettingsOpen(false)
        }
        return
      }
      if (settingsOpen === "setup") {
        if (setupDismissalPendingRef.current) return
        setupDismissalPendingRef.current = true
        const retiring = setupRetirementRef.current ?? Promise.resolve()
        setupRetirementRef.current = null
        // Leaving Setup cancels its background discovery and reaps the scan.
        void stopLocalDiscovery()
        const closeSetup = () => {
          setupDismissalPendingRef.current = false
          setSettingsOpen(false)
        }
        void retiring.then(closeSetup, closeSetup)
      } else {
        setSettingsOpen(false)
      }
      return
    }
    if (actionsOpen) {
      closeActions()
      setDetail("")
      return
    }
    if (view === "details") setView("main")
  }

  const setEndpointConfirm = (operation: "save" | "reset" | null) => {
    endpointConfirmationRef.current = operation
    setEndpointConfirmation(operation)
  }

  const openEndpointEditor = () => {
    if (busyRef.current || doctorActiveRef.current || pickerApplyingRef.current || editorModeRef.current === "endpoint") return
    // Opening the picker already captured a suspended normal editor exactly once.
    if (!isEditingMode(editorModeRef.current)) {
      setDraft(intentRef.current, composerRef.current?.plainText ?? drafts[intentRef.current])
    }
    endpointReturnRef.current = { mode: editorModeRef.current, view }
    endpointDraftRef.current = endpointStateRef.current.endpoint ?? ""
    const settings = readPersistedInferenceDocumentState()
    setEndpointWarning(settings.kind === "invalid" || settings.kind === "operational-error")
    setEndpointError("")
    setEndpointConfirm(null)
    pickerActivationEpochRef.current += 1
    pickerPaintedEpochRef.current += 1
    pickerExitCauseRef.current = "route"
    closeActions()
    setSettingsOpen(false)
    setView("main")
    changeEditorMode("endpoint")
    setDetail("")
  }

  const closeEndpointEditor = (message = "endpoint edit discarded") => {
    if (endpointApplyingRef.current) return
    const prior = endpointReturnRef.current
    if (!prior || !mountedRef.current || active.closed) return
    endpointReturnRef.current = null
    endpointDraftRef.current = ""
    setEndpointConfirm(null)
    ctrlXRef.current = false
    changeEditorMode(prior.mode)
    setView(prior.view)
    setDetail(message)
  }

  const applyEndpointEdit = (operation: "save" | "reset", confirmed = false) => {
    if (editorModeRef.current !== "endpoint" || endpointApplyingRef.current || busyRef.current) return
    if (endpointStateRef.current.readOnly) return
    const raw = operation === "reset" ? DEFAULT_LOCAL_ENDPOINT : endpointRef.current?.plainText ?? endpointDraftRef.current
    const parsed = parseLocalEndpoint(raw)
    if (!parsed) { setEndpointError("invalid local endpoint; use a literal loopback HTTP base"); return }
    endpointDraftRef.current = endpointRef.current?.plainText ?? endpointDraftRef.current
    if (endpointWarning && !confirmed) { setEndpointConfirm(operation); return }
    let saved = true
    let message = operation === "reset" ? "local endpoint reset" : "local endpoint saved"
    try {
      writePersistedLocalEndpoint(operation === "reset" ? null : parsed.raw, providerId, process.env, confirmed)
    } catch (error) {
      if (error instanceof EndpointSettingsWriteError && error.reason === "confirmation") {
        setEndpointWarning(true)
        setEndpointConfirm(operation)
        return
      }
      saved = false
      message = error instanceof EndpointSettingsWriteError && error.reason === "safe-path"
        ? "could not repair settings safely; correct the settings path or access; using endpoint for this invocation"
        : "could not save endpoint; using for this invocation"
    }
    const changed = endpointStateRef.current.endpoint !== parsed.raw
    endpointStateRef.current = { endpoint: parsed.raw, source: saved ? operation === "reset" ? "default" : "saved" : "not saved", readOnly: false }
    session.localEndpoint = endpointStateRef.current
    if (!changed) { closeEndpointEditor(message); return }
    blockedLocalModelsRef.current.clear()
    pickerActivationEpochRef.current += 1
    pickerPaintedEpochRef.current += 1
    const retiring = stopLocalDiscovery()
    publishLocalCatalogs({})
    endpointApplyingRef.current = true
    setEndpointError("finishing previous local check")
    void retiring.then(() => {
      endpointApplyingRef.current = false
      closeEndpointEditor(message)
    })
  }

  const saveEdit = () => {
    if (editorModeRef.current === "endpoint") { applyEndpointEdit("save"); return }
    const edited = editorRef.current?.plainText ?? editorDraftRef.current
    if (edited === null) return
    if (editorMode === "context") {
      const saved = saveContextDraft(edited)
      setContext(saved.context)
      setIncludeByIntent({ ask: false, generate: false, correct: false })
      setContextEdited(saved.context !== session.context.text)
      setDetail(
        saved.context
          ? "output saved · include it explicitly before sending"
          : "output cleared and excluded",
      )
    } else if (editorMode === "prompt") {
      setDraft(intent, edited)
      setComposerRevision((current) => current + 1)
      setDetail("prompt edit saved · enter submits")
    } else if (commandIsValid(edited)) {
      applyCandidates(
        candidatesRef.current.map((item, index) => {
          if (index !== candidateIndexRef.current) return item
          const replacement = { ...item, corrected_command: edited }
          // Assessment belongs to the original response even after an edit is reverted.
          if (edited !== item.corrected_command || editedCandidatesRef.current.has(item)) {
            editedCandidatesRef.current.add(replacement)
          }
          return replacement
        }),
      )
      setDetail("command edit saved · zsh validates it again before insert")
    } else {
      setDetail("not a valid single command · 1–8192 printable characters")
      return
    }
    editorDraftRef.current = null
    changeEditorMode(
      conversation.turns.length || candidatesRef.current.length
        ? "view"
        : "composer",
    )
  }

  const handleCtrlX = (action: CtrlXAction) => {
    if (editorModeRef.current === "endpoint") {
      if (action === "save") saveEdit()
      else if (action === "reasoning") applyEndpointEdit("reset")
      return
    }
    closeActions()
    switch (action) {
      case "context":
        if (isEditingMode(editorMode) && editorMode !== "context") {
          setDetail("save or discard the edit first")
          return
        }
        setView("main")
        if (editorMode !== "context") editorDraftRef.current = context
        changeEditorMode("context")
        setDetail("")
        return
      case "doctor":
        openDoctor()
        return
      case "engine":
        openPicker("engine")
        return
      case "provider":
        openProviderSetup()
        return
      case "include":
        toggleContext()
        return
      case "settings":
        openPicker()
        return
      case "model":
        openPicker("model")
        return
      case "reasoning":
        openPicker("reasoning")
        return
      case "details":
        if (view === "details") {
          setView("main")
        } else if (isEditingMode(editorMode)) {
          setDetail("save or discard the edit before opening details")
        } else {
          setDetailIndex(0)
          setDetailOffset(0)
          setView("details")
        }
        return
      case "edit":
        if (isEditingMode(editorMode) && editorMode === "context") {
          setDetail("save or discard the edit first")
          return
        }
        setView("main")
        if (intent === "ask") {
          if (editorMode !== "prompt") {
            editorDraftRef.current =
              (composerRef.current?.plainText ?? drafts.ask) || lastAskQuery
          }
          changeEditorMode("prompt")
          setDetail(lastAskQuery ? "editing question" : "editing prompt")
        } else if (candidate) {
          if (editorMode !== "command") {
            editorDraftRef.current = candidate.corrected_command ?? ""
          }
          changeEditorMode("command")
          setDetail("")
        } else {
          if (editorMode !== "prompt") editorDraftRef.current = drafts[intent]
          changeEditorMode("prompt")
          setDetail("editing prompt")
        }
        return
      case "new-chat":
        if (intent !== "ask") {
          setDetail("new chat is available in Ask mode")
          return
        }
        setView("main")
        const retiring = retireAppServerSession()
        const generation = active.appServerGeneration ?? 0
        void retiring.then(() => prepareAppServer(true, generation))
        setNewAskSession(askSessionFile !== null)
        setConversation(emptyAskConversation())
        setConversationOffset(null)
        setDiagnosis(null)
        setLastAskQuery("")
        setDraft("ask", "")
        changeEditorMode("composer")
        setPhase("ready")
        setComposerRevision((current) => current + 1)
        setDetail(
          askSessionFile
            ? "new chat ready · the saved chat stays until the first answer"
            : "new one-shot question ready",
        )
        return
      case "another":
        if (intentRef.current === "ask") {
          setDetail(providerId === LOCAL_PROVIDER_ID
            ? "type a new one-shot local question"
            : "press enter on the answer to ask a follow-up")
        } else {
          void requestProvider(
            composerRef.current?.plainText ?? drafts[intentRef.current],
          )
        }
        return
      case "save":
        if (isEditingMode(editorMode)) {
          saveEdit()
        } else {
          setDetail("nothing is being edited")
        }
    }
  }

  // Shared by a resolved Ctrl-X chord letter and an actions-sheet row click:
  // `close` is not a `CtrlXAction` (it is the sheet's own Esc cell), so it is
  // handled here rather than inside `handleCtrlX`.
  const resolveActionsSheetAction = (action: ActionsSheetAction) => {
    if (action === "close") {
      closeActions()
      setDetail("")
      return
    }
    handleCtrlX(action)
  }

  // Resolves the letter following an opened actions sheet the same way
  // regardless of whether the sheet opened via the Ctrl-X chord or a click
  // on the rail's `^X actions` — both leave the sheet showing every letter,
  // so both must accept the same keystrokes.
  const chordLetter = (key: { name: string; sequence: string }) =>
    key.name.length === 1
      ? key.name
      : key.sequence.length === 1
        ? key.sequence
        : ""

  const rows = Math.max(0, Math.min(footerHeight, renderer.height) - 2)
  // The query owns one interior row; a short terminal windows results rather
  // than painting the overflow over the bottom rail.
  const pickerVisibleRows = Math.max(0, Math.min(SETTINGS_PICKER_VISIBLE_ROWS, rows - 1))
  const endpointRows = Math.min(rows, height - 2)
  const details = metadataItems({
    askChatState,
    candidate,
    candidateCount: candidates.length,
    candidateIndex,
    contextBytes,
    contextLabel,
    contextSource,
    cwd: trustedWorkdir,
    included: includeContext,
    lastCommand: session.last_command,
    model,
    provider: providerId ?? "custom",
    providerCommand:
      session.provider_source === "configured" ? session.provider : undefined,
    engine: engine === null ? undefined : ENGINE_LABELS[engineIndex],
    reasoning,
    repositoryAccess,
  })
  if (candidate && editedCandidatesRef.current.has(candidate)) {
    details.push({key:"Assessment", value:"edited; not reassessed"})
  }
  if (responseInfo) details.push({key:"Last response",value:responseSummary(responseInfo.elapsedMs,responseInfo.metrics,true) +
    (responseInfo.firstTextMs === undefined ? "" : ` · first text ${(responseInfo.firstTextMs/1000).toFixed(1)}s`)})
  const inspectorItems = view === "doctor" ? doctorRows : details
  const detailKeyWidth =
    Math.max(...inspectorItems.map((item) => terminalWidth(item.key))) + 2
  const detailValueWidth = Math.max(4, layout.interior - detailKeyWidth - 3)
  const detailStart = Math.min(
    Math.max(0, detailIndex - Math.floor(rows / 2)),
    Math.max(0, inspectorItems.length - rows),
  )
  const visibleDetails = inspectorItems.slice(detailStart, detailStart + rows)

  const canRequestAlternative = (selectedIntent: SessionIntent) => {
    if (selectedIntent === "ask") return false
    const draft = composerRef.current?.plainText ?? drafts[selectedIntent]
    return (
      candidatesRef.current.length < CANDIDATE_LIMIT &&
      session.requests[selectedIntent] !== null &&
      commandIsValid(draft)
    )
  }

  const pickerSources = useMemo<UniversalPaletteRecord[]>(() => {
    return livePickerSources()
  }, [initialChoices, allProviderChoices, codexCatalog, codexDiscoveryState, codexEngine, codexEngineAvailable, context, doctorAvailable, editorMode, engine, hasCandidateList, includeByIntent, intent, localCatalogs, localChecking, model, paletteView, phase, pickerQuery, pickerRevision, pickerScope, providerId, reasoning, session.actionable_failure, session.models, session.provider_source, session.reasoning_levels, view])
  const pickerResults = useMemo(
    () => settingsPickerCandidates(pickerQuery, pickerSources),
    [pickerQuery, pickerSources],
  )

  const liveActions = () => {
    const selectedIntent = intentRef.current
    const selectedEditor = editorModeRef.current
    return actionsSheetLines(
      {
        doctorAvailable,
        editing: isEditingMode(selectedEditor),
        canRequestAlternative: canRequestAlternative(selectedIntent),
        editorMode: selectedEditor,
        hasCandidateList:
          selectedIntent !== "ask" && candidatesRef.current.length > 0,
        hasEngine: engine !== null,
        providerAvailable:
          providerId !== null || session.provider_source === "configured",
        includeContext: includeByIntent[selectedIntent],
        intent: selectedIntent,
        model,
        reasoning,
      },
      layout.interior,
      unicode,
    ).actions
  }

  useKeyboard((key) => {
    const handled = () => {
      key.preventDefault()
      key.stopPropagation()
    }
    const isShiftTab =
      (key.name === "tab" && key.shift) || key.sequence === "\u001b[Z"
    const isEnter = ["return", "enter", "kpenter", "linefeed"].includes(
      key.name,
    )
    const isCtrlX =
      (key.ctrl && key.name === "x") || key.sequence === "\u0018"

    if (key.ctrl && key.name === "c") {
      handled()
      active.cancel?.()
      renderer.destroy()
      return
    }

    if (editorModeRef.current === "endpoint") {
      if (endpointApplyingRef.current) { handled(); return }
      if (isCtrlX) { handled(); ctrlXRef.current = true; return }
      if (key.name === "escape") {
        handled()
        if (endpointConfirmationRef.current) setEndpointConfirm(null)
        else closeEndpointEditor()
        ctrlXRef.current = false
        return
      }
      if (ctrlXRef.current) {
        handled()
        ctrlXRef.current = false
        const letter = chordLetter(key)
        if (letter === "w") saveEdit()
        else if (letter === "r") applyEndpointEdit("reset")
        return
      }
      if (isEnter) {
        handled()
        if (endpointConfirmationRef.current) applyEndpointEdit(endpointConfirmationRef.current, true)
        return
      }
      if (key.name === "tab" || isShiftTab || endpointStateRef.current.readOnly || endpointConfirmationRef.current) handled()
      return
    }

    if (key.name === "escape" && localDiscoveryRunningRef.current) {
      void stopLocalDiscovery()
    }

    if (thinkingControlVisible && key.ctrl && key.name === "t") {
      handled()
      toggleModelThinking()
      return
    }
    if (busyRef.current) {
      handled()
      if (phase === "streaming" && ["up", "down", "pageup", "pagedown"].includes(key.name)) {
        const direction = key.name === "up" || key.name === "pageup" ? -1 : 1
        scrollStream(direction * (key.name.startsWith("page") ? streamRows : 1))
      }
      if (key.name === "escape") {
        cancelledRef.current = true
        setAskPreview({ note: "", text: "", thinking: "" })
        setPhase("cancelled")
        setDetail("cancelling the request · no result will be accepted")
        active.cancel?.()
        active.process?.kill()
      }
      return
    }

    if (doctorActiveRef.current || view === "doctor") {
      handled()
      if (ctrlXRef.current) {
        ctrlXRef.current = false
        if (key.name === "escape") {
          leaveDoctor()
          return
        }
        if (ctrlXAction(chordLetter(key)) === "doctor") leaveDoctor()
        return
      }
      if (isCtrlX) {
        ctrlXRef.current = true
        return
      }
      if (key.name === "escape") {
        leaveDoctor()
      } else if (key.name === "up" || key.name === "down") {
        setDetailIndex((current) => {
          const direction = key.name === "up" ? -1 : 1
          return (current + direction + doctorRows.length) % doctorRows.length
        })
        setDetailOffset(0)
      } else if (key.name === "left") {
        setDetailOffset((current) =>
          Math.max(0, current - Math.max(4, detailValueWidth - 2)),
        )
      } else if (key.name === "right") {
        const maxOffset = Math.max(
          0,
          terminalWidth(doctorRows[detailIndex].value) - detailValueWidth + 1,
        )
        setDetailOffset((current) =>
          Math.min(current + Math.max(4, detailValueWidth - 2), maxOffset),
        )
      }
      return
    }

    if (settingsOpen === "picker") {
      if (pickerApplyingRef.current) {
        handled()
        return
      }
      if (key.name === "escape") {
        handled()
        leavePromotedSurface()
        return
      }
      if (key.name === "up" || key.name === "down") {
        handled()
        movePicker(key.name === "up" ? -1 : 1)
        return
      }
      if (isEnter) {
        handled()
        applyPicker()
        return
      }
      if (isCtrlX || (key.ctrl && key.name !== "c")) {
        handled()
        return
      }
      return
    }

    // Sits before `isCtrlX` so a fresh Ctrl-X chord (e.g. Ctrl-X A) can never
    // reach the provider router while Settings is open: every key is
    // swallowed here first, closing the hole that would otherwise let
    // `Ctrl-X A` start a request out from under the Settings surface.
    if (settingsOpen) {
      handled()
      if (key.name === "escape" || isEnter) {
        leavePromotedSurface()
      } else if (key.name === "up" || key.name === "down") {
        const fields: SettingsField[] = settingsOpen === "setup"
          ? [
              "provider",
              ...(session.provider_source === "configured" || providerId !== null
                ? ["model" as const, "reasoning" as const]
                : []),
            ]
          : [
              ...(providerId && session.provider_source !== "configured"
                ? ["provider" as const]
                : []),
              ...(engine === null ? [] : ["engine" as const]),
              "model",
              "reasoning",
            ]
        setSettingsField((current) => {
          const index = fields.indexOf(current)
          const direction = key.name === "up" ? -1 : 1
          return fields[(index + direction + fields.length) % fields.length]
        })
      } else if (key.name === "left" || key.name === "right") {
        const direction = key.name === "left" ? -1 : 1
        if (settingsField === "provider") stepProvider(direction)
        else if (settingsField === "engine") stepEngine(direction)
        else if (settingsField === "model") stepModel(direction)
        else stepReasoning(direction)
      }
      return
    }

    if (key.ctrl && key.name === "k") {
      handled()
      flushSync(() => openPicker())
      return
    }

    if (isCtrlX) {
      handled()
      if (intentChangedThisTickRef.current) return
      if (isEditingMode(editorMode)) {
        editorDraftRef.current =
          editorRef.current?.plainText ?? editorDraftRef.current
      }
      ctrlXRef.current = true
      flushSync(openActions)
      // The sheet itself now spells out every letter, so the rail's note
      // slot no longer needs a redundant hint — and clearing it here is what
      // stops a stale `ctrl-x: …` string from displacing the candidate note
      // once the chord resolves.
      setDetail("")
      return
    }

    if (ctrlXRef.current) {
      ctrlXRef.current = false
      closeActions()
      if (key.name !== "escape") {
        handled()
        const action = ctrlXAction(chordLetter(key))
        if (action === "settings") {
          flushSync(() => openPicker())
        } else if (action && liveActions().includes(action)) {
          flushSync(() => handleCtrlX(action))
        }
        else setDetail("unknown ctrl-x chord")
        return
      }
      handled()
      setDetail("")
      return
    }

    // Only reachable when the sheet was opened by a click on `^X actions`
    // rather than the Ctrl-X chord (that path resolves above via
    // `ctrlXRef`), so a subsequent letter still has to resolve here — a
    // mouse-opened sheet must accept the same keystrokes a chord-opened one
    // does.
    if (actionsOpen) {
      handled()
      if (key.name === "escape") {
        closeActions()
        setDetail("")
        return
      }
      const action = ctrlXAction(chordLetter(key))
      if (action === "settings") {
        flushSync(() => openPicker())
      } else if (action && liveActions().includes(action)) {
        flushSync(() => resolveActionsSheetAction(action))
      } else {
        closeActions()
        setDetail("unknown ctrl-x chord")
      }
      return
    }

    if (view === "details") {
      if (key.name === "escape") {
        handled()
        setView("main")
      } else if (key.name === "up" || key.name === "down") {
        handled()
        setDetailIndex((current) => {
          const direction = key.name === "up" ? -1 : 1
          return (current + direction + details.length) % details.length
        })
        setDetailOffset(0)
      } else if (key.name === "left") {
        handled()
        setDetailOffset((current) =>
          Math.max(0, current - Math.max(4, detailValueWidth - 2)),
        )
      } else if (key.name === "right") {
        handled()
        const maxOffset = Math.max(
          0,
          terminalWidth(details[detailIndex].value) - detailValueWidth + 1,
        )
        setDetailOffset((current) =>
          Math.min(
            maxOffset,
            current + Math.max(4, detailValueWidth - 2),
          ),
        )
      }
      return
    }

    if (key.name === "tab" || isShiftTab) {
      handled()
      closeActions()
      flushSync(() => selectIntent(isShiftTab ? -1 : 1))
      return
    }

    if (isEditingMode(editorMode)) {
      if (key.name === "escape") {
        handled()
        editorDraftRef.current = null
        changeEditorMode(
          conversation.turns.length || candidatesRef.current.length
            ? "view"
            : "composer",
        )
        setDetail("edit discarded")
      } else if (isEnter) {
        // Keep editor Enter out of the native submit path; Ctrl-X W is the
        // only operation allowed to commit an edit.
        handled()
        editorRef.current?.newLine()
      }
      return
    }

    if (showComposerRow) {
      if (key.name === "escape") {
        handled()
        renderer.destroy()
        return
      }
      if (intent === "ask" && conversation.turns.length > 0) {
        if (key.name === "up" || key.name === "down") {
          // React draft state can lag the native buffer within one stdin drain.
          const draft = composerRef.current?.plainText ?? drafts.ask
          if (draft.length === 0) {
            handled()
            setConversationOffset((current) =>
              steppedConversationOffset(
                current ?? conversationMaxOffset,
                conversationMaxOffset,
                key.name === "up" ? -1 : 1,
              ),
            )
          }
          return
        }
        // Unconditional, unlike the empty-composer Up/Down above: a
        // follow-up already being typed must not take away the only way to
        // scroll the answer, which is exactly the parity gap this closes.
        if (
          key.name === "pageup" ||
          key.name === "pagedown" ||
          key.sequence === "\u001b[5~" ||
          key.sequence === "\u001b[6~"
        ) {
          handled()
          const direction =
            key.name === "pageup" || key.sequence === "\u001b[5~" ? -1 : 1
          setConversationOffset((current) =>
            steppedConversationOffset(
              current ?? conversationMaxOffset,
              conversationMaxOffset,
              direction * Math.max(1, leadRows),
            ),
          )
        }
      }
      return
    }

    // Only the candidate list reaches this point: details, actions, editors,
    // and the resting/answer composer are all handled above.
    if (key.name === "escape") {
      handled()
      renderer.destroy()
    } else if (
      key.name === "pageup" ||
      key.name === "pagedown" ||
      key.sequence === "\u001b[5~" ||
      key.sequence === "\u001b[6~"
    ) {
      handled()
      const direction =
        key.name === "pageup" || key.sequence === "\u001b[5~" ? -1 : 1
      candidateDescriptionRef.current?.scrollBy(direction * Math.max(1, Math.floor(candidateDescriptionRows / 2)))
    } else if (isEnter) {
      handled()
      if (!candidatesRef.current.length) return
      try {
        writeFileSync(
          resultPath,
          JSON.stringify(candidatesRef.current[candidateIndexRef.current]),
          { mode: 0o600 },
        )
        renderer.destroy()
      } catch {
        setDetail("could not write the accepted result")
      }
    } else if (key.name === "up" || key.name === "left") {
      handled()
      moveCandidate(-1)
    } else if (key.name === "down" || key.name === "right") {
      handled()
      moveCandidate(1)
    }
  })

  const status = verdict({
    confidence: candidate?.confidence ?? null,
    model,
    phase,
    risk: candidate?.risk ?? "",
  })
  const statusText = detail
    ? `${status.text} · ${oneLine(detail, 100)}`
    : status.text
  // `count > 1` reads true starting with the render that shows the second
  // candidate the session has ever produced — see `candidatesEverCreatedRef`
  // above for why that threshold, rather than a flip-before-use boolean,
  // is what keeps the very first candidate's own render showing the full
  // text.
  const insertActionTaught = candidatesEverCreatedRef.current > 1
  const pickerEscapeAction = normalizeSettingsQuery(
    pickerInputRef.current?.plainText ?? pickerQuery,
  )
    ? "clear"
    : paletteView === "root"
      ? "close"
      : "back"
  const pickerApplying = pickerApplyingRef.current
  const pickerFeedback = [...new Set([pickerStatus, detail].filter(Boolean))]
    .join(unicode ? " · " : " / ")
  const action = editorMode === "endpoint" ? "" : settingsOpen === "picker"
    ? universalPaletteStatus(
        pickerResults[pickerIndex],
        pickerApplying,
        "",
        layout.titleBudget,
        unicode,
        pickerEscapeAction,
      )
    : contextualAction({
        actionsOpen,
        editorMode,
        insertActionTaught,
        phase,
        settingsOpen: Boolean(settingsOpen),
        view,
      })
  const topRailResult = topRail(
    { intent, provider: providerId === LOCAL_PROVIDER_ID ? "Local" : providerId ?? "custom", model, reasoning },
    layout.titleBudget,
    unicode,
  )
  const metricsVisible = !settingsOpen && !actionsOpen && view === "main" && !isEditingMode(editorMode)
    && !detail && responseInfo !== null && (phase === "answer" || phase === "candidate")
  const responseMessage = metricsVisible
    ? responseSummary(responseInfo!.elapsedMs,responseInfo!.metrics,metricsExpanded)
    : null
  const runningMessage = !settingsOpen && !actionsOpen && view === "main" && requestStartedAt !== null &&
    (phase === "loading" || phase === "streaming")
    ? `${responseActivity} · ${responseSummary(Math.max(0,clockNow-requestStartedAt))}` : null
  const selectingCandidate = phase === "candidate" && view === "main" && !settingsOpen && !actionsOpen && !isEditingMode(editorMode)
  const bottomRailResult = bottomRail(
    {
      action: selectingCandidate ? "Enter insert (never runs)" : [action, thinkingControl].filter(Boolean).join(" · "),
      contextBytes: selectingCandidate || settingsOpen === "picker" || editorMode === "endpoint" ? 0 : contextBytes,
      cwd: settingsOpen === "picker" ? "" : trustedWorkdir,
      included: includeContext,
      message: settingsOpen === "picker" ? pickerFeedback || null : detail || runningMessage || responseMessage,
      messageMaxWidth: metricsVisible ? layout.titleBudget : undefined,
      showCtrlX: settingsOpen !== "picker" && editorMode !== "endpoint",
    },
    layout.titleBudget,
    unicode,
  )
  // This model paints the sheet; `liveActions` above rebuilds the same pure
  // model from synchronous refs for a letter that arrives before repaint.
  const actionsSheet = actionsSheetLines(
    {
      doctorAvailable,
      editing: isEditingMode(editorMode),
      canRequestAlternative: canRequestAlternative(intent),
      editorMode,
      hasCandidateList,
      hasEngine: engine !== null,
      providerAvailable:
        providerId !== null || session.provider_source === "configured",
      includeContext,
      intent,
      model,
      reasoning,
    },
    layout.interior,
    unicode,
  )
  const placeholder =
    intent === "ask"
      ? providerId === LOCAL_PROVIDER_ID
        ? "Ask a local question…"
        : conversation.turns.length
        ? "Ask a follow-up…"
        : "Ask about this repo or anything else…"
      : intent === "generate"
        ? "Describe the command you want…"
        : session.actionable_failure
          ? "Describe or refine the failed command…"
          : "Run an actionable failed command first"

  const candidatePrefixWidth = terminalWidth(candidateRowMarker(0, false, unicode))
  const candidateTextWidth = Math.max(
    8,
    layout.interior - candidatePrefixWidth,
  )
  // Keep the selected command visible even in a short split. Never leave an
  // off-screen selection insertable while showing only earlier choices.
  const assessmentRows = rows >= 3 ? 1 : 0
  const choiceSeparatorRows = rows >= 4 ? 1 : 0
  const visibleCandidateCount = Math.min(candidates.length, Math.max(1, rows - assessmentRows - choiceSeparatorRows - 1))
  const firstVisibleCandidate = Math.max(0, Math.min(candidateIndex - visibleCandidateCount + 1, candidates.length - visibleCandidateCount))
  const minimumDescriptionRows = hasCandidateList
    ? Math.max(0, Math.min(3, rows - visibleCandidateCount - assessmentRows - choiceSeparatorRows))
    : 0
  const selectedRowBudget = Math.max(
    1,
    rows - minimumDescriptionRows - assessmentRows - choiceSeparatorRows - Math.max(0, visibleCandidateCount - 1),
  )
  const candidateRows = candidates.slice(firstVisibleCandidate, firstVisibleCandidate + visibleCandidateCount).flatMap((item, visibleIndex) => {
    const index = firstVisibleCandidate + visibleIndex
    const selected = index === candidateIndex
    const marker = candidateRowMarker(index, selected, unicode)
    const indent = " ".repeat(terminalWidth(marker))
    const command = item.corrected_command ?? "no safe command"
    if (!selected) {
      return [
        {
          candidateIndex: index,
          key: `${index}-folded`,
          selected: false,
          text: `${marker}${truncateCells(
            visibleShellText(command),
            candidateTextWidth,
          )}`,
        },
      ]
    }
    return selectedCommandLines(
      command,
      candidateTextWidth,
      selectedRowBudget,
    ).map((line, lineIndex) => ({
      candidateIndex: index,
      key: `${index}-${lineIndex}`,
      selected: true,
      text: `${lineIndex === 0 ? marker : indent}${line}`,
    }))
  }).slice(0, Math.max(0, rows - minimumDescriptionRows - assessmentRows - choiceSeparatorRows))

  // Give spare height to the reader, so the last choice stays above the footer.
  const candidateDescriptionRows = hasCandidateList
    ? Math.max(0, rows - assessmentRows - choiceSeparatorRows - candidateRows.length)
    : 0

  const composerRows =
    phase === "loading" || phase === "streaming"
      ? 0
      : Math.min(composerLines, rows)
  const leadRows = Math.max(0, rows - composerRows)
  const streamRows = Math.max(1, leadRows - 2)
  const streamMaxOffset = Math.max(0, streamLines.length - streamRows)
  streamMaxOffsetRef.current = streamMaxOffset
  const visibleStreamOffset = Math.min(streamOffset ?? streamMaxOffset, streamMaxOffset)
  const scrollStream = (delta: number) => {
    setStreamOffset((offset) => {
      const next = Math.max(0, Math.min(streamMaxOffset, (offset ?? streamMaxOffset) + delta))
      return next === streamMaxOffset ? null : next
    })
  }
  useEffect(() => {
    const previous = streamLinesRef.current
    streamLinesRef.current = streamLines
    if (phase !== "streaming") { setStreamOffset(null); return }
    // Preserve the first visible retained line when bounded text loses its
    // prefix. If that line was evicted, show the oldest remaining content.
    setStreamOffset((offset) => {
      if (offset === null || !previous.length) return offset
      return retainedPreviewOffset(previous, streamLines, offset)
    })
  }, [phase, askPreview, layout.interior, showThinking])
  const inFlightQuestion = truncateCells(
    `You: ${oneLine(lastAskQuery, ASK_QUERY_MAX_BYTES)}`,
    layout.interior,
  )
  const conversationMaxOffset = Math.max(
    0,
    conversationLines.length - leadRows,
  )
  conversationMaxOffsetRef.current = conversationMaxOffset
  const conversationDisplayOffset = Math.min(
    conversationOffset ?? conversationMaxOffset,
    conversationMaxOffset,
  )
  const visibleConversationRows = conversationRows.slice(
    conversationDisplayOffset,
    conversationDisplayOffset + leadRows,
  )
  // Bounded to whatever the footer actually granted this render: the effect
  // that grows `renderer.footerHeight` to fit the preview commits after this
  // render, so the very first frame can still see the old, smaller `rows`.
  const preview = previewVisible ? contextPreview(context, layout.interior) : null
  const previewLines = preview
    ? [preview.label, ...preview.rows].slice(0, leadRows)
    : []
  const setup = providerSetupLines(
    {
      field: settingsField,
      providerId,
      providers: allProviderChoices.map(({ id, selectable, enabled }) => ({
        id,
        selectable,
        enabled,
      })),
      modelIndex: effectiveModelIndex,
      models: modelChoices,
      reasoningIndex: effectiveReasoningIndex,
      reasoningLevels: reasoningChoices,
      controlsEnabled: session.provider_source === "configured" || providerId !== null,
      configured: session.provider_source === "configured",
    },
    layout.interior,
    unicode,
  )
  const pickerResultRows = settingsPickerWindow(pickerResults, pickerIndex, pickerVisibleRows)
  const pickerPaintedEpoch = pickerPaintedEpochRef.current
  const pickerPaintedRows = Array.from({ length: pickerVisibleRows }, (_, index) =>
    pickerResultRows[index] ?? null,
  )
  const pickerResultTexts = pickerPaintedRows.map((item, index) => {
    if (!item) {
      return {
        focused: false,
        text: pickerResults.length === 0 && index === 0 ? "No matching settings" : "",
      }
    }
    const resultIndex = pickerResults.indexOf(item)
    const providerPrefix = item.providerLabel ? `${item.providerLabel}/` : ""
    const originalLabel = item.label ?? item.display
    const label = providerPrefix && originalLabel.startsWith(providerPrefix)
      ? originalLabel.slice(providerPrefix.length)
      : originalLabel
    const separator = unicode ? " · " : " / "
    const parentIntent = normalizeSettingsQuery(pickerQuery)
      ? settingsParentIntent(item)
      : null
    const intentSuffix = parentIntent ? `${separator}${parentIntent}` : ""
    const truncatePickerText = (value: string, width: number) => {
      if (unicode) return truncateCells(value, width)
      if (terminalWidth(value) <= width) return value
      if (width <= 3) return ".".repeat(Math.max(0, width))
      return `${sliceCells(value, 0, width - 3)}...`
    }
    const primary = intentSuffix
      ? `${truncatePickerText(
          label,
          Math.max(1, layout.interior - terminalWidth(intentSuffix)),
        )}${intentSuffix}`
      : label
    const metadata = [
      item.providerLabel && label !== item.providerLabel ? item.providerLabel : null,
      item.current ? "current" : null,
      item.kind === "n-a" ? "unavailable" : null,
    ].filter((value): value is string => value !== null)
    const suffix = metadata.length ? `${separator}${metadata.join(separator)}` : ""
    const suffixFits = terminalWidth(primary) + terminalWidth(suffix) <= layout.interior
    const visibleSuffix = suffixFits ? suffix : ""
    const primaryBudget = Math.max(1, layout.interior - terminalWidth(visibleSuffix))
    const visiblePrimary = truncatePickerText(primary, primaryBudget)
    const row = `${visiblePrimary}${" ".repeat(Math.max(
      0,
      layout.interior - terminalWidth(visiblePrimary) - terminalWidth(visibleSuffix),
    ))}${visibleSuffix}`
    return {
      focused: resultIndex === pickerIndex,
      text: sliceCells(row, 0, layout.interior),
    }
  })
  const pickerQueryPrefix = paletteView === "root"
    ? "Search All: "
    : paletteView === "model"
      ? "Search Models: "
      : paletteView === "effort"
        ? "Search Effort: "
        : paletteView === "provider"
          ? "Search Providers: "
          : paletteView === "engine"
          ? "Search Engines: "
            : "Search More: "
  // The one handler on the frame box: `y` is already footer-band-relative
  // (opentui subtracts `renderOffset` before hit-testing in split-footer
  // mode), so `0` is always the title row and `renderer.footerHeight - 1`
  // is always the bottom rail — read from the live renderer field, never
  // React state, so a click can never land in the window between
  // `renderer.footerHeight` changing and React installing new spans.
  const onFrameMouseDown = (event: OpenTuiMouseEvent) => {
    if (event.button !== 0) return
    const metricsSpan = bottomRailResult.spans.message
    if (metricsVisible && metricsSpan && event.y === renderer.footerHeight - 1 &&
      event.x - TITLE_ORIGIN_X >= metricsSpan.start && event.x - TITLE_ORIGIN_X < metricsSpan.end) {
      event.stopPropagation()
      const next = !metricsExpandedRef.current
      try {
        writePersistedMetricsExpanded(next)
        metricsExpandedRef.current = next
        setMetricsExpanded(next)
      } catch {
        setDetail("metrics preference not saved · settings need attention")
      }
      return
    }
    if (thinkingControl && event.y === renderer.footerHeight - 1) {
      const index = bottomRailResult.text.indexOf(thinkingControl)
      const start = terminalWidth(bottomRailResult.text.slice(0, index))
      const x = event.x - TITLE_ORIGIN_X
      if (index >= 0 && x >= start && x < start + terminalWidth(thinkingControl)) {
        event.stopPropagation()
        toggleModelThinking()
        return
      }
    }
    if (busyRef.current || editorModeRef.current === "endpoint") return
    if (settingsOpen === "picker") return
    const doctorVisible = doctorActiveRef.current || view === "doctor"
    const x = event.x - TITLE_ORIGIN_X
    if (event.y === 0) {
      if (doctorVisible || settingsOpen) return
      const {
        mode: modeSpans,
        provider: providerSpan,
        model: modelSpan,
        reasoning: reasoningSpan,
      } = topRailResult.spans
      // Model/reasoning keep the exact reach they had on the old bottom
      // rail: no settings/actions/details guard, same as before their move.
      // Only the mode tabs (unchanged from before) are guarded below.
      if (providerSpan && x >= providerSpan.start && x < providerSpan.end) {
        openProviderSetup()
        return
      }
      if (modelSpan && x >= modelSpan.start && x < modelSpan.end) {
        openPicker("model")
        return
      }
      if (
        reasoningSpan &&
        x >= reasoningSpan.start &&
        x < reasoningSpan.end
      ) {
        openPicker("reasoning")
        return
      }
      if (settingsOpen || actionsOpen || view === "details" || doctorVisible) return
      for (const target of INTENTS) {
        const span = modeSpans[target]
        if (x >= span.start && x < span.end) {
          if (target !== intent) applyIntent(target)
          return
        }
      }
      return
    }
    if (event.y === renderer.height - 1) {
      const {
        action: actionSpan,
        ctrlX: ctrlXSpan,
        disclosure: disclosureSpan,
      } = bottomRailResult.spans
      // Clicking the disclosure toggles inclusion — the same thing Ctrl-X I
      // does. It changes only what the *next* request carries, so it submits
      // nothing and cannot leak on its own; the label always names the state
      // it is in.
      if (
        disclosureSpan &&
        x >= disclosureSpan.start &&
        x < disclosureSpan.end
      ) {
        if (settingsOpen || actionsOpen || view === "details" || doctorVisible) return
        toggleContext()
        return
      }
      // Only a dismissive action is reachable by pointer. `Enter insert
      // (never runs)`, `Enter retry`, and `Esc cancel` stay keyboard-only:
      // a click must never insert, submit, or cancel. Esc and Ctrl-X W keep
      // the keyboard half of parity.
      if (
        actionSpan &&
        x >= actionSpan.start &&
        x < actionSpan.end &&
        CLICKABLE_ACTIONS.has(action)
      ) {
        if (action === "^X W save") saveEdit()
        else leavePromotedSurface()
        return
      }
      // `^X actions`/`^X` toggles the sheet: clicking it while the sheet is
      // already open closes it, which is what the label's own `Esc back`
      // neighbour implies. Settings swallows Ctrl-X from the keyboard too,
      // so a click here matches that parity rather than stacking surfaces.
      if (ctrlXSpan && x >= ctrlXSpan.start && x < ctrlXSpan.end) {
        if (settingsOpen || doctorVisible) return
        if (actionsOpen) {
          closeActions()
          setDetail("")
          return
        }
        if (isEditingMode(editorMode)) {
          editorDraftRef.current =
            editorRef.current?.plainText ?? editorDraftRef.current
        }
        ctrlXRef.current = false
        openActions()
        setDetail("")
      }
    }
  }

  const onSettingsRowMouseDown = (
    field: SettingsField,
    ranges: { end: number; index: number; start: number }[],
  ) => (event: OpenTuiMouseEvent) => {
    if (event.button !== 0) return
    if (busyRef.current || editorModeRef.current === "endpoint") return
    setSettingsField(field)
    const x = event.x - INTERIOR_ORIGIN_X
    const hit = ranges.find((range) => x >= range.start && x < range.end)
    if (!hit) return
    if (field === "engine") stepEngine(hit.index - engineIndex)
    else if (field === "provider") {
      const id = providerChoices[hit.index]?.id
      if (id) selectProvider(id)
    }
    else if (field === "model") stepModel(hit.index - effectiveModelIndex)
    else stepReasoning(hit.index - effectiveReasoningIndex)
  }

  const onPickerResultMouseDown =
    (
      selected: (typeof pickerResults)[number],
      paintedIndex: number,
      paintedEpoch: number,
    ) => (event: OpenTuiMouseEvent) => {
      if (event.button !== 0 || busyRef.current || pickerApplyingRef.current || editorModeRef.current === "endpoint") return
      applyPickerSelection(selected, paintedIndex, paintedEpoch)
    }

  // Non-sending ranges come straight from `actionsSheetLines`, so a click can
  // never resolve to a cell the painted text does not actually show; sending
  // cells deliberately emit no range.
  const onActionsRowMouseDown =
    (cells: ActionsSheetCell[]) => (event: OpenTuiMouseEvent) => {
      if (event.button !== 0) return
      if (busyRef.current) return
      const x = event.x - INTERIOR_ORIGIN_X
      const hit = cells.find((cell) => x >= cell.start && x < cell.end)
      if (hit) resolveActionsSheetAction(hit.action)
    }

  return (
    <box
      border
      borderColor={theme.colors.border}
      borderStyle="rounded"
      bottomTitle={truncateCells(bottomRailResult.text, layout.titleBudget)}
      bottomTitleAlignment="left"
      customBorderChars={unicode ? undefined : ASCII_BORDER_CHARS}
      flexDirection="column"
      height="100%"
      onMouseDown={onFrameMouseDown}
      paddingLeft={1}
      paddingRight={1}
      title={truncateCells(topRailResult.text, layout.titleBudget)}
      titleAlignment="left"
      width="100%"
    >
      <box
        bottom={0}
        flexDirection="row"
        height={composerRows}
        position="absolute"
        visible={showComposerRow && composerRows > 0}
        width={layout.interior}
        zIndex={1}
      >
        {phase === "loading" || phase === "streaming" ? (
          <Spinner width={2} />
        ) : (
          <text fg={theme.colors.primary} width={2}>
            {unicode ? "› " : "> "}
          </text>
        )}
        <textarea
          focused={
            showComposerRow && phase !== "loading" && phase !== "streaming"
          }
          key="composer"
          keyBindings={[
            { action: "newline", name: "return", shift: true },
            { action: "submit", name: "return" },
            { action: "newline", name: "kpenter", shift: true },
            { action: "submit", name: "kpenter" },
          ]}
          onContentChange={() => {
            if (doctorActiveRef.current || editorModeRef.current === "endpoint") return
            const editor = composerRef.current
            if (!editor) return
            setDraft(intent, editor.plainText)
            setComposerLines(Math.max(1, editor.lineInfo.lineWraps.length))
            if (composerSyncRef.current) {
              composerSyncRef.current = false
              return
            }
            if (
              submittedComposerTextRef.current !== null &&
              editor.plainText === submittedComposerTextRef.current
            ) {
              return
            }
            submittedComposerTextRef.current = null
            setDetail("")
          }}
          onSubmit={() => {
            if (editorModeRef.current === "endpoint") return
            const text = composerRef.current?.plainText ?? drafts[intent]
            submittedComposerTextRef.current = text
            void requestProvider(composerText(text))
          }}
          placeholder={drafts[intent] ? "" : placeholder}
          ref={composerRef}
          width={layout.composer}
          wrapMode="word"
        />
      </box>
      {settingsOpen === "picker" ? (
        <box flexDirection="column" height={rows} width={layout.interior}>
          <box flexDirection="row" height={1} width={layout.interior}>
            <text>{pickerQueryPrefix}</text>
            <textarea
              focused={!pickerApplyingRef.current}
              height={1}
              key="settings-picker-query"
              onContentChange={() => {
                if (pickerApplyingRef.current) return
                const input = pickerInputRef.current
                if (!input) return
                const normalized = normalizeSettingsQuery(input.plainText)
                const programmaticQuery = pickerQuerySyncRef.current === normalized
                pickerQuerySyncRef.current = null
                const navigationQuery = pickerNavigationQueryRef.current === normalized
                pickerNavigationQueryRef.current = null
                if (input.plainText !== normalized) {
                  const cursorOffset = input.cursorOffset
                  const normalizedCursorOffset = normalizeSettingsQuery(
                    input.plainText.slice(0, cursorOffset),
                  ).length
                  input.editBuffer.setText(normalized)
                  input.cursorOffset = Math.min(normalizedCursorOffset, normalized.length)
                }
                if (!navigationQuery) {
                  pickerIndexRef.current = 0
                  pickerPaintedEpochRef.current += 1
                  setPickerIndex(0)
                }
                setPickerQuery(normalized)
                if (!programmaticQuery) setPickerStatus("")
              }}
              placeholder="type to filter"
              ref={pickerInputRef}
              width={Math.max(1, layout.interior - terminalWidth(pickerQueryPrefix))}
              wrapMode="none"
            />
          </box>
          {pickerPaintedRows.map((item, index) => (
            <text
              bg={pickerResultTexts[index]?.focused ? theme.colors.foreground : undefined}
              fg={pickerResultTexts[index]?.focused ? theme.colors.background : undefined}
              height={1}
              key={`picker-result-${index}`}
              onMouseDown={
                item && item.kind !== "n-a"
                  ? onPickerResultMouseDown(item, index, pickerPaintedEpoch)
                  : undefined
              }
            >
              {pickerResultTexts[index]?.text ?? ""}
            </text>
          ))}
        </box>
      ) : settingsOpen === "setup" ? (
        <box flexDirection="column" height={rows} width={layout.interior}>
          {setup.lines.slice(0, rows).map((line, index) => (
            <text
              fg={index === 0 ? theme.colors.primary : undefined}
              height={1}
              key={`setup-${index}`}
              onMouseDown={
                line.field === "provider" && setup.ranges.provider.length > 0
                  ? onSettingsRowMouseDown("provider", setup.ranges.provider)
                  : line.field === "model" && setup.ranges.model.length > 0
                    ? onSettingsRowMouseDown("model", setup.ranges.model)
                    : line.field === "reasoning" && setup.ranges.reasoning.length > 0
                      ? onSettingsRowMouseDown("reasoning", setup.ranges.reasoning)
                      : undefined
              }
            >
              {truncateCells(line.text, layout.interior)}
            </text>
          ))}
        </box>
      ) : (view === "details" || view === "doctor") && !actionsOpen ? (
        <box flexDirection="column" height={rows} width={layout.interior}>
          <KeyValue
            keyWidth={detailKeyWidth}
            items={visibleDetails.map((item, visibleIndex) => {
              const index = detailStart + visibleIndex
              return {
                color:
                  index === detailIndex ? theme.colors.primary : undefined,
                key: `${index === detailIndex ? (unicode ? "›" : ">") : " "} ${item.key}`,
                value: metadataWindow(
                  item.value,
                  index === detailIndex ? detailOffset : 0,
                  detailValueWidth,
                  unicode,
                ),
              }
            })}
          />
        </box>
      ) : actionsOpen && actionsSheet ? (
        <box flexDirection="column" height={rows} width={layout.interior}>
          {actionsSheet.rows.slice(0, rows).map((row, index) => (
            <text
              fg={index === 0 ? theme.colors.primary : undefined}
              height={1}
              key={`actions-${index}`}
              onMouseDown={
                row.cells.length ? onActionsRowMouseDown(row.cells) : undefined
              }
            >
              {row.text}
            </text>
          ))}
        </box>
      ) : editorMode === "endpoint" ? (
        <box flexDirection="column" height={endpointRows} width={layout.interior}>
          <text height={1}>{`Local endpoint / ${endpointStateRef.current.source}`}</text>
          {endpointStateRef.current.readOnly ? (
            <text height={Math.max(1, endpointRows - 3)} width={layout.interior} wrapMode="word">
              {`${endpointStateRef.current.endpoint ?? "Invalid endpoint override"}\nRemove the override before editing in a later invocation.`}
            </text>
          ) : (
            <textarea
              key="endpoint-editor"
              ref={endpointRef}
              focused={!endpointConfirmation && !endpointApplyingRef.current}
              height={Math.max(1, endpointRows - 3)}
              width={layout.interior}
              wrapMode="word"
              onContentChange={() => {
                if (editorModeRef.current !== "endpoint" || endpointStateRef.current.readOnly) return
                endpointDraftRef.current = endpointRef.current?.plainText ?? endpointDraftRef.current
              }}
            />
          )}
          <text height={1} width={layout.interior}>
            {truncateCells(endpointConfirmation
              ? "Replace unreadable saved settings?"
              : endpointError || (endpointWarning && !endpointStateRef.current.readOnly
                ? "Unreadable selections cannot be preserved; repair replaces settings."
                : "Private configuration; no request is sent."), layout.interior)}
          </text>
          <box flexDirection="row" height={1} width={layout.interior}>
            {!endpointStateRef.current.readOnly && <text
              onMouseDown={(event: OpenTuiMouseEvent) => {
                if (event.button !== 0) return
                if (endpointConfirmationRef.current) applyEndpointEdit(endpointConfirmationRef.current, true)
                else saveEdit()
              }}
            >{endpointConfirmation ? "[Enter Confirm] " : "[^X W Save] "}</text>}
            {!endpointStateRef.current.readOnly && !endpointConfirmation && <text
              onMouseDown={(event: OpenTuiMouseEvent) => { if (event.button === 0) applyEndpointEdit("reset") }}
            >{"[^X R Reset] "}</text>}
            <text onMouseDown={(event: OpenTuiMouseEvent) => {
              if (event.button !== 0) return
              if (endpointConfirmationRef.current) setEndpointConfirm(null)
              else closeEndpointEditor()
            }}>{endpointConfirmation ? "[Esc Cancel]" : "[Esc Discard]"}</text>
          </box>
        </box>
      ) : isEditingMode(editorMode) ? (
        <textarea
          focused
          height={rows}
          key="editor"
          // A keystroke is one of the bottom rail's three triggers back to
          // cwd (item 2) — an in-progress edit's own hint (e.g. "editing
          // prompt") should not linger once the user starts typing over it.
          onContentChange={() => {
            if (editorModeRef.current === "endpoint") return
            if (editorSyncRef.current) {
              editorSyncRef.current = false
              return
            }
            setDetail("")
          }}
          ref={editorRef}
          width={layout.interior}
          wrapMode="word"
        />
      ) : hasCandidateList && phase !== "loading" && phase !== "streaming" ? (
        <box flexDirection="column" height={rows} width={layout.interior}>
          {assessmentRows > 0 && <text height={1} width={layout.interior} fg={theme.colors.mutedForeground}
            onMouseDown={(event: OpenTuiMouseEvent) => {
              if (event.button === 0) {
                event.stopPropagation()
                handleCtrlX("details")
                setDetailIndex(Math.max(0, details.findIndex(item => item.key === "confidence")))
              }
            }}>
            Risk: <span fg={assessmentEdited ? theme.colors.mutedForeground : assessmentColor(risk.level)}>{riskLabel}</span>
            {" · Confidence: "}<span fg={confidenceColor}>{confidenceLabel}</span>
          </text>}
          {candidateDescriptionRows > 0 && <scrollbox
            focused={false}
            height={candidateDescriptionRows}
            id="candidate-description"
            ref={candidateDescriptionRef}
            scrollX={false}
            scrollY
            width={layout.interior}
          >
            <text width={Math.max(4, layout.interior - 1)} wrapMode="word">
              {assessmentEdited ? "Edited; not reassessed\n" : ""}
              {riskReason && <><span fg={theme.colors.mutedForeground}>Impact:</span>{` ${riskReason}\n\n`}</>}
              {candidate?.tldr}
            </text>
          </scrollbox>}
          {choiceSeparatorRows > 0 && <text height={1} width={layout.interior} fg={theme.colors.mutedForeground}>
            {truncateCells(`${unicode ? "─" : "-"} Choices · selected ${candidateIndex + 1} of ${candidates.length} ${unicode ? "─" : "-"}`.padEnd(layout.interior, unicode ? "─" : "-"), layout.interior)}
          </text>}
          {candidateRows.map((row) => (
            <text
              fg={row.selected ? theme.colors.foreground : undefined}
              bg={row.selected ? theme.colors.muted : undefined}
              attributes={row.selected ? TextAttributes.BOLD : 0}
              height={1}
              width={layout.interior}
              key={row.key}
              onMouseDown={(event: OpenTuiMouseEvent) => {
                if (event.button !== 0) return
                if (busyRef.current) return
                selectCandidateIndex(row.candidateIndex)
              }}
            >
              {row.text + " ".repeat(Math.max(0, layout.interior - terminalWidth(row.text)))}
            </text>
          ))}
        </box>
      ) : (
        <box flexDirection="column" height={rows} width={layout.interior}>
          {leadRows > 0 ? (
            phase === "streaming" ? (
              <box
                flexDirection="column"
                height={leadRows}
                width={layout.interior}
              >
                <text height={1} width={layout.interior} bg={theme.colors.muted} attributes={TextAttributes.BOLD}>
                  {inFlightQuestion}
                </text>
                <text height={1} width={layout.interior} fg={theme.colors.mutedForeground}
                  onMouseDown={(event: OpenTuiMouseEvent) => {
                    if (event.button === 0 && thinkingControlVisible) { event.stopPropagation(); toggleThinking() }
                  }}>
                  {askPreview.thinking
                    ? (showThinking ? "Thinking · click to hide" : "Thinking hidden · click to show")
                    : intent === "ask" ? "Answer · streaming" : "Generating · preview only"}
                </text>
                {leadRows > 2 ? (
                  <box height={streamRows} width={layout.interior}
                    onMouseScroll={(event: OpenTuiMouseEvent) => {
                      if (event.scroll?.direction === "up" || event.scroll?.direction === "down") {
                        event.stopPropagation()
                        scrollStream(event.scroll.direction === "up" ? -1 : 1)
                      }
                    }}>
                    {streamMaxOffset > 0 ? <shellqScrollbar id="ask-stream-scrollbar" orientation="vertical" showArrows={false}
                      position="absolute" top={0} right={0} width={1} height={streamRows}
                      ref={bar => { if (bar) { bar.scrollSize = streamLines.length; bar.viewportSize = streamRows; bar.scrollPosition = visibleStreamOffset } }}
                      trackOptions={{backgroundColor:theme.colors.muted,foregroundColor:theme.colors.mutedForeground}}
                      onChange={position => setStreamOffset(Math.round(position) >= streamMaxOffsetRef.current ? null : Math.round(position))} /> : null}
                    {streamRowsModel.slice(visibleStreamOffset, visibleStreamOffset + streamRows).map((row, index) => (
                      <text key={index} height={1} width={readerWidth}
                        fg={row.kind === "thinking" ? theme.colors.mutedForeground : undefined}
                        attributes={row.kind === "thinking" ? TextAttributes.ITALIC : 0}>
                        {row.text}
                      </text>
                    ))}
                  </box>
                ) : null}
              </box>
            ) : phase === "loading" && intent === "ask" ? (
              <box
                flexDirection="column"
                height={leadRows}
                width={layout.interior}
              >
                <text height={1} width={layout.interior} bg={theme.colors.muted} attributes={TextAttributes.BOLD}>
                  {inFlightQuestion}
                </text>
                {leadRows > 1 ? (
                  <box height={leadRows - 1} width={layout.interior}>
                    <StatusMessage variant={status.variant}>
                      {truncateCells(
                        statusText,
                        Math.max(1, layout.interior - 2),
                      )}
                    </StatusMessage>
                  </box>
                ) : null}
              </box>
            ) : hasConversation ? (
              <box
                flexDirection="column"
                justifyContent="flex-end"
                height={leadRows}
                onMouseScroll={(event: OpenTuiMouseEvent) => {
                  if (
                    event.scroll?.direction !== "up" &&
                    event.scroll?.direction !== "down"
                  ) {
                    return
                  }
                  event.stopPropagation()
                  setConversationOffset((current) =>
                    steppedConversationOffset(
                      current ?? conversationMaxOffset,
                      conversationMaxOffset,
                      event.scroll?.direction === "up" ? -1 : 1,
                    ),
                  )
                }}
                width={layout.interior}
              >
                {conversationMaxOffset > 0 ? <shellqScrollbar id="ask-conversation-scrollbar" orientation="vertical" showArrows={false}
                  position="absolute" top={0} right={0} width={1} height={leadRows}
                  ref={bar => { if (bar) { bar.scrollSize = conversationLines.length; bar.viewportSize = leadRows; bar.scrollPosition = conversationDisplayOffset } }}
                  trackOptions={{backgroundColor:theme.colors.muted,foregroundColor:theme.colors.mutedForeground}}
                  onChange={position => setConversationOffset(Math.round(position) >= conversationMaxOffsetRef.current ? null : Math.round(position))} /> : null}
                {visibleConversationRows.map((row, index) => (
                  <text
                    height={1}
                    key={`conversation-${conversationDisplayOffset}-${index}`}
                    bg={row.kind === "question" ? theme.colors.muted : undefined}
                    fg={row.kind === "separator" ? theme.colors.mutedForeground : undefined}
                    attributes={row.kind === "question" ? TextAttributes.BOLD : 0}
                    width={readerWidth}
                  >
                    {row.text}
                  </text>
                ))}
              </box>
            ) : phase === "analysis" && diagnosis ? (
              <box height={leadRows} width={layout.interior}>
                <text width={layout.interior} wrapMode="word">
                  {diagnosis}
                </text>
              </box>
            ) : phase === "failed" ||
              phase === "cancelled" ? (
              <box height={leadRows} width={layout.interior}>
                <StatusMessage variant={status.variant}>
                  {truncateCells(statusText, Math.max(1, layout.interior - 2))}
                </StatusMessage>
              </box>
            ) : preview ? (
              <box flexDirection="column" height={leadRows} width={layout.interior}>
                {previewLines.map((line, index) => (
                  <text
                    fg={index === 0 ? theme.colors.primary : undefined}
                    height={1}
                    key={`preview-${index}`}
                    width={layout.interior}
                  >
                    {line}
                  </text>
                ))}
              </box>
            ) : (
              // An idle surface that is only promoted because an earlier state
              // grew the frame stays empty. The box still draws the side
              // borders on those rows, so the frame reads as one object
              // without an ornamental filler row restating the rail.
              <box height={leadRows} width={layout.interior} />
            )
          ) : null}
          <box height={composerRows} width={layout.interior} />
        </box>
      )}
    </box>
  )
}

export function mount(
  renderer: CliRenderer,
  session: WorkbenchSession,
  resultPath: string,
  trustedWorkdir: string,
  active: ActiveProcess,
  askSessionFile: string | null,
  initialAskChatSaved: boolean,
  initialNotice: string | null = null,
  askSessionFiles?: Record<CodexAskEngine, string> | null,
): void {
  createRoot(renderer).render(
    <ThemeProvider theme={defaultTheme}>
      <Workbench
        active={active}
        askSessionFile={askSessionFile}
        askSessionFiles={askSessionFiles}
        initialAskChatSaved={initialAskChatSaved}
        initialNotice={initialNotice}
        renderer={renderer}
        resultPath={resultPath}
        session={session}
        trustedWorkdir={trustedWorkdir}
      />
    </ThemeProvider>,
  )
}
