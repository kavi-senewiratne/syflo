/**
 * strings.ts
 *
 * Typisierte String-Map für die App language (CONTEXT.md, Grill 2026-07-24):
 * Deutsch + Englisch, bewusst OHNE i18n-Framework — bei zwei Locales wären
 * Pluralregeln und Lazy-Loading nur Ballast. `en` ist die Quelle der Typen;
 * `de: Strings` zwingt per Compiler dazu, dass jede neue UI-Zeile in beiden
 * Sprachen existiert. Strings mit Einsetzwerten sind Funktionen.
 *
 * Nicht hierüber laufen: die Sprach-Labels selbst ("English"/"Deutsch",
 * appLanguage.ts — immer in der eigenen Sprache), Modell-Namen, Thinking
 * quotes (Inhalt, kein Chrome) und Backend-Fehlertexte (V1-Scope-Cut).
 */

import { getAppLanguage, useAppLanguage, type AppLanguage } from './appLanguage';
import type { ChatGroupLabel } from './components/Sidebar/groupChatsByDate';

const en = {
  settings: {
    title: 'Settings',
    close: 'Close',
    loading: 'Loading settings…',
    tabs: {
      appearance: 'Appearance',
      model: 'Model',
      language: 'Language',
      instructions: 'Instructions',
    },
    activeModelDot: 'Active model configuration',
    appearance: {
      theme: 'Theme',
      note: 'Themes apply instantly — no activation needed.',
    },
    language: {
      appLanguage: 'App language',
      note: 'Applies instantly to the interface, automatic messages — like the prompt that creates the Video overview — and Explain answers.',
      howTitle: 'How language works',
      howNote: 'Chat replies mirror the language of your own message — ask in English, get English. The app language only sets what Syflo writes on its own.',
      dictation: 'Dictation',
      dictationBadge: 'Automatic · German + English',
      dictationNote: 'Detects the spoken language on its own — mixed sentences included. There is nothing to configure.',
    },
    instructions: {
      label: 'Custom instructions',
      switchAria: 'Apply custom instructions',
      switchOnTitle: 'Applied to every chat reply',
      switchOffTitle: 'Turned off — the text stays saved',
      placeholder: 'e.g. After every answer, correct the German in my message and list new vocabulary with articles.',
      note: 'Sent with every chat reply in all chat trees; your instructions take precedence over the built-in style rules. Explain, chat titles and summaries are not affected. The switch turns them off without deleting the text.',
    },
    model: {
      stepProvider: 'Provider',
      stepModel: 'Model',
      stepModels: 'Models',
      stepApiKey: 'API Key',
      // Card labels of the five providers (ADR-0008).
      providerLabels: {
        ollama: 'Ollama (local)',
        gemini: 'Gemini',
        groq: 'Groq',
        openai: 'OpenAI',
        anthropic: 'Claude',
      },
      // Data fate per provider (grill decision Q13, honesty required): one
      // line under the provider grid — including the uncomfortable Gemini
      // free-tier truth.
      dataNotes: {
        ollama: 'Chat data never leaves this device.',
        gemini: 'Requests go to Google under your own key. On the free quota, Google may use them to improve its products.',
        groq: 'Requests go to Groq under your own key.',
        openai: 'Requests go to OpenAI under your own key.',
        anthropic: 'Requests go to Anthropic under your own key.',
      },
      costFree: 'Free',
      costPaid: 'Pay per use',
      // Provider-card origin hint (Variante B: cost moved to step 2).
      originCloud: 'Cloud',
      originLocal: 'Local',
      activeBadge: 'Active',
      activeTitle: 'Currently in use',
      keySaved: 'saved',
      keyPlaceholderSet: '••••••••••',
      keyPlaceholderEmpty: 'sk-…',
      keyShow: 'Show API key',
      keyHide: 'Hide API key',
      keyRemove: 'Remove',
      keyNote: 'Your key stays in Syflo’s local database on this device. It is sent to no one except the provider itself — never to third parties, never into logs or the repository, and never back to this screen. To check a saved key, remove it and paste it again.',
      // Step-by-step guides per cloud provider (ADR-0008) — the link URL
      // comes from the registry (keyUrl), not from the strings.
      keyGuides: {
        gemini: {
          title: "Don't have an API key yet?",
          body: 'Create a key at Google AI Studio in about a minute — free quota included, no credit card needed.',
        },
        groq: {
          title: "Don't have an API key yet?",
          body: 'Create a key in the GroqCloud console in about a minute — free quota included, no credit card needed.',
        },
        openai: {
          title: "Don't have an API key yet?",
          body: "You'll need a free OpenAI account and a $5 starter balance. Creating the key takes about a minute.",
        },
        anthropic: {
          title: "Don't have an API key yet?",
          body: 'You need an Anthropic account with a small credit balance at console.anthropic.com. Creating the key takes about a minute.',
        },
      },
      // Badge for text-only models (e.g. Groq gpt-oss) in the dropdown.
      textOnlyBadge: 'no images',
      // Cost-tier model list (mockup-model-cost-tiers Variante B, 2026-07-30).
      tierFree: 'Free tier',
      tierPaid: 'Requires billing',
      tierFreeNote: (time: string) => `resets ${time}`,
      tierPaidNote: 'pay per use',
      // W10: the one-sentence mental model — the tier belongs to the KEY,
      // not to the model. Shown on demand (info icon), never as list text.
      tierTooltip:
        'Free means a small daily quota from your provider, without a credit card. ' +
        'If you set up billing later, the same model keeps working — billed per use. ' +
        'Your API key stays the same.',
      billingNeeded: 'Billing required',
      perDay: (n: number) => `${n} / day`,
      priceMTok: (usd: number) => `$${usd} / MTok`,
      // Usage block at the bottom of the model tab (costs always an estimate).
      usageTitle: 'Usage this month',
      usageEstimate: (usd: string) => `~$${usd} estimated`,
      usageRequestsToday: (n: number, max?: number) =>
        max ? `${n} / ${max} requests today` : `${n} requests today`,
      usagePricesAsOf: (date: string) => `Prices as of ${date}`,
      guideCta: 'Get your API key',
      guideWhat: 'What $5 gets you',
      guideMiniMessages: '~10,000 messages',
      guide4oMessages: '~500 messages',
      guidePricing: 'Full pricing',
      refreshList: 'Refresh model list',
      rowInstalled: 'Installed',
      rowCanThink: ' · can think',
      ollamaUnreachable: "Ollama isn't reachable at localhost:11434 — start it to manage your local models.",
      // Frozen fallback (ADR-0008 amendment): downloads happen in the
      // terminal, the app only lists the installed vision models.
      pullHint: 'Install models with `ollama pull <name>` in the terminal.',
      // No data-fate sentence here — that lives in dataNotes.ollama.
      libraryNote: 'The active model is switched from the chat composer.',
      installOllama: 'Install Ollama',
    },
    footer: {
      activated: 'Activated',
      needsKey: (label: string) => `Add an API key to activate ${label}`,
      clickActivate: 'Click Activate to apply your selection',
      selectionActive: 'Current selection is active',
      saved: 'Saved',
      clickSave: 'Click Save to apply your changes',
      instructionsOn: 'Applied to every chat reply',
      instructionsOff: 'Instructions are off',
      save: 'Save',
      saving: 'Saving…',
      activate: 'Activate',
      activating: 'Activating…',
      saveTitleDirty: 'Save and apply these instructions',
      saveTitleClean: 'No changes to save',
      activateTitleNeedsKey: (label: string) => `Enter a ${label} API key first`,
      activateTitleClean: 'No changes to activate',
      activateTitleDirty: 'Apply and activate this configuration',
    },
    sectionsAria: 'Settings sections',
    errors: {
      saveFailed: 'Failed to save settings',
      saveInstructionsFailed: 'Failed to save instructions',
      removeKeyFailed: 'Failed to remove API key',
    },
  },
  chatArea: {
    emptyTitle: 'How can I help you today?',
    emptySubtitle: 'Select a chat from the sidebar or start a new one.',
    toggleHighlightsTitle: 'Show all highlights of this tree',
    highlightsButton: 'Highlights',
    branchedFrom: 'Branched from ',
    emptyChatTitle: 'Start the conversation',
    emptyChatHint: 'Right-click any word in a response to get a definition or branch a new chat.',
    scrollToLatest: 'Scroll to latest',
    dropFiles: 'Drop files to attach',
    attachmentsHeading: 'Attachments',
    feedbackCommandDesc: 'Send a bug report or idea to the Syflo team',
    quoteFrom: (label: string) => `from "${label}"`,
    removeQuote: 'Remove quote',
    attach: 'Attach',
    menuMedia: 'Media',
    menuPdf: 'PDF',
    menuResearchPaper: 'Research paper',
    menuYouTubeTranscript: 'YouTube Transcript',
    placeholderAsk: 'Ask anything',
    placeholderAskQuote: 'Ask about this…',
    transcribing: 'Transcribing…',
    startRecording: 'Start recording',
    stopRecording: 'Stop recording',
    stopResponse: 'Stop response',
    send: 'Send',
    // Guided empty state (ADR-0008, grill 12b): active cloud provider
    // without a key — the notice card replaces the composer row.
    cloudSetup: {
      // W9 (cost tiers 2026-07-30): a path chooser, not a provider pitch —
      // a fresh install has every provider. No cost badges: the row titles
      // carry the tier.
      title: 'Get set up in about a minute',
      body: 'Answers come from an AI model of your choice — under your own API key or fully local.',
      pathFree: 'Start for free',
      pathFreeSub: 'Gemini Flash or Groq',
      pathPaid: 'Use your own account',
      pathPaidSub: 'OpenAI, Claude, Gemini Pro',
      pathLocal: 'Fully private',
      pathLocalSub: 'local model, no account',
    },
    recordingVolumeAria: 'Recording volume',
    // Visible auto-retry after a 429 (ADR-0008).
    rateLimited: (seconds: number) => `Rate limit reached — retrying in ${seconds}s`,
    // Countdown hit 0 but the retry round-trip is still in flight.
    retrying: 'Retrying…',
    // Precise wait row above the bubble (mockup-quota-states §10, variant
    // C): names WHICH minute limit bit and on which model. The generic
    // rateLimited/retrying strings stay as fallback for old events.
    rateLimitScopeRequests: 'requests',
    rateLimitScopeTokens: 'tokens',
    rateLimitedScoped: (scope: string, model: string, seconds: number) =>
      `Per-minute limit (${scope}) on ${model} — resuming in ${seconds} s`,
    retryingOn: (model: string) => `Retrying on ${model}…`,
    // Another provider stepped in for this answer (limit on the active one).
    failover: (fromLabel: string, toLabel: string, modelLabel: string) =>
      `Quota reached on ${fromLabel} — this answer comes from ${toLabel} (${modelLabel}).`,
    // Sibling model of the SAME provider stepped in (the common case —
    // limits are per model).
    failoverSameProvider: (fromModelLabel: string, toModelLabel: string) =>
      `Quota reached on ${fromModelLabel} — this answer comes from ${toModelLabel}.`,
    // Reason-true failover notes (mockup-model-flow §11): the SSE event
    // carries WHY the ladder moved on — no_vision and model_unavailable get
    // their own copy instead of falsely claiming "Quota reached". Same
    // naming rules as the quota pair: same provider → model labels,
    // cross-provider → provider labels + model.
    failoverNoVision: (fromLabel: string, toLabel: string, modelLabel: string) =>
      `${fromLabel} can't read images — this answer comes from ${toLabel} (${modelLabel}).`,
    failoverNoVisionSameProvider: (fromModelLabel: string, toModelLabel: string) =>
      `${fromModelLabel} can't read images — this answer comes from ${toModelLabel}.`,
    failoverUnavailable: (fromLabel: string, toLabel: string, modelLabel: string) =>
      `${fromLabel} is no longer available — this answer comes from ${toLabel} (${modelLabel}).`,
    failoverUnavailableSameProvider: (fromModelLabel: string, toModelLabel: string) =>
      `${fromModelLabel} is no longer available — this answer comes from ${toModelLabel}.`,
    // The failover exhausted ALL candidate models — the error row explains
    // why and (with an installed local model) offers the emergency path.
    quotaExhausted: 'All cloud quotas are used up for now.',
    retryLocal: 'Answer with the local model',
    retryLocalNote: 'The local model can be much slower.',
    // Long cooldown (daily limit): no retry button at all — this clock line
    // answers "when does the cloud come back?" instead. "expected"/"around"
    // stay in the copy: UTC midnight is an estimate and the cooldown memory
    // does not survive a backend restart (mockup-quota-states §04).
    quotaRetryAtTime: (time: string) => `Expected to be available again around ${time}.`,
    // Short cooldown: the retry button stays visible but disabled, counting
    // down inside itself until a click can actually work (§05, variant B).
    retryCountdown: (seconds: number) => `Try again (${seconds} s)`,
    // Precise copy per quotaReason (mockup-quota-states v3, 2026-07-26) —
    // the generic quotaExhausted line stays as the fallback for errors
    // without a reason (e.g. after a backend restart).
    quotaDaily: 'The daily quota of the cloud models is used up.',
    quotaMinute: 'The cloud models are at their per-minute limits right now.',
    quotaMinuteNote: 'Several questions in quick succession — web searches count as extra requests, too.',
    quotaTooLarge: 'The question plus its context is too large for the cloud limits.',
    // W4 (cost tiers 2026-07-30): a zero-limit 429 is a billing gate, not a
    // quota that resets — the card never promises a comeback time.
    quotaBilling: (model: string) => `${model} has no quota without billing.`,
    quotaBillingNote: 'Other free models and the local model are in the model menu as well.',
    retryWithModel: (model: string) => `Answer with ${model}`,
    setUpBilling: 'Set up billing',
    setUpBillingTip: 'Paid plan at your provider — your API key in Syflo stays the same.',
    raiseLimit: 'Raise limit',
    raiseLimitTip: 'A paid plan with your provider lifts the limits considerably — your API key in Syflo stays the same.',
    switchModelAction: 'Switch model',
    switchModelTip: 'A model with a bigger token budget often handles the question — the badges in the menu show which one is free. Picking one retries this answer right away.',
    // Honest cards per failReason (mockup-model-flow §05/§11) — one message
    // line, a button row, at most one footnote; explanations live in tooltips.
    failNoKey: (providerLabel: string) => `No API key is stored for ${providerLabel}.`,
    failBadKey: (providerLabel: string) => `The ${providerLabel} API key was rejected.`,
    addApiKey: 'Add API key',
    checkApiKey: 'Check API key',
    addApiKeyTip: 'Opens Settings · Models. After saving, "Try again" answers the question.',
    failNoVision: (modelLabel: string) => `${modelLabel} cannot read images.`,
    localVisionTip: (localModel: string) => `${localModel} understands images.`,
    switchModelVisionTip: 'Models without image understanding are labeled "no images" in the menu. Picking one retries this answer right away.',
    removeImageFootnote: 'Or remove the image from the question and send it again.',
    failNetwork: 'No connection to the Syflo backend.',
    networkFootnote: 'Is Syflo still running? If in doubt, restart the app.',
    failLocalMissing: (modelName: string) => `The local model ${modelName} is not installed.`,
    checkInSettings: 'Check in Settings',
    retryCloud: (modelLabel: string) => `Answer with ${modelLabel}`,
    retryCloudTip: (providerLabel: string) =>
      `Leaves private mode for this one answer — the question and paper context go to ${providerLabel}.`,
    installPrefix: 'Install: ',
    installSuffix: ' in the terminal.',
    failLocalUnreachable: 'Ollama is not reachable.',
    // Unanswered trailing question (§10): quiet meta row after silent losses.
    unanswered: 'Left without an answer.',
    resend: 'Send again',
  },
  messageBubble: {
    thinking: 'Thinking…',
    thoughtFor: (duration: string) => `Thought for ${duration}`,
    thoughts: 'Thoughts',
    interrupted: 'Interrupted',
    failed: 'The answer could not be generated.',
    retry: 'Try again',
    queuedNext: 'Waiting — up next',
    queued: (ahead: number) =>
      ahead === 1 ? 'Waiting — 1 request ahead' : `Waiting — ${ahead} requests ahead`,
    // Tooltip of the ahead-link (§07): previews the question the queue is
    // answering RIGHT NOW; clicking jumps to that chat.
    nowAnswering: (question: string) => `Now answering: “${question}…”`,
    sources: 'Sources',
    assistantThinking: 'Assistant is thinking',
    tipLabel: 'Tip: ',
  },
  attachmentChip: {
    renameAlias: 'Rename alias',
    remove: 'Remove',
    clickToRename: (alias: string) => `${alias} — click to rename`,
  },
  questionNav: {
    buttonLabel: (n: number) => `${n} questions`,
    buttonTitle: 'All questions in this chat',
    popoverHeading: 'Questions in this chat',
    previous: 'Previous question (Alt+↑)',
    next: 'Next question (Alt+↓)',
  },
  sidebar: {
    expand: 'Expand sidebar',
    collapse: 'Collapse sidebar',
    newChat: 'New Chat',
    settings: 'Settings',
    openSettings: 'Open settings',
    feedback: 'Feedback',
    openFeedback: 'Send feedback',
    switchToMindMap: 'Switch to Mind Map',
    switchToChat: 'Switch to Chat',
    rename: 'Rename',
    delete: 'Delete',
    deleteChatTitle: 'Delete chat?',
    deleteChatBody: (title: string) => `"${title}" and all its branched chats will be permanently removed.`,
    deleteFailed: 'Could not delete the chat. Is the backend running?',
    cancel: 'Cancel',
    deleting: 'Deleting…',
    retry: 'Retry',
    noChats: 'No chats yet',
    allChats: 'All chats',
    responseInProgress: 'Response in progress',
    queuedInQueue: 'Question waiting in queue',
    // Anzeige-Texte der Datums-Gruppen — groupChatsByDate.ts liefert die
    // Labels als stabile Schlüssel, übersetzt wird erst beim Rendern.
    groups: {
      'Today': 'Today',
      'Yesterday': 'Yesterday',
      'This week': 'This week',
      'Last week': 'Last week',
      'This month': 'This month',
      'Older': 'Older',
    } satisfies Record<ChatGroupLabel, string>,
  },
  feedback: {
    title: 'Send feedback',
    kindBug: 'Bug',
    kindIdea: 'Idea',
    kindQuestion: 'Question',
    placeholder: 'What happened, or what would help?',
    attachmentHint: "Images and videos aren't supported yet — please describe the problem in detail.",
    emailLabel: 'Your email (optional — only if you want a reply)',
    emailPlaceholder: 'you@example.com',
    cancel: 'Cancel',
    send: 'Send',
    sending: 'Sending…',
    sent: 'Feedback sent — thank you!',
    error: 'Could not send feedback. Please try again.',
    close: 'Close',
  },
  videoBanner: {
    transcriptAttached: ' · transcript attached',
    viewTranscript: 'View transcript',
    openOnYouTube: 'Open on YouTube',
  },
  transcriptDrawer: {
    title: 'Transcript',
    close: 'Close transcript',
    sourceNote: 'This is the source text the model reads.',
    languageNote: (lang: string) => ` Language: ${lang}.`,
  },
  paperSearch: {
    title: 'Add a research paper',
    close: 'Close',
    subtitle: 'The imported PDF is attached to this chat.',
    placeholder: 'Search by title, author or topic…',
    search: 'Search',
    rateLimited: 'Search services are rate-limiting us. Wait a moment, then try again.',
    searching: 'Searching arXiv and OpenAlex…',
    noResults: 'No results.',
    cites: (count: string) => ` · ${count} cites`,
    openAccess: 'Open access',
    manualDownload: 'Manual download',
    paywalled: 'Paywalled',
    importButton: 'Import',
    importing: 'Importing…',
    openSourcePage: 'Open source page',
    manualHint: 'host blocks direct download — upload the PDF after saving it',
    viewPublisher: 'View publisher',
    noPdf: 'no PDF',
    searchFailed: 'Search failed',
    importFailed: 'Import failed',
  },
  youtubeSearch: {
    title: 'Add a YouTube transcript',
    close: 'Close',
    subtitle: "The transcript becomes this tree's source; the video itself is never downloaded.",
    placeholder: 'Search YouTube…',
    search: 'Search',
    searching: 'Searching YouTube…',
    noResults: 'No results.',
    add: 'Add',
    fetching: 'Fetching…',
    searchFailed: 'Search failed',
    importFailed: 'Import failed',
  },
  highlightsDrawer: {
    title: 'Highlights',
    close: 'Close highlights',
    all: 'All',
    empty: 'No highlights yet — select text and right-click to highlight.',
    pdfSource: (page: number) => `PDF · p. ${page}`,
    chatSource: (title: string) => `Chat · ${title}`,
    // Locale der Datumsformatierung — folgt der App language.
    dateLocale: 'en-US',
  },
  modelPicker: {
    switchModel: (name: string) => `Switch model (${name})`,
    installedWithSize: (size: string) => `${size} · installed`,
    installed: 'Installed',
    thinking: 'Thinking',
    on: 'On',
    off: 'Off',
    manageModels: 'Manage models',
    ollamaRunning: 'Ollama · running locally',
    ollamaNotReachable: 'Ollama not reachable',
    // Footer status for cloud providers (ADR-0008).
    cloudStatus: (label: string) => `${label} · Cloud`,
    // Quota-cooldown badges (mockup-quota-states §06): the model stays
    // selectable (the backend skips it and fails over), the badge says when
    // it is expected back — clock time for daily limits, seconds otherwise.
    coolingUntilTime: (time: string) => `back ~${time}`,
    coolingInSeconds: (seconds: number) => `back in ${seconds} s`,
    // Grouped picker (mockup-model-flow §02–§04).
    localGroup: 'Local · Ollama',
    noImages: "can't read images",
    noLongerAvailable: 'no longer available',
    ollamaRunningShort: 'Ollama running',
    ollamaNoVisionModel: 'Ollama running — no vision-capable model installed',
    cloudProvidersCount: (n: number) =>
      n === 1 ? '1 cloud provider set up' : `${n} cloud providers set up`,
    startOllamaHint: 'Start Ollama to answer locally',
    installVisionModelHint: 'Install a vision-capable model',
    pillCoolingTip: (model: string, when: string) =>
      `${model} is at its limit (${when}). Answers fail over to free models automatically.`,
    // Cost-tier groups (mockup-model-cost-tiers W2b, chosen 2026-07-30).
    freeGroup: 'Free',
    paidGroup: 'Requires billing',
    billingNeeded: 'Billing required',
  },
  floatingPopup: {
    definition: 'Definition',
    wordCount: (n: number) => `· ${n} words`,
    collapse: 'Collapse',
    copyText: 'Copy text',
    copiedTitle: 'Copied!',
    copiedAria: 'Copied',
    close: 'Close',
    loadingDefinition: 'Loading definition…',
    renameColors: 'Rename colors',
    highlightColor: 'Highlight color',
    cancel: 'Cancel',
    renameLabels: 'Rename labels',
    resetToDefault: 'Reset to default',
    labelFor: (color: string) => `Label for ${color}`,
    highlightAs: (label: string) => `Highlight as ${label}`,
    saveLabels: 'Save labels',
    askInChat: 'Ask in chat',
    openAsNewChat: 'Open as new chat',
  },
  // Aktions-Menü eines bestehenden Highlights (PDF & Chat-Text) — war bis
  // 2026-07-25 hartkodiert englisch (Bug-Report). "Highlight" bleibt als
  // Fachwort auch im Deutschen stehen (CONTEXT.md-Glossar).
  highlightMenu: {
    changeColor: 'Change color',
    openLinkedChat: 'Open linked chat',
    deleteHighlight: 'Delete highlight',
  },
  pdfView: {
    zoomOut: 'Zoom out',
    zoomIn: 'Zoom in',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    loadError: (msg: string) => `Could not load PDF: ${msg}`,
  },
  parentContext: {
    badge: 'parent chat',
    openChat: 'Open this chat',
  },
  mindMap: {
    mainTopic: 'Main Topic',
    noChats: 'No chats yet',
  },
  app: {
    newChatTitle: 'New Chat',
    // No "About:" prefix (user decision 2026-07-26): the sidebar tree reads
    // better when the selection itself is the provisional title; the
    // auto-title replaces it with a summary after the first answer anyway.
    aboutChatTitle: (word: string) => word,
    newTreeTitle: 'This chat tree already has a source',
    newTreeLead: 'Each chat tree holds one source — a PDF or a YouTube transcript.',
    newTreeAskPrefix: 'Start a new tree with ',
    newTreeAskSuffix: '?',
    cancel: 'Cancel',
    startNewTree: 'Start new tree',
    noDefinition: '(No definition returned)',
    unknownError: 'Unknown error',
    couldNotLoadDefinition: (msg: string) => `Could not load definition: ${msg}`,
    couldNotCreateChat: (msg: string) => `Could not create chat: ${msg} — is the backend running?`,
    chatFallbackLabel: 'chat',
    resizeMindMap: 'Resize mind map',
    resizeChatColumn: 'Resize chat column',
  },
};

