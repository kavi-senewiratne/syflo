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
    // /btw in the slash menu — the one place the command is discovered, so
    // the description carries the promise instead of a line in the composer.
    btwCommandDesc: 'Ask a side question — not saved to this chat',
    // /branch (design/mockup-branch-command.html). The command name is not
    // translated — same rule as /btw — but everything around it is.
    branchCommandDesc: 'Open a branch on a topic you type',
    branchUnder: (title: string) => `under ${title}`,
    branchTargetHeading: 'Create the branch under',
    branchTargetChange: 'Change where the branch is created',
    quoteFrom: (label: string) => `from "${label}"`,
    removeQuote: 'Remove quote',
    // /btw (design/mockup-btw-composer-fold.html). The command itself stays
    // "/btw" in both languages — it is the panel's name too, so nothing here
    // translates it.
    btwKeep: 'Keep in chat',
    btwBranch: 'Make a branch',
    // Branch trace (design/mockup-branch-trace.html): the line a passage-less
    // branch leaves at the point in the transcript where it was opened. The
    // pill carries the raw command name — "/btw" and "/branch" are the same
    // in both languages, like the panel — so only the wording around it lives
    // here.
    traceOpenBranch: 'Open branch',
    traceMore: (n: number) => (n === 1 ? 'Show 1 more branch' : `Show ${n} more branches`),
    traceLess: 'Show fewer',
    // Back-link in the header of a branch that has no quote (`/branch`):
    // jumps to its line in the parent transcript.
    traceBackTo: 'Branched off in ',
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
    // The provider's servers are saturated, not our quota (503 "high
    // demand", mockup-truncated-answer §03). Names the provider, the wait
    // and which attempt this is — so the wait reads as progress, not as a
    // hang. Its own copy because "rate limit" would blame the wrong thing.
    overloadedWaiting: (provider: string, seconds: number, attempt: number, max: number) =>
      `${provider} is overloaded — retrying in ${seconds}s (${attempt} of ${max})`,
    overloadedRetrying: (provider: string, attempt: number, max: number) =>
      `${provider} is overloaded — retrying (${attempt} of ${max})…`,
    // Every retry used up. Names the provider, not the quota — nothing the
    // user owns ran out here.
    failOverloaded: (provider: string) =>
      `${provider} is overloaded — three attempts came back empty.`,
    // The answer stopped mid-thought (mockup-truncated-answer §01). With a
    // time mark the line answers the reader's actual question — "why does it
    // stop here?" — without scrolling.
    truncated: 'The answer broke off mid-sentence.',
    truncatedAtMark: (mark: string) => `The answer broke off mid-sentence — last at ${mark}.`,
    continueWriting: 'Continue',
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
    // Tooltip of a clickable time mark in a video overview.
    openAtTime: 'Open the video at this point',
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
    // Tooltip of a clickable "Ask in chat" quote
    // (mockup-quote-jump-to-source.html, variant A).
    quoteJumpTitle: 'Go to the source of this quote',
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
    // Pinned section (design/mockup-pinned-chats.html, variant A) — the
    // heading reads like a date section, the pin icon carries the difference.
    pinned: 'Pinned',
    pin: 'Pin chat',
    unpin: 'Unpin chat',
    // The parent of the date sections (design/mockup-sidebar-timeline-group.html,
    // variant B, decided 2026-08-16). One heading, so the whole clock side of
    // the sidebar puts itself away in a click. German "Verlauf" is the word the
    // user chose; "History" is its English counterpart and what a new user
    // looks for.
    timeline: 'History',
    // Categories — the third grouping in the root list, and the only one the
    // user owns (design/mockup-sidebar-categories-v2.html, decided 2026-08-16).
    newCategory: 'New category',
    newSubcategory: 'New subcategory',
    renameCategory: 'Rename',
    deleteCategory: 'Delete category',
    // The promise the menu makes out loud: a container is not its contents.
    deleteCategoryNote: (count: number) => count === 1
      ? 'The chat stays and returns to its date section.'
      : `The ${count} chats stay and return to their date sections.`,
    // The confirmation repeats that promise, because the modal is where the
    // deletion actually happens and "delete" reads as "delete the chats too".
    deleteCategoryTitle: 'Delete category?',
    deleteCategoryBody: (name: string, count: number) => count === 0
      ? `"${name}" will be removed. It holds no chats.`
      : count === 1
        ? `"${name}" will be removed. The chat in it stays and returns to its date section.`
        : `"${name}" will be removed. The ${count} chats in it stay and return to their date sections.`,
    categoryOptions: 'Category options',
    categoryNamePlaceholder: 'Category name',
    moveToCategory: 'Move to category',
    // Files into the category itself rather than one of its subcategories —
    // without it the user has to back out of a submenu they only opened to
    // read the names.
    categoryItself: (name: string) => `${name} itself`,
    removeFromCategory: 'Remove from category',
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
    errorIssueLink: 'Open a GitHub issue instead',
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
  videoPane: {
    chapters: 'Chapters',
    transcript: 'Transcript',
    watchOnYouTube: 'Watch on YouTube',
    readTranscript: 'Read the transcript',
    noChaptersTitle: 'No chapters yet',
    noChaptersBody:
      'The chapters are the sections of the video overview. Ask for the overview and they appear here.',
    // Three honest states instead of one wrong sentence
    // (design/mockup-truncated-answer.html §02): the overview question goes
    // out automatically on import, so "ask for it" was advice for something
    // already done.
    chaptersWriting: 'Writing the overview …',
    chaptersCut: 'The overview broke off',
    chaptersCutAtMark: (mark: string) => `The overview broke off at ${mark}`,
    // Not cut — finished, and still short. A provider that ends cleanly after
    // a quarter of the video (Flash Lite, 2026-08-18) leaves nothing to
    // "break off", and saying so anyway would be a lie about what happened.
    chaptersShortAtMark: (mark: string) => `The overview stops at ${mark}`,
    chaptersCutBody: (duration: string) =>
      `Only part of the ${duration} video has been structured so far.`,
    continueOverview: 'Continue',
    embedBlockedTitle: "This video can't play inside Syflo",
    embedBlockedBody:
      'The channel has disabled embedding. The transcript is attached all the same — the overview and every question work exactly as usual; only the picture has to open on YouTube.',
    jumpTo: (mark: string) => `Jump to ${mark}`,
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
  // Default name of each highlight color. These follow the App language
  // (user request 2026-08-06) — unlike every other string here they are only
  // a DEFAULT: a name the user typed in the popup's edit mode is stored
  // server-side and wins over the language, in every language.
  //
  // The five categories name the READING SITUATION a mark records, and they
  // are deliberately mutually exclusive (decision 2026-08-06). 'Question' was
  // rejected as the yellow label: every mark can be branched into a question,
  // so the word said nothing the color did not already say. 'unclear' (not
  // understood) versus 'doubt' (understood but not convinced) is the sharp
  // pair that replaces it.
  highlightLabels: {
    yellow: 'Unclear',
    green: 'Key point',
    blue: 'Definition',
    pink: 'Idea',
    orange: 'Doubt',
  },
  highlightsDrawer: {
    title: 'Highlights',
    close: 'Close highlights',
    all: 'All',
    empty: 'No highlights yet — select text and right-click to highlight.',
    pdfSource: (page: number) => `PDF · p. ${page}`,
    // The video marks name their moment — the transcript's answer to a page
    // number (drawer, 2026-08-16).
    transcriptSource: (mark: string) => `Transcript · ${mark}`,
    chapterSource: (mark: string) => `Chapter · ${mark}`,
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
    // Shown in place of openAsNewChat while the branch is being created —
    // the wait is the passage-title lookup (see chat/passageTitle.ts).
    creatingChat: 'Creating chat…',
  },
  // Citation card — the popup a clicked reference link opens
  // (design/mockup-paper-reference-links.html). The STATE lives in the door:
  // a paywalled work reads "No free PDF", one already imported reads
  // "Go to tree". No badge, no footnote.
  citationCard: {
    reference: (label: string) => `Reference ${label}`,
    referenceGeneric: 'Reference',
    notIdentified: 'from the page',
    alreadyATree: 'already a tree',
    lookingItUp: 'Looking it up…',
    notFound: 'Read off the printed row.',
    // Bare number for the icon row — the icon and its label say what it is.
    citationCount: (n: number) => n.toLocaleString('en-US'),
    // Spelled out for the folded summary line, which has no icon beside it.
    citationCountLong: (n: number) => `${n.toLocaleString('en-US')} citations`,
    etAl: 'et al.',
    // Screen-reader labels for the icons that replace the "·" separators.
    authorsLabel: 'Authors',
    yearLabel: 'Year',
    venueLabel: 'Published in',
    citationsLabel: 'Citations',
    openedAgo: 'already open in Syflo',
    openInSyflo: 'Open in Syflo',
    openInBrowser: 'Open in browser',
    noFreePdf: 'No downloadable PDF available.',
    // The silent web search (design/mockup-citation-card-standard.html § 04).
    // Only three sentences exist for it, and two of them are apologies —
    // when it works, the reader is meant to notice nothing at all.
    searchingFulltext: 'Looking for the full text…',
    noFulltextFound: 'No freely available full text found.',
    searchUnreachable: 'The web search is not reachable right now.',
    // The clock and the sentence shape come from the quota cooldown line in
    // the chat ("Rate limit reached — trying again in 18 s",
    // mockup-quota-states § 02): one countdown idiom for the whole app (user
    // decision 2026-08-11).
    //
    // "Search paused" and not "Too many requests": the reader is owed the
    // consequence, not the cause. Whose limit it was and which engine shut us
    // out is backstage — what they need to know is that Syflo stopped
    // looking, and starts again by itself in n seconds.
    searchRetryIn: (seconds: number) => `Search paused — resuming in ${seconds} s`,
    goToTree: 'Go to tree',
    searchTheWeb: 'Search the web',
    loadingPaper: 'Loading paper…',
    downloadBlocked: 'The download was blocked. Save the PDF from the publisher and upload it into a new tree.',
    close: 'Close',
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
    // Placeholder for the node's second line while the finding is still
    // missing (mockup-mindmap-node-final.html §01).
    outcomePending: 'Outcome follows …',
    // Filter chips above the map — same wording as the highlights drawer.
    filterAll: 'All',
    filterHidden: (shown: number, total: number) => `${shown} / ${total} nodes shown`,
  },
  app: {
    newChatTitle: 'New Chat',
    // No "About:" prefix (user decision 2026-07-26): the sidebar tree reads
    // better when the selection itself is the provisional title; the
    // auto-title replaces it with a summary after the first answer anyway.
    aboutChatTitle: (word: string) => word,
    newTreeTitle: 'This chat tree already has a source',
    // Variant C (user choice 2026-08-15): the two sources are shown as cards,
    // current above new, instead of the title sitting inside a sentence. The
    // lead therefore ends on a colon and the "Start a new tree with … ?"
    // wrapper is gone — the confirm button already says what happens.
    newTreeLead: 'A tree holds exactly one source. The new one needs a tree of its own:',
    newTreeCurrent: 'In this tree',
    newTreeNext: 'In the new tree',
    // Kind labels under a source title. The channel/author is appended by the
    // caller when there is one.
    newTreeKindPdf: 'PDF',
    newTreeKindVideo: 'YouTube',
    newTreeUntitledPdf: 'Untitled PDF',
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
    btwCommandDesc: 'Nebenfrage stellen — wird nicht in diesem Chat gespeichert',
    branchCommandDesc: 'Branch zu einem selbst getippten Thema öffnen',
    branchUnder: (title: string) => `unter ${title}`,
    branchTargetHeading: 'Branch anlegen unter',
    branchTargetChange: 'Ändern, wo der Branch angelegt wird',
    quoteFrom: (label: string) => `aus „${label}"`,
    removeQuote: 'Zitat entfernen',
    btwKeep: 'Im Chat behalten',
    btwBranch: 'Verzweigen',
    traceOpenBranch: 'Branch öffnen',
    traceMore: (n: number) => (n === 1 ? '1 weiteren Branch anzeigen' : `${n} weitere Branches anzeigen`),
    traceLess: 'Weniger anzeigen',
    traceBackTo: 'Abgezweigt in ',
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
    overloadedWaiting: (provider: string, seconds: number, attempt: number, max: number) =>
      `${provider} ist überlastet — neuer Versuch in ${seconds} s (${attempt} von ${max})`,
    overloadedRetrying: (provider: string, attempt: number, max: number) =>
      `${provider} ist überlastet — neuer Versuch läuft (${attempt} von ${max})…`,
    failOverloaded: (provider: string) =>
      `${provider} ist überlastet — drei Versuche blieben ohne Antwort.`,
    truncated: 'Die Antwort brach mitten im Satz ab.',
    truncatedAtMark: (mark: string) => `Die Antwort brach mitten im Satz ab — zuletzt bei ${mark}.`,
    continueWriting: 'Weiterschreiben',
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
    openAtTime: 'Video an dieser Stelle öffnen',
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
    quoteJumpTitle: 'Zur Quelle dieses Zitats springen',
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
    pinned: 'Angepinnt',
    pin: 'Chat anpinnen',
    unpin: 'Nicht mehr anpinnen',
    timeline: 'Verlauf',
    newCategory: 'Neue Kategorie',
    newSubcategory: 'Neue Unterkategorie',
    renameCategory: 'Umbenennen',
    deleteCategory: 'Kategorie löschen',
    deleteCategoryNote: (count: number) => count === 1
      ? 'Der Chat bleibt und kehrt in seinen Datums-Abschnitt zurück.'
      : `Die ${count} Chats bleiben und kehren in ihre Datums-Abschnitte zurück.`,
    deleteCategoryTitle: 'Kategorie löschen?',
    deleteCategoryBody: (name: string, count: number) => count === 0
      ? `„${name}" wird entfernt. Sie enthält keine Chats.`
      : count === 1
        ? `„${name}" wird entfernt. Der Chat darin bleibt und kehrt in seinen Datums-Abschnitt zurück.`
        : `„${name}" wird entfernt. Die ${count} Chats darin bleiben und kehren in ihre Datums-Abschnitte zurück.`,
    categoryOptions: 'Kategorie-Optionen',
    categoryNamePlaceholder: 'Name der Kategorie',
    moveToCategory: 'In Kategorie verschieben',
    categoryItself: (name: string) => `${name} selbst`,
    removeFromCategory: 'Aus der Kategorie nehmen',
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
    errorIssueLink: 'Stattdessen ein GitHub-Issue öffnen',
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
  videoPane: {
    chapters: 'Kapitel',
    transcript: 'Transcript',
    watchOnYouTube: 'Auf YouTube ansehen',
    readTranscript: 'Transcript lesen',
    noChaptersTitle: 'Noch keine Kapitel',
    noChaptersBody:
      'Die Kapitel sind die Abschnitte der Video overview. Sie entstehen aus der Antwort — sobald sie da ist, stehen sie hier.',
    chaptersWriting: 'Die Übersicht wird geschrieben …',
    chaptersCut: 'Die Übersicht brach ab',
    chaptersCutAtMark: (mark: string) => `Die Übersicht brach bei ${mark} ab`,
    chaptersShortAtMark: (mark: string) => `Die Übersicht endet bei ${mark}`,
    chaptersCutBody: (duration: string) =>
      `Von ${duration} Minuten ist bisher nur ein Teil gegliedert.`,
    continueOverview: 'Weiterschreiben',
    embedBlockedTitle: 'Dieses Video lässt sich in Syflo nicht abspielen',
    embedBlockedBody:
      'Der Kanal hat das Einbetten deaktiviert. Das Transcript hängt trotzdem am Baum — Übersicht und alle Fragen funktionieren wie gewohnt; nur das Bild muss auf YouTube aufgehen.',
    jumpTo: (mark: string) => `Zu ${mark} springen`,
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
  // Nur Voreinstellung — eine eigene Umbenennung gewinnt (siehe EN-Hälfte).
  highlightLabels: {
    yellow: 'Unklar',
    green: 'Kernaussage',
    blue: 'Definition',
    pink: 'Idee',
    orange: 'Zweifel',
  },
  highlightsDrawer: {
    title: 'Highlights',
    close: 'Highlights schließen',
    all: 'Alle',
    empty: 'Noch keine Highlights — markiere Text und rechtsklicke, um zu highlighten.',
    pdfSource: (page: number) => `PDF · S. ${page}`,
    transcriptSource: (mark: string) => `Transcript · ${mark}`,
    chapterSource: (mark: string) => `Kapitel · ${mark}`,
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
    creatingChat: 'Chat wird erstellt …',
  },
  citationCard: {
    reference: (label: string) => `Referenz ${label}`,
    referenceGeneric: 'Referenz',
    notIdentified: 'aus dem Text',
    alreadyATree: 'bereits ein Baum',
    lookingItUp: 'Wird nachgeschlagen …',
    notFound: 'Aus der gedruckten Zeile gelesen.',
    citationCount: (n: number) => n.toLocaleString('de-DE'),
    citationCountLong: (n: number) => `${n.toLocaleString('de-DE')} Zitationen`,
    etAl: 'u.\u202fa.',
    authorsLabel: 'Autoren',
    yearLabel: 'Jahr',
    venueLabel: 'Erschienen in',
    citationsLabel: 'Zitationen',
    openedAgo: 'bereits in Syflo geöffnet',
    openInSyflo: 'In Syflo öffnen',
    openInBrowser: 'Im Browser öffnen',
    noFreePdf: 'Kein herunterladbares PDF verfügbar.',
    searchingFulltext: 'Volltext wird gesucht …',
    noFulltextFound: 'Kein frei verfügbarer Volltext gefunden.',
    searchUnreachable: 'Die Websuche ist gerade nicht erreichbar.',
    searchRetryIn: (seconds: number) => `Suche pausiert — weiter in ${seconds} s`,
    goToTree: 'Zum Baum',
    searchTheWeb: 'Im Web suchen',
    loadingPaper: 'Paper wird geladen …',
    downloadBlocked: 'Der Download wurde blockiert. Speichere das PDF beim Verlag und lade es in einen neuen Baum hoch.',
    close: 'Schließen',
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
    outcomePending: 'Ergebnis folgt …',
    filterAll: 'Alle',
    filterHidden: (shown: number, total: number) => `${shown} / ${total} Knoten sichtbar`,
  },
  app: {
    newChatTitle: 'Neuer Chat',
    // Kein „Über:"-Präfix (Nutzerentscheidung 2026-07-26) — siehe EN-Hälfte.
    aboutChatTitle: (word: string) => word,
    newTreeTitle: 'Dieser Chat-Baum hat bereits eine Quelle',
    newTreeLead: 'Ein Baum hält genau eine Quelle. Für die neue braucht es einen eigenen Baum:',
    newTreeCurrent: 'In diesem Baum',
    newTreeNext: 'Im neuen Baum',
    newTreeKindPdf: 'PDF',
    newTreeKindVideo: 'YouTube',
    newTreeUntitledPdf: 'PDF ohne Titel',
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