export type Strings = typeof en;

const de: Strings = {
  settings: {
    title: 'Einstellungen',
    close: 'Schließen',
    loading: 'Einstellungen werden geladen…',
    tabs: {
      appearance: 'Erscheinungsbild',
      model: 'Modell',
      language: 'Sprache',
      instructions: 'Anweisungen',
    },
    activeModelDot: 'Aktive Modell-Konfiguration',
    appearance: {
      theme: 'Farbschema',
      note: 'Farbschemata wirken sofort — keine Aktivierung nötig.',
    },
    language: {
      appLanguage: 'App-Sprache',
      note: 'Wirkt sofort auf die Oberfläche, automatische Nachrichten — etwa den Prompt, der die Video overview erzeugt — und Explain-Antworten.',
      howTitle: 'So funktioniert die Sprache',
      howNote: 'Chat-Antworten spiegeln die Sprache deiner eigenen Nachricht — wer auf Englisch fragt, bekommt Englisch. Die App-Sprache bestimmt nur, was Syflo von sich aus schreibt.',
      dictation: 'Diktat',
      dictationBadge: 'Automatisch · Deutsch + Englisch',
      dictationNote: 'Erkennt die gesprochene Sprache selbst — auch gemischte Sätze. Hier gibt es nichts einzustellen.',
    },
    instructions: {
      label: 'Eigene Anweisungen',
      switchAria: 'Eigene Anweisungen anwenden',
      switchOnTitle: 'Gilt für jede Chat-Antwort',
      switchOffTitle: 'Ausgeschaltet — der Text bleibt gespeichert',
      placeholder: 'z. B. Korrigiere nach jeder Antwort das Deutsch in meiner Nachricht und liste neue Vokabeln mit Artikel auf.',
      note: 'Wird mit jeder Chat-Antwort in allen Chat-Bäumen gesendet; deine Anweisungen haben Vorrang vor den eingebauten Stilregeln. Explain, Chat-Titel und Zusammenfassungen sind nicht betroffen. Der Schalter deaktiviert sie, ohne den Text zu löschen.',
    },
    model: {
      stepProvider: 'Provider',
      stepModel: 'Modell',
      stepModels: 'Modelle',
      stepApiKey: 'API-Schlüssel',
      providerLabels: {
        ollama: 'Ollama (lokal)',
        gemini: 'Gemini',
        groq: 'Groq',
        openai: 'OpenAI',
        anthropic: 'Claude',
      },
      dataNotes: {
        ollama: 'Chat-Daten bleiben auf diesem Gerät.',
        gemini: 'Anfragen gehen unter deinem eigenen Key an Google. Im kostenlosen Kontingent darf Google sie zur Produktverbesserung nutzen.',
        groq: 'Anfragen gehen unter deinem eigenen Key an Groq.',
        openai: 'Anfragen gehen unter deinem eigenen Key an OpenAI.',
        anthropic: 'Anfragen gehen unter deinem eigenen Key an Anthropic.',
      },
      costFree: 'Kostenlos',
      costPaid: 'Nutzungsbasiert',
      originCloud: 'Cloud',
      originLocal: 'Lokal',
      activeBadge: 'Aktiv',
      activeTitle: 'Wird gerade verwendet',
      keySaved: 'gespeichert',
      keyPlaceholderSet: '••••••••••',
      keyPlaceholderEmpty: 'sk-…',
      keyShow: 'API-Schlüssel anzeigen',
      keyHide: 'API-Schlüssel verbergen',
      keyRemove: 'Entfernen',
      keyNote: 'Dein Schlüssel bleibt in Syflos lokaler Datenbank auf diesem Gerät. Er wird an niemanden außer den Anbieter selbst gesendet — nie an Dritte, nie in Logs oder ins Repository, und nie zurück an diese Ansicht. Zum Prüfen eines gespeicherten Schlüssels: entfernen und neu einfügen.',
      keyGuides: {
        gemini: {
          title: 'Noch keinen API-Schlüssel?',
          body: 'Erstelle in etwa einer Minute einen Key im Google AI Studio — kostenloses Kontingent inklusive, keine Kreditkarte nötig.',
        },
        groq: {
          title: 'Noch keinen API-Schlüssel?',
          body: 'Erstelle in etwa einer Minute einen Key in der GroqCloud-Konsole — kostenloses Kontingent inklusive, keine Kreditkarte nötig.',
        },
        openai: {
          title: 'Noch keinen API-Schlüssel?',
          body: 'Du brauchst ein kostenloses OpenAI-Konto und 5 $ Startguthaben. Den Schlüssel zu erstellen dauert etwa eine Minute.',
        },
        anthropic: {
          title: 'Noch keinen API-Schlüssel?',
          body: 'Du brauchst ein Anthropic-Konto mit einem kleinen Guthaben auf console.anthropic.com. Den Schlüssel zu erstellen dauert etwa eine Minute.',
        },
      },
      textOnlyBadge: 'liest keine Bilder',
      tierFree: 'Kostenlos',
      tierPaid: 'Kostenpflichtig',
      tierFreeNote: (time: string) => `Reset ${time}`,
      tierPaidNote: 'nutzungsbasiert',
      tierTooltip:
        'Kostenlos heißt: ein kleines Tageskontingent deines Anbieters, ohne Kreditkarte. ' +
        'Richtest du später eine Abrechnung ein, läuft dasselbe Modell einfach weiter — dann pro Nutzung bezahlt. ' +
        'Dein API-Key bleibt derselbe.',
      billingNeeded: 'Abrechnung nötig',
      perDay: (n: number) => `${n} / Tag`,
      priceMTok: (usd: number) => `$${usd} / MTok`,
      usageTitle: 'Nutzung diesen Monat',
      usageEstimate: (usd: string) => `~${usd} $ geschätzt`,
      usageRequestsToday: (n: number, max?: number) =>
        max ? `${n} / ${max} Anfragen heute` : `${n} Anfragen heute`,
      usagePricesAsOf: (date: string) => `Preise vom ${date}`,
      guideCta: 'API-Schlüssel holen',
      guideWhat: 'Was du für 5 $ bekommst',
      guideMiniMessages: '~10.000 Nachrichten',
      guide4oMessages: '~500 Nachrichten',
      guidePricing: 'Alle Preise',
      refreshList: 'Modell-Liste aktualisieren',
      rowInstalled: 'Installiert',
      rowCanThink: ' · kann denken',
      ollamaUnreachable: 'Ollama ist unter localhost:11434 nicht erreichbar — starte es, um deine lokalen Modelle zu verwalten.',
      pullHint: 'Installiere Modelle mit `ollama pull <name>` im Terminal.',
      libraryNote: 'Das aktive Modell wird im Chat-Eingabefeld gewechselt.',
      installOllama: 'Ollama installieren',
    },
    footer: {
      activated: 'Aktiviert',
      needsKey: (label: string) => `Füge einen API-Schlüssel hinzu, um ${label} zu aktivieren`,
      clickActivate: 'Klicke auf Aktivieren, um deine Auswahl zu übernehmen',
      selectionActive: 'Aktuelle Auswahl ist aktiv',
      saved: 'Gespeichert',
      clickSave: 'Klicke auf Speichern, um deine Änderungen zu übernehmen',
      instructionsOn: 'Gilt für jede Chat-Antwort',
      instructionsOff: 'Anweisungen sind aus',
      save: 'Speichern',
      saving: 'Wird gespeichert…',
      activate: 'Aktivieren',
      activating: 'Wird aktiviert…',
      saveTitleDirty: 'Anweisungen speichern und anwenden',
      saveTitleClean: 'Keine Änderungen zu speichern',
      activateTitleNeedsKey: (label: string) => `Zuerst einen ${label}-API-Schlüssel eingeben`,
      activateTitleClean: 'Keine Änderungen zu aktivieren',
      activateTitleDirty: 'Konfiguration übernehmen und aktivieren',
    },
    sectionsAria: 'Einstellungsbereiche',
    errors: {
      saveFailed: 'Einstellungen konnten nicht gespeichert werden',
      saveInstructionsFailed: 'Anweisungen konnten nicht gespeichert werden',
      removeKeyFailed: 'API-Schlüssel konnte nicht entfernt werden',
    },
  },
  chatArea: {
    emptyTitle: 'Wie kann ich dir heute helfen?',
    emptySubtitle: 'Wähle einen Chat in der Seitenleiste oder starte einen neuen.',
    toggleHighlightsTitle: 'Alle Highlights dieses Baums anzeigen',
    highlightsButton: 'Highlights',
    branchedFrom: 'Branch aus ',
    emptyChatTitle: 'Beginne das Gespräch',
    emptyChatHint: 'Rechtsklicke ein beliebiges Wort in einer Antwort für eine Definition — oder öffne einen neuen Branch.',
    scrollToLatest: 'Zur neuesten Nachricht springen',
    dropFiles: 'Dateien hier ablegen',
    attachmentsHeading: 'Anhänge',
    feedbackCommandDesc: 'Feedback oder eine Idee an das Syflo-Team senden',
    quoteFrom: (label: string) => `aus „${label}"`,
    removeQuote: 'Zitat entfernen',
    attach: 'Anhängen',
    menuMedia: 'Medien',
    menuPdf: 'PDF',
    menuResearchPaper: 'Research paper',
    menuYouTubeTranscript: 'YouTube Transcript',
    placeholderAsk: 'Frag irgendetwas',
    placeholderAskQuote: 'Frag etwas dazu…',
    transcribing: 'Transkribiert…',
    startRecording: 'Aufnahme starten',
    stopRecording: 'Aufnahme stoppen',
    stopResponse: 'Antwort stoppen',
    send: 'Senden',
    cloudSetup: {
      title: 'In etwa einer Minute startklar',
      body: 'Antworten kommen von einem KI-Modell deiner Wahl — über deinen eigenen API-Key oder komplett lokal.',
      pathFree: 'Kostenlos starten',
      pathFreeSub: 'Gemini Flash oder Groq',
      pathPaid: 'Eigenes Konto nutzen',
      pathPaidSub: 'OpenAI, Claude, Gemini Pro',
      pathLocal: 'Komplett privat',
      pathLocalSub: 'lokales Modell, ohne Konto',
    },
    recordingVolumeAria: 'Aufnahme-Lautstärke',
    rateLimited: (seconds: number) => `Rate-Limit erreicht — neuer Versuch in ${seconds} s`,
    retrying: 'Versuche erneut…',
    rateLimitScopeRequests: 'Anfragen',
    rateLimitScopeTokens: 'Tokens',
    rateLimitedScoped: (scope: string, model: string, seconds: number) =>
      `Minuten-Limit (${scope}) bei ${model} — weiter in ${seconds} s`,
    retryingOn: (model: string) => `Neuer Versuch bei ${model} läuft…`,
    failover: (fromLabel: string, toLabel: string, modelLabel: string) =>
      `Kontingent bei ${fromLabel} erschöpft — diese Antwort kommt von ${toLabel} (${modelLabel}).`,
    failoverSameProvider: (fromModelLabel: string, toModelLabel: string) =>
      `Kontingent bei ${fromModelLabel} erschöpft — diese Antwort kommt von ${toModelLabel}.`,
    failoverNoVision: (fromLabel: string, toLabel: string, modelLabel: string) =>
      `${fromLabel} kann keine Bilder lesen — diese Antwort kommt von ${toLabel} (${modelLabel}).`,
    failoverNoVisionSameProvider: (fromModelLabel: string, toModelLabel: string) =>
      `${fromModelLabel} kann keine Bilder lesen — diese Antwort kommt von ${toModelLabel}.`,
    failoverUnavailable: (fromLabel: string, toLabel: string, modelLabel: string) =>
      `${fromLabel} ist nicht mehr verfügbar — diese Antwort kommt von ${toLabel} (${modelLabel}).`,
    failoverUnavailableSameProvider: (fromModelLabel: string, toModelLabel: string) =>
      `${fromModelLabel} ist nicht mehr verfügbar — diese Antwort kommt von ${toModelLabel}.`,
    quotaExhausted: 'Alle Cloud-Kontingente sind vorerst aufgebraucht.',
    retryLocal: 'Mit lokalem Modell antworten',
    retryLocalNote: 'Das lokale Modell kann deutlich langsamer sein.',
    quotaRetryAtTime: (time: string) => `Voraussichtlich wieder verfügbar ab ca. ${time} Uhr.`,
    retryCountdown: (seconds: number) => `Erneut versuchen (${seconds} s)`,
    quotaDaily: 'Das Tageskontingent der Cloud-Modelle ist aufgebraucht.',
    quotaMinute: 'Die Cloud-Modelle sind gerade an ihren Minuten-Limits.',
    quotaMinuteNote: 'Mehrere Fragen kurz nacheinander — auch Websuchen zählen als eigene Anfragen.',
    quotaTooLarge: 'Die Frage ist mit ihrem Kontext zu groß für die Cloud-Limits.',
    quotaBilling: (model: string) => `${model} hat ohne Abrechnung kein Kontingent.`,
    quotaBillingNote: 'Weitere freie Modelle und das lokale Modell stehen ebenfalls im Modell-Menü.',
    retryWithModel: (model: string) => `Mit ${model} antworten`,
    setUpBilling: 'Abrechnung einrichten',
    setUpBillingTip: 'Bezahlter Plan bei deinem Anbieter — dein API-Key in Syflo bleibt derselbe.',
    raiseLimit: 'Limit erhöhen',
    raiseLimitTip: 'Ein bezahlter Plan bei deinem Anbieter hebt die Limits deutlich an — dein API-Key in Syflo bleibt derselbe.',
    switchModelAction: 'Modell wechseln',
    switchModelTip: 'Ein Modell mit größerem Token-Budget schafft die Frage oft — die Badges im Menü zeigen, welches frei ist. Nach der Wahl wird diese Antwort sofort neu versucht.',
    failNoKey: (providerLabel: string) => `Für ${providerLabel} ist kein API-Key hinterlegt.`,
    failBadKey: (providerLabel: string) => `Der ${providerLabel}-API-Key wurde abgelehnt.`,
    addApiKey: 'API-Key hinterlegen',
    checkApiKey: 'API-Key prüfen',
    addApiKeyTip: 'Öffnet Einstellungen · Modelle. Nach dem Speichern beantwortet „Erneut versuchen" die Frage.',
    failNoVision: (modelLabel: string) => `${modelLabel} kann keine Bilder lesen.`,
    localVisionTip: (localModel: string) => `${localModel} versteht Bilder.`,
    switchModelVisionTip: 'Im Menü steht bei Modellen ohne Bildverständnis „liest keine Bilder". Nach der Wahl wird diese Antwort sofort neu versucht.',
    removeImageFootnote: 'Oder entferne das Bild aus der Frage und sende sie erneut.',
    failNetwork: 'Keine Verbindung zum Syflo-Backend.',
    networkFootnote: 'Läuft Syflo noch? Im Zweifel die App neu starten.',
    failLocalMissing: (modelName: string) => `Das lokale Modell ${modelName} ist nicht installiert.`,
    checkInSettings: 'In den Einstellungen prüfen',
    retryCloud: (modelLabel: string) => `Mit ${modelLabel} antworten`,
    retryCloudTip: (providerLabel: string) =>
      `Verlässt den privaten Modus für diese eine Antwort — Frage und Paper-Kontext gehen an ${providerLabel}.`,
    installPrefix: 'Installieren: ',
    installSuffix: ' im Terminal.',
    failLocalUnreachable: 'Ollama ist nicht erreichbar.',
    unanswered: 'Ohne Antwort geblieben.',
    resend: 'Erneut senden',
  },
  messageBubble: {
    thinking: 'Denkt nach…',
    thoughtFor: (duration: string) => `Hat ${duration} nachgedacht`,
    thoughts: 'Gedanken',
    interrupted: 'Unterbrochen',
    failed: 'Die Antwort konnte nicht erzeugt werden.',
    retry: 'Erneut versuchen',
    queuedNext: 'Wartet — als Nächstes dran',
    queued: (ahead: number) =>
      ahead === 1 ? 'Wartet — 1 Anfrage davor' : `Wartet — ${ahead} Anfragen davor`,
    nowAnswering: (question: string) => `Gerade dran: „${question}…“`,
    sources: 'Quellen',
    assistantThinking: 'Der Assistent denkt nach',
    tipLabel: 'Tipp: ',
  },
  attachmentChip: {
    renameAlias: 'Alias umbenennen',
    remove: 'Entfernen',
    clickToRename: (alias: string) => `${alias} — zum Umbenennen klicken`,
  },
  questionNav: {
    buttonLabel: (n: number) => `${n} Fragen`,
    buttonTitle: 'Alle Fragen in diesem Chat',
    popoverHeading: 'Fragen in diesem Chat',
    previous: 'Vorherige Frage (Alt+↑)',
    next: 'Nächste Frage (Alt+↓)',
  },
  sidebar: {
    expand: 'Seitenleiste ausklappen',
    collapse: 'Seitenleiste einklappen',
    newChat: 'Neuer Chat',
    settings: 'Einstellungen',
    openSettings: 'Einstellungen öffnen',
    feedback: 'Feedback',
    openFeedback: 'Feedback senden',
    switchToMindMap: 'Zur Mind Map wechseln',
    switchToChat: 'Zum Chat wechseln',
    rename: 'Umbenennen',
    delete: 'Löschen',
    deleteChatTitle: 'Chat löschen?',
    deleteChatBody: (title: string) => `„${title}" und alle daraus entstandenen Branches werden endgültig entfernt.`,
    deleteFailed: 'Der Chat konnte nicht gelöscht werden. Läuft das Backend?',
    cancel: 'Abbrechen',
    deleting: 'Wird gelöscht…',
    retry: 'Erneut versuchen',
    noChats: 'Noch keine Chats',
    allChats: 'Alle Chats',
    responseInProgress: 'Antwort wird generiert',
    queuedInQueue: 'Frage wartet in der Warteschlange',
    groups: {
      'Today': 'Heute',
      'Yesterday': 'Gestern',
      'This week': 'Diese Woche',
      'Last week': 'Letzte Woche',
      'This month': 'Diesen Monat',
      'Older': 'Älter',
    },
  },
  feedback: {
    title: 'Feedback senden',
    kindBug: 'Fehler',
    kindIdea: 'Idee',
    kindQuestion: 'Frage',
    placeholder: 'Was ist passiert, oder was würde helfen?',
    attachmentHint: 'Bilder und Videos werden noch nicht unterstützt — bitte beschreibe das Problem detailliert.',
    emailLabel: 'Deine E-Mail (optional — nur für eine Antwort)',
    emailPlaceholder: 'du@beispiel.de',
    cancel: 'Abbrechen',
    send: 'Senden',
    sending: 'Wird gesendet…',
    sent: 'Feedback gesendet — danke!',
    error: 'Feedback konnte nicht gesendet werden. Bitte versuche es erneut.',
    close: 'Schließen',
  },
  videoBanner: {
    transcriptAttached: ' · Transcript angehängt',
    viewTranscript: 'Transcript ansehen',
    openOnYouTube: 'Auf YouTube öffnen',
  },
  transcriptDrawer: {
    title: 'Transcript',
    close: 'Transcript schließen',
    sourceNote: 'Das ist der Quelltext, den das Modell liest.',
    languageNote: (lang: string) => ` Sprache: ${lang}.`,
  },
  paperSearch: {
    title: 'Research paper hinzufügen',
    close: 'Schließen',
    subtitle: 'Das importierte PDF wird an diesen Chat angehängt.',
    placeholder: 'Nach Titel, Autor oder Thema suchen…',
    search: 'Suchen',
    rateLimited: 'Die Suchdienste bremsen uns gerade aus — warte einen Moment und versuch es dann erneut.',
    searching: 'Suche in arXiv und OpenAlex…',
    noResults: 'Keine Treffer.',
    cites: (count: string) => ` · ${count} Zitationen`,
    openAccess: 'Open Access',
    manualDownload: 'Manueller Download',
    paywalled: 'Paywall',
    importButton: 'Importieren',
    importing: 'Wird importiert…',
    openSourcePage: 'Quellseite öffnen',
    manualHint: 'Der Host blockiert den direkten Download — speichere das PDF und lade es dann hoch',
    viewPublisher: 'Zum Verlag',
    noPdf: 'kein PDF',
    searchFailed: 'Suche fehlgeschlagen',
    importFailed: 'Import fehlgeschlagen',
  },
  youtubeSearch: {
    title: 'YouTube transcript hinzufügen',
    close: 'Schließen',
    subtitle: 'Das Transcript wird zur Quelle dieses Baums; das Video selbst wird nie heruntergeladen.',
    placeholder: 'YouTube durchsuchen…',
    search: 'Suchen',
    searching: 'Suche auf YouTube…',
    noResults: 'Keine Treffer.',
    add: 'Hinzufügen',
    fetching: 'Wird geholt…',
    searchFailed: 'Suche fehlgeschlagen',
    importFailed: 'Import fehlgeschlagen',
  },
  highlightsDrawer: {
    title: 'Highlights',
    close: 'Highlights schließen',
    all: 'Alle',
    empty: 'Noch keine Highlights — markiere Text und rechtsklicke, um zu highlighten.',
    pdfSource: (page: number) => `PDF · S. ${page}`,
    chatSource: (title: string) => `Chat · ${title}`,
    dateLocale: 'de-DE',
  },
  modelPicker: {
    switchModel: (name: string) => `Modell wechseln (${name})`,
    installedWithSize: (size: string) => `${size} · installiert`,
    installed: 'Installiert',
    thinking: 'Thinking',
    on: 'An',
    off: 'Aus',
    manageModels: 'Modelle verwalten',
    ollamaRunning: 'Ollama · läuft lokal',
    ollamaNotReachable: 'Ollama nicht erreichbar',
    cloudStatus: (label: string) => `${label} · Cloud`,
    coolingUntilTime: (time: string) => `ab ca. ${time}`,
    coolingInSeconds: (seconds: number) => `in ${seconds} s`,
    localGroup: 'Lokal · Ollama',
    noImages: 'liest keine Bilder',
    noLongerAvailable: 'nicht mehr verfügbar',
    ollamaRunningShort: 'Ollama läuft',
    ollamaNoVisionModel: 'Ollama läuft — kein Bild-fähiges Modell installiert',
    cloudProvidersCount: (n: number) =>
      n === 1 ? '1 Cloud-Anbieter eingerichtet' : `${n} Cloud-Anbieter eingerichtet`,
    startOllamaHint: 'Ollama starten, um lokal zu antworten',
    installVisionModelHint: 'Bild-fähiges Modell installieren',
    pillCoolingTip: (model: string, when: string) =>
      `${model} ist am Limit (${when}). Antworten weichen automatisch auf freie Modelle aus.`,
    freeGroup: 'Kostenlos',
    paidGroup: 'Kostenpflichtig',
    billingNeeded: 'Abrechnung nötig',
  },
  floatingPopup: {
    definition: 'Definition',
    wordCount: (n: number) => `· ${n} Wörter`,
    collapse: 'Einklappen',
    copyText: 'Text kopieren',
    copiedTitle: 'Kopiert!',
    copiedAria: 'Kopiert',
    close: 'Schließen',
    loadingDefinition: 'Definition wird geladen…',
    renameColors: 'Farben umbenennen',
    highlightColor: 'Highlight-Farbe',
    cancel: 'Abbrechen',
    renameLabels: 'Labels umbenennen',
    resetToDefault: 'Auf Standard zurücksetzen',
    labelFor: (color: string) => `Label für ${color}`,
    highlightAs: (label: string) => `Highlight als ${label}`,
    saveLabels: 'Labels speichern',
    // Domänenbegriff (CONTEXT.md) — bleibt auch im Deutschen englisch.
    askInChat: 'Ask in chat',
    openAsNewChat: 'Als neuen Chat öffnen',
  },
  highlightMenu: {
    changeColor: 'Farbe ändern',
    openLinkedChat: 'Verknüpften Chat öffnen',
    deleteHighlight: 'Highlight löschen',
  },
  pdfView: {
    zoomOut: 'Verkleinern',
    zoomIn: 'Vergrößern',
    previousPage: 'Vorherige Seite',
    nextPage: 'Nächste Seite',
    loadError: (msg: string) => `PDF konnte nicht geladen werden: ${msg}`,
  },
  parentContext: {
    badge: 'Elternchat',
    openChat: 'Diesen Chat öffnen',
  },
  mindMap: {
    mainTopic: 'Hauptthema',
    noChats: 'Noch keine Chats',
  },
  app: {
    newChatTitle: 'Neuer Chat',
    // Kein „Über:"-Präfix (Nutzerentscheidung 2026-07-26) — siehe EN-Hälfte.
    aboutChatTitle: (word: string) => word,
    newTreeTitle: 'Dieser Chat-Baum hat bereits eine Quelle',
    newTreeLead: 'Jeder Chat-Baum hält genau eine Quelle — ein PDF oder ein YouTube transcript.',
    newTreeAskPrefix: 'Neuen Baum mit ',
    newTreeAskSuffix: ' starten?',
    cancel: 'Abbrechen',
    startNewTree: 'Neuen Baum starten',
    noDefinition: '(Keine Definition erhalten)',
    unknownError: 'Unbekannter Fehler',
    couldNotLoadDefinition: (msg: string) => `Definition konnte nicht geladen werden: ${msg}`,
    couldNotCreateChat: (msg: string) => `Chat konnte nicht erstellt werden: ${msg} — läuft das Backend?`,
    chatFallbackLabel: 'Chat',
    resizeMindMap: 'Mind-Map-Höhe anpassen',
    resizeChatColumn: 'Chat-Spalte anpassen',
  },
};

const ALL: Record<AppLanguage, Strings> = { en, de };

/** Re-rendert die Komponente beim Sprachwechsel mit (Hook-Variante). */
export function useStrings(): Strings {
  return ALL[useAppLanguage()];
}

/** Für Code außerhalb von React (Module, Event-Handler ohne Hook-Zugriff). */
export function getStrings(): Strings {
  return ALL[getAppLanguage()];
}
