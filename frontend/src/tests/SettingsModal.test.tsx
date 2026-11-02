/**
 * SettingsModal — Zwei-Tab-Layout (design/mockup-settings-reorg.html,
 * Variante A): Appearance (Themes, nur Close) und Model (Provider → Model →
 * API Key, nur hier Activate). Seit ADR-0008: fünf Provider-Karten, Modelle
 * und Key-URLs aus der Registry, Daten-Schicksal-Zeile, Usage-Block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../api', () => ({
  api: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getOllamaModels: vi.fn(),
    getRecommendation: vi.fn(),
    pullOllamaModel: vi.fn(),
    deleteOllamaModel: vi.fn(),
    setOllamaContextLength: vi.fn(),
    getRegistry: vi.fn(),
    getUsageSummary: vi.fn(),
    getQuotaCooldowns: vi.fn(),
  },
}));

import { api } from '../api';
import { SettingsModal } from '../components/SettingsModal';
import type { Recommendation, Registry, Settings, UsageSummary } from '../types';

const ollamaSettings: Settings = {
  llm_provider: 'ollama',
  ollama_model: 'llama3.2-vision:11b',
  gemini_model: 'gemini-2.5-flash',
  groq_model: 'openai/gpt-oss-120b',
  openai_model: 'gpt-4o-mini',
  anthropic_model: 'claude-sonnet-4-5',
  gemini_api_key_set: false,
  groq_api_key_set: false,
  openai_api_key_set: false,
  anthropic_api_key_set: false,
  custom_instructions: '',
  custom_instructions_enabled: true,
  tavily_api_key_set: false,
};

// Frischer Install (ADR-0008): Gemini 2.5 Flash ist der Default, kein Key.
const geminiSettings: Settings = { ...ollamaSettings, llm_provider: 'gemini' };

// Schlanke Registry-Fixture — Form wie GET /api/settings/registry.
const registry: Registry = {
  asOf: '2026-07-25',
  providers: {
    gemini: {
      label: 'Gemini', kind: 'cloud', keyUrl: 'https://aistudio.google.com/apikey',
      free: true, defaultModel: 'gemini-2.5-flash',
      models: [
        {
          name: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vision: true, canThink: true,
          contextWindowTokens: 1048576, budgetCapTokens: 32768, free: true,
          pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5 },
          freeQuota: { requestsPerMinute: 10, requestsPerDay: 250 },
        },
        {
          name: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite', vision: true, canThink: true,
          contextWindowTokens: 1048576, budgetCapTokens: 32768, free: true,
          pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 },
          freeQuota: { requestsPerMinute: 15, requestsPerDay: 500 },
        },
        {
          name: 'gemini-pro-latest', label: 'Gemini Pro', vision: true, canThink: true,
          contextWindowTokens: 1048576, budgetCapTokens: 32768, free: false,
          pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
        },
      ],
    },
    groq: {
      label: 'Groq', kind: 'cloud', keyUrl: 'https://console.groq.com/keys',
      free: true, defaultModel: 'openai/gpt-oss-120b',
      models: [
        {
          name: 'openai/gpt-oss-120b', label: 'gpt-oss 120B', vision: false, canThink: true,
          contextWindowTokens: 131072, budgetCapTokens: 32768, free: true, pricing: null,
        },
      ],
    },
    openai: {
      label: 'OpenAI', kind: 'cloud', keyUrl: 'https://platform.openai.com/api-keys',
      free: false, defaultModel: 'gpt-4o-mini',
      models: [
        {
          name: 'gpt-4o-mini', label: 'GPT-4o mini', vision: true, canThink: false,
          contextWindowTokens: 128000, budgetCapTokens: 32768, free: false,
          pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
        },
      ],
    },
    anthropic: {
      label: 'Claude', kind: 'cloud', keyUrl: 'https://console.anthropic.com/settings/keys',
      free: false, defaultModel: 'claude-sonnet-4-5',
      models: [
        {
          name: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', vision: true, canThink: true,
          contextWindowTokens: 200000, budgetCapTokens: 32768, free: false,
          pricing: { inputPerMTok: 3, outputPerMTok: 15 },
        },
      ],
    },
    ollama: { kind: 'local', free: true, models: [] },
  },
};

const usageSummary: UsageSummary = {
  month: '2026-07',
  pricesAsOf: '2026-07-25',
  providers: {
    gemini: { requests: 12, requestsToday: 5, promptTokens: 10000, completionTokens: 4000, estimatedUsd: 0.02 },
    openai: { requests: 3, requestsToday: 2, promptTokens: 2000, completionTokens: 800, estimatedUsd: 0.11 },
  },
  modelsToday: { 'gemini/gemini-2.5-flash': 5 }, kindsToday: {},
};

// What GET /api/system/recommendation says on an RTX 5080 with nothing pulled.
const recommendedModel = {
  name: 'qwen3.5:9b', label: 'Qwen 3.5 9B', vision: true, canThink: true,
  contextWindowTokens: 32768, budgetCapTokens: 32768, free: true, pricing: null,
  downloadGb: 6.6, fitsGb: 10.1, minMemoryGb: 8, measured: false, fits: true, installed: false,
};
const alsoFitsModel = { ...recommendedModel, name: 'gemma4:12b', label: 'Gemma 4 12B', downloadGb: 8, fitsGb: 11.5, alternative: true };
const rtx5080: Recommendation = {
  hardware: {
    platform: 'linux', totalMemGb: 62, basis: 'vram', usableGb: 15.9,
    gpu: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5080 Laptop GPU', vramGb: 15.9 },
  },
  ollamaReachable: true,
  recommended: recommendedModel,
  alsoFits: [alsoFitsModel],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.getSettings).mockResolvedValue(ollamaSettings);
  vi.mocked(api.getOllamaModels).mockResolvedValue([]);
  vi.mocked(api.getRecommendation).mockResolvedValue(rtx5080);
  vi.mocked(api.getRegistry).mockResolvedValue(registry);
  vi.mocked(api.getUsageSummary).mockResolvedValue(usageSummary);
  vi.mocked(api.getQuotaCooldowns).mockResolvedValue([]);
});

async function renderOpen() {
  render(<SettingsModal open={true} onClose={vi.fn()} />);
  await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
  // Warten, bis der Ladezustand weg ist und der Theme-Inhalt steht.
  await screen.findByText('Theme');
}

describe('SettingsModal – two-tab layout', () => {
  it('opens on the Appearance tab: themes visible, no Activate button', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByText('Mushroom Kingdom')).toBeInTheDocument();
    // Das Default-Theme wird seit 2026-08-12 wieder angeboten und heißt seit
    // 2026-08-13 "Simply Blue" (ID weiterhin `professional`).
    expect(screen.getByText('Simply Blue')).toBeInTheDocument();
    // Kein Activate und kein Status-Hinweis auf dem Appearance-Tab
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/current selection is active/i)).not.toBeInTheDocument();
  });

  it('shows the numbered provider/model flow and Activate on the Model tab', async () => {
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: /model/i }));

    expect(screen.getByText('Ollama (local)')).toBeInTheDocument();
    expect(screen.getByText('Gemini')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activate/i })).toBeInTheDocument();
    // Ollama aktiv → kein API-Key-Schritt
    expect(screen.queryByText('API Key')).not.toBeInTheDocument();
  });

  it('opens directly on the Model tab with initialTab="model" (sidebar Active-model button)', async () => {
    render(<SettingsModal open={true} onClose={vi.fn()} initialTab="model" />);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    expect(await screen.findByText('Ollama (local)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activate/i })).toBeInTheDocument();
    // Theme-Pills gehören zum Appearance-Tab und sind hier nicht sichtbar
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
  });

  it('reveals the API key step only when a cloud provider is picked', async () => {
    await renderOpen();

    fireEvent.click(screen.getByRole('button', { name: /model/i }));
    fireEvent.click(screen.getByTestId('provider-card-openai'));

    expect(screen.getByText('API Key')).toBeInTheDocument();
    // Ohne Key: Aktivieren blockiert + Hinweis im Footer
    expect(screen.getByText(/add an api key to activate openai/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activate/i })).toBeDisabled();
  });
});

// ─── Cloud-Provider (ADR-0008, Slice 8) ──────────────────────────────────────
// Fünf Provider-Karten, Registry-getriebene Modelle/Key-URLs, ehrliche
// Daten-Schicksal-Zeile pro Provider, Key-Pflicht vor Aktivierung.

describe('SettingsModal – cloud providers (ADR-0008)', () => {
  async function openModelTab(settings: Settings = geminiSettings) {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    await screen.findByTestId('provider-card-gemini');
  }

  it('renders five provider cards with gemini preselected from the settings', async () => {
    await openModelTab();

    for (const p of ['gemini', 'groq', 'openai', 'anthropic', 'ollama']) {
      expect(screen.getByTestId(`provider-card-${p}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('provider-card-gemini')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('provider-card-ollama')).toHaveAttribute('aria-pressed', 'false');
    // Kein Kosten-Badge mehr auf der Karte (Variante B, 2026-07-30): Kosten
    // sind eine Eigenschaft von Modell × Key und leben in Schritt 2. Die
    // Karte trägt nur noch die Herkunft.
    expect(screen.getByTestId('provider-card-gemini')).toHaveTextContent('Cloud');
    expect(screen.getByTestId('provider-card-gemini')).not.toHaveTextContent('Free');
    expect(screen.getByTestId('provider-card-ollama')).toHaveTextContent('Local');
  });

  it('changes the data-fate line with the selected provider', async () => {
    await openModelTab();

    expect(screen.getByTestId('provider-data-note')).toHaveTextContent(
      /Google may use them to improve its products/i,
    );

    fireEvent.click(screen.getByTestId('provider-card-ollama'));
    expect(screen.getByTestId('provider-data-note')).toHaveTextContent(
      'Chat data never leaves this device.',
    );

    fireEvent.click(screen.getByTestId('provider-card-groq'));
    expect(screen.getByTestId('provider-data-note')).toHaveTextContent(
      'Requests go to Groq under your own key.',
    );
  });

  // Kosten-Stufen (mockup-model-cost-tiers Variante B, gewählt 2026-07-30):
  // der Modell-Schritt ist eine Radio-Liste mit den Gruppen Free tier /
  // Requires billing statt eines Dropdowns.
  it('groups the cloud models by cost tier, with a lock and price on paid rows', async () => {
    await openModelTab();

    expect(screen.getByText('Free tier')).toBeInTheDocument();
    expect(screen.getByText('Requires billing')).toBeInTheDocument();
    // Gespeichertes Modell ist vorausgewählt.
    expect(screen.getByTestId('settings-model-gemini-2.5-flash')).toHaveAttribute('aria-checked', 'true');
    // Paid-Zeile: Hinweis + Preis, aber wählbar (Notausgang für Billing-Keys).
    const pro = screen.getByTestId('settings-model-gemini-pro-latest');
    expect(pro).toHaveTextContent('Billing required');
    expect(pro).toHaveTextContent('$1.25 / MTok');
    fireEvent.click(pro);
    expect(pro).toHaveAttribute('aria-checked', 'true');

    // Groq: alle Modelle frei → keine Billing-Gruppe.
    fireEvent.click(screen.getByTestId('provider-card-groq'));
    expect(screen.queryByText('Requires billing')).not.toBeInTheDocument();
  });

  it('shows live used/limit meters with a key, static quotas without one', async () => {
    // Mit Key: Zähler aus modelsToday gegen das Registry-Kontingent.
    await openModelTab({ ...geminiSettings, gemini_api_key_set: true });
    expect(await screen.findByTestId('settings-quota-gemini-2.5-flash')).toHaveTextContent('5/250');

    // Der W10-Tooltip erklärt die Doppel-Natur (frei UND bezahlbar) am Gruppenkopf.
    expect(screen.getByTestId('tier-info').getAttribute('data-tip')).toMatch(/API key/i);
  });

  it('shows the static registry quota when no key is saved yet (W5)', async () => {
    await openModelTab();
    // Ohne Key keine Nutzungsdaten: statisches Kontingent statt Zähler.
    expect(screen.getByTestId('settings-quota-gemini-2.5-flash')).toHaveTextContent('250 / day');
  });

  it('links the key guide CTA to the registry keyUrl', async () => {
    await openModelTab();

    expect(screen.getByTestId('key-guide-cta')).toHaveAttribute(
      'href',
      'https://aistudio.google.com/apikey',
    );

    fireEvent.click(screen.getByTestId('provider-card-anthropic'));
    expect(screen.getByTestId('key-guide-cta')).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys',
    );
  });

  it('blocks Activate for a cloud provider without a key until one is typed', async () => {
    // Ollama aktiv gespeichert → der Wechsel auf Gemini ist dirty, aber ohne
    // Key bleibt Aktivieren blockiert.
    await openModelTab(ollamaSettings);
    fireEvent.click(screen.getByTestId('provider-card-gemini'));

    expect(screen.getByText(/add an api key to activate gemini/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activate/i })).toBeDisabled();

    // Key eintippen → Aktivieren wird frei.
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'AIza-test-key' } });
    expect(screen.getByRole('button', { name: /activate/i })).toBeEnabled();
  });

  it('sends llm_provider, the provider model and the typed key on Activate', async () => {
    const updated: Settings = { ...geminiSettings, gemini_api_key_set: true };
    vi.mocked(api.updateSettings).mockResolvedValue(updated);
    await openModelTab(ollamaSettings);
    fireEvent.click(screen.getByTestId('provider-card-gemini'));
    fireEvent.change(screen.getByPlaceholderText('sk-…'), { target: { value: 'AIza-test-key' } });
    fireEvent.click(screen.getByRole('button', { name: /activate/i }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm_provider: 'gemini',
        gemini_model: 'gemini-2.5-flash',
        gemini_api_key: 'AIza-test-key',
      }),
    );
  });

  it('keeps the $5 starter table only for OpenAI', async () => {
    await openModelTab();
    expect(screen.queryByText(/what \$5 gets you/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('provider-card-openai'));
    expect(screen.getByText(/what \$5 gets you/i)).toBeInTheDocument();
  });

  it('shows the usage block: free quota counter for gemini, estimate for openai', async () => {
    await openModelTab();

    // Gemini (frei): Anfragen heute inkl. Tageslimit aus der Registry.
    expect(screen.getByTestId('usage-block')).toHaveTextContent('5 / 250 requests today');
    expect(screen.getByTestId('usage-block')).toHaveTextContent('Prices as of 2026-07-25');
    expect(screen.getByTestId('usage-block')).not.toHaveTextContent('estimated');

    // OpenAI (bezahlt): geschätzte Kosten, klar als Schätzung gelabelt.
    fireEvent.click(screen.getByTestId('provider-card-openai'));
    expect(screen.getByTestId('usage-block')).toHaveTextContent('2 requests today');
    expect(screen.getByTestId('usage-block')).toHaveTextContent('~$0.11 estimated');
  });
});

// ── Ollama model list (frozen fallback, ADR-0008 amendment) ─────────────────
// No download, no remove, no hardware recommendation: the app only lists the
// installed vision models and points to `ollama pull` in the terminal.

// W3 (design/mockup-onboarding-flow.html §06): the search is a provider like
// any other — same mask, same pattern. W1 asks at the point of need, but a
// reader who has not opened a PDF yet never reaches that point, so the
// settings carry the same field. The mockup's "own SearXNG" option is gone
// with ADR-0012: Tavily is the whole of it.
describe('SettingsModal – web search tab (W3)', () => {
  // Its OWN tab (user decision 2026-08-24), not a row under the model steps.
  // The search belongs to no provider and is never "activated", so it does not
  // share the model tab's Activate button either — like Instructions, it has
  // its own Save.
  async function openSearchTab(settings: Settings = geminiSettings) {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    render(<SettingsModal open onClose={vi.fn()} initialTab="search" />);
    return screen.findByTestId('settings-search-row');
  }

  it('is reachable as a tab of its own', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(geminiSettings);
    render(<SettingsModal open onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /appearance/i });

    fireEvent.click(screen.getByRole('button', { name: /web search/i }));

    expect(await screen.findByTestId('settings-search-row')).toBeInTheDocument();
    // And it is NOT hiding under the model steps any more.
    fireEvent.click(screen.getByRole('button', { name: /^model$/i }));
    expect(screen.queryByTestId('settings-search-row')).not.toBeInTheDocument();
  });

  // Variant C of mockup-search-settings-key-states.html (2026-09-12): the
  // sell lives in a guide block that renders only while no key is stored —
  // the same rule as the Model tab's key-guide.
  it('offers the search key with its free allowance as a number', async () => {
    const row = await openSearchTab();

    expect(screen.getByTestId('search-key-guide')).toHaveTextContent('1000 searches a month');
    // No badge while nothing is stored — the Model tab's key step shows its
    // mini-badge only once a key is saved, and the two tabs must match.
    expect(row).not.toHaveTextContent('saved');
  });

  it('drops the sell once a key is stored, but keeps the allowance fact', async () => {
    const row = await openSearchTab({ ...geminiSettings, tavily_api_key_set: true });

    // The badge rides the field label and reuses the Model tab's exact word:
    // "Tavily API key" already says key, so the badge only says saved.
    expect(row).toHaveTextContent(/Tavily API key\s*saved/);
    // The guide argued for getting a key — argued at someone who has one.
    expect(screen.queryByTestId('search-key-guide')).not.toBeInTheDocument();
    expect(row).not.toHaveTextContent('Get a free key');
    // The allowance is a plan fact the reader budgets against — it stays
    // (user decision 2026-09-12).
    expect(row).toHaveTextContent('1000 searches a month, ~33 a day');
  });

  it('names the stored key by its fingerprint, never in full — and offers no input', async () => {
    await openSearchTab({
      ...geminiSettings,
      tavily_api_key_set: true,
      tavily_api_key_hint: 'tvly-…SeCS',
    });

    // The empty "replace" input kept reading as "no key stored" (user reports
    // 2026-09-12) — stored means a chip, and the only exit is Remove:
    // replacing is remove first, then add.
    expect(screen.getByTestId('settings-search-key-chip')).toHaveTextContent('tvly-…SeCS');
    expect(screen.queryByTestId('settings-search-key-input')).not.toBeInTheDocument();
  });

  it('masks the chip when the key is too short for a safe fingerprint', async () => {
    await openSearchTab({ ...geminiSettings, tavily_api_key_set: true });

    expect(screen.getByTestId('settings-search-key-chip')).toHaveTextContent('tvly-••••••••');
  });

  it('saves the typed key with its own Save button', async () => {
    vi.mocked(api.updateSettings).mockResolvedValue({ ...geminiSettings, tavily_api_key_set: true });
    await openSearchTab();

    fireEvent.change(screen.getByTestId('settings-search-key-input'), {
      target: { value: 'tvly-typed-here' },
    });
    fireEvent.click(screen.getByTestId('settings-search-save'));

    // ONLY the key — the search tab must not resave the provider or the model.
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ tavily_api_key: 'tvly-typed-here' }),
    );
  });

  it('keeps Save out of reach while the field is empty', async () => {
    // The input exists only while NO key is stored (stored shows the chip),
    // so an accidental empty save can only happen here.
    await openSearchTab();

    expect(screen.getByTestId('settings-search-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('settings-search-key-input'), { target: { value: '  ' } });
    expect(screen.getByTestId('settings-search-save')).toBeDisabled();
  });

  it('offers to remove a stored key, and only then sends an empty one', async () => {
    vi.mocked(api.updateSettings).mockResolvedValue({ ...geminiSettings, tavily_api_key_set: false });
    await openSearchTab({ ...geminiSettings, tavily_api_key_set: true });

    fireEvent.click(screen.getByTestId('settings-search-remove'));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ tavily_api_key: '' }));
  });

  it('has nothing to remove when no key is stored', async () => {
    await openSearchTab();

    expect(screen.queryByTestId('settings-search-remove')).not.toBeInTheDocument();
  });
});

// ── Local library (grill 2026-10-27, decisions 2–10; design/mockup-local-
// library.html §01 A, §02 A, §03 A, §04 A, §05 A) ────────────────────────────
// The settings are the library: the machine's facts, the model that fits
// them with a download IN the app, and the installed models with Remove.
describe('SettingsModal – local library', () => {
  async function openLibrary() {
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    return screen.findByTestId('recommended-card');
  }

  it('names the machine and the model that fits it, with a download door', async () => {
    const card = await openLibrary();

    // §08 C: label, then a chip for the machine (vendor prefix dropped, full
    // name in the tooltip) and a chip for its memory.
    expect(screen.getByTestId('hardware-line')).toHaveTextContent('Your machine');
    expect(screen.getByTestId('hardware-machine')).toHaveTextContent('RTX 5080 Laptop GPU');
    expect(screen.getByTestId('hardware-machine')).toHaveAttribute('data-tip', 'NVIDIA GeForce RTX 5080 Laptop GPU');
    expect(screen.getByTestId('hardware-memory')).toHaveTextContent('16 GB graphics memory');
    expect(card).toHaveTextContent('qwen3.5:9b');
    expect(card).toHaveTextContent('6.6 GB download');
    expect(screen.getByTestId('download-recommended')).toHaveTextContent('Download');
    // The models that would also fit get their own door below the card.
    expect(screen.getByTestId('download-gemma4:12b')).toBeInTheDocument();
    // No more "do it in the terminal".
    expect(screen.queryByTestId('pull-hint')).not.toBeInTheDocument();
  });

  it('downloads in the app, shows progress, and then offers the switch — never switches by itself (decision 8)', async () => {
    vi.mocked(api.pullOllamaModel).mockImplementation(async (_name, onProgress) => {
      onProgress({ status: 'pulling abc', total: 1000, completed: 400 });
      return { ready: true, contextLength: 32768 };
    });
    vi.mocked(api.updateSettings).mockResolvedValue({ ...geminiSettings, llm_provider: 'ollama', ollama_model: 'qwen3.5:9b' });
    const onSaved = vi.fn();
    render(<SettingsModal open onClose={vi.fn()} onSaved={onSaved} initialTab="model" />);
    await screen.findByTestId('recommended-card');

    fireEvent.click(screen.getByTestId('download-recommended'));

    // Ready: the card says so, names the baked window, and offers the switch.
    const ready = await screen.findByTestId('switch-local');
    expect(screen.getByTestId('recommended-card')).toHaveTextContent('32k');
    expect(api.updateSettings).not.toHaveBeenCalled();

    fireEvent.click(ready);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ llm_provider: 'ollama', ollama_model: 'qwen3.5:9b' }));
    expect(onSaved).toHaveBeenCalled();
  });

  it('reports a failed download in words, with the door still open', async () => {
    vi.mocked(api.pullOllamaModel).mockResolvedValue({ ready: false, contextLength: null, error: 'pull model manifest: file does not exist' });
    await openLibrary();

    fireEvent.click(screen.getByTestId('download-recommended'));

    expect(await screen.findByText(/file does not exist/)).toBeInTheDocument();
    expect(screen.getByTestId('download-recommended')).toBeInTheDocument();
  });

  it('keeps the recommendation visible without Ollama and turns the door into "Install Ollama" (decision 10)', async () => {
    vi.mocked(api.getRecommendation).mockResolvedValue({ ...rtx5080, ollamaReachable: false });
    const card = await openLibrary();

    expect(card).toHaveTextContent('qwen3.5:9b');
    expect(screen.queryByTestId('download-recommended')).not.toBeInTheDocument();
    expect(screen.getByTestId('install-ollama')).toHaveAttribute('href', 'https://ollama.com/download');
    // Linux: the one-line installer, ready to copy.
    expect(screen.getByTestId('install-command')).toHaveTextContent('curl -fsSL https://ollama.com/install.sh | sh');
  });

  it('offers the smallest model as a slower CPU fallback when no GPU memory is usable', async () => {
    vi.mocked(api.getRecommendation).mockResolvedValue({
      hardware: { platform: 'darwin', totalMemGb: 16, basis: 'cpu', usableGb: 0, gpu: null },
      ollamaReachable: true,
      recommended: { ...recommendedModel, name: 'qwen3.5:4b', label: 'Qwen 3.5 4B', downloadGb: 3.3, fitsGb: 6.8, minMemoryGb: 0, fits: false },
      alsoFits: [],
    });
    const card = await openLibrary();

    expect(screen.getByTestId('hardware-machine')).toHaveTextContent('no GPU detected');
    expect(screen.getByTestId('hardware-machine')).not.toHaveAttribute('data-tip');
    expect(screen.getByTestId('hardware-memory')).toHaveTextContent('16 GB RAM');
    expect(card).toHaveTextContent('qwen3.5:4b');
    expect(card).toHaveTextContent(/slower/i);
  });

  // §07 C (user feedback 2026-10-31): every model appears exactly once. Once
  // the recommended model is installed, the card goes and its row carries
  // the badge; the model in use carries the same green marker as the
  // provider card in step 1 — a marker, not something that looks like a
  // button.
  it('shows each model once: the installed recommended model is a badged row, not a second card', async () => {
    vi.mocked(api.getRecommendation).mockResolvedValue({ ...rtx5080, recommended: { ...recommendedModel, installed: true } });
    vi.mocked(api.getOllamaModels).mockResolvedValue([
      { name: 'llama3.2-vision:11b', parameter_size: '10.7B', canThink: false },
      { name: 'qwen3.5:9b', parameter_size: '9.7B', canThink: true },
    ]);
    vi.mocked(api.deleteOllamaModel).mockResolvedValue(undefined);
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    const row = await screen.findByTestId('library-row-qwen3.5:9b');

    // The badge arrives with the recommendation, a beat after the rows.
    await waitFor(() => expect(row).toHaveTextContent(/recommended/i));
    expect(screen.queryByTestId('recommended-card')).not.toBeInTheDocument();
    expect(row).toHaveTextContent('can think');
    expect(screen.getByTestId('library-row-llama3.2-vision:11b')).toHaveTextContent('Active');
    expect(row).not.toHaveTextContent('Active');
    // The recommended model sits first.
    const names = screen.getAllByRole('radio').map(r => r.getAttribute('data-testid'));
    expect(names).toEqual(['library-row-qwen3.5:9b', 'library-row-llama3.2-vision:11b']);

    fireEvent.click(screen.getByRole('button', { name: /remove qwen3.5:9b/i }));
    await waitFor(() => expect(api.deleteOllamaModel).toHaveBeenCalledWith('qwen3.5:9b'));
  });

  // §07 C: the local list selects like the cloud list in step 2 — a radio
  // row arms the Activate button at the bottom, which saves provider + model.
  it('selects a local model like the cloud list: a radio row, saved by Activate at the bottom', async () => {
    vi.mocked(api.getOllamaModels).mockResolvedValue([
      { name: 'llama3.2-vision:11b', parameter_size: '10.7B', canThink: false },
      { name: 'qwen3.5:9b', parameter_size: '9.7B', canThink: true },
    ]);
    vi.mocked(api.updateSettings).mockResolvedValue({ ...ollamaSettings, ollama_model: 'qwen3.5:9b' });
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    const row = await screen.findByTestId('library-row-qwen3.5:9b');
    const activate = screen.getByRole('button', { name: /^activate$/i });

    expect(screen.getByTestId('library-row-llama3.2-vision:11b')).toHaveAttribute('aria-checked', 'true');
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(activate).toBeDisabled();

    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(activate).toBeEnabled();

    fireEvent.click(activate);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ llm_provider: 'ollama', ollama_model: 'qwen3.5:9b' }));
    await waitFor(() => expect(screen.getByTestId('library-row-qwen3.5:9b')).toHaveTextContent('Active'));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText(/switched from the chat composer/i)).not.toBeInTheDocument();
  });

  it('lists the models that would also fit as download rows in the same list, without a radio', async () => {
    vi.mocked(api.getOllamaModels).mockResolvedValue([{ name: 'qwen3.5:9b', parameter_size: '9.7B', canThink: true }]);
    vi.mocked(api.getRecommendation).mockResolvedValue({ ...rtx5080, recommended: { ...recommendedModel, installed: true } });
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    await screen.findByTestId('library-row-qwen3.5:9b');

    const gemma = await screen.findByTestId('library-row-gemma4:12b');
    expect(gemma).not.toHaveAttribute('role', 'radio');
    expect(gemma).toHaveTextContent(/fits too/i);
    expect(screen.getByTestId('download-gemma4:12b')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });

  // A model pulled in the terminal sits at Ollama's default window (4096 on
  // cards under 24 GB, measured after its first load) — a paper would not
  // fit. The row says so and offers the same bake the download path does.
  it('flags an installed model with a small window and offers the 32k door', async () => {
    vi.mocked(api.getOllamaModels).mockResolvedValue([
      { name: 'gemma4:12b', parameter_size: '12B', canThink: true, contextLength: 4096 },
      { name: 'qwen3.5:9b', parameter_size: '9.7B', canThink: true, contextLength: 32768 },
      { name: 'llama3.2-vision:11b', canThink: false, contextLength: null },
    ]);
    vi.mocked(api.setOllamaContextLength).mockResolvedValue({ model: 'gemma4:12b', contextLength: 32768 });
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    await screen.findByTestId('library-row-gemma4:12b');

    expect(screen.getByTestId('window-gemma4:12b')).toHaveTextContent('4k window');
    expect(screen.getByTestId('window-qwen3.5:9b')).toHaveTextContent('32k window');
    expect(screen.getByTestId('window-llama3.2-vision:11b')).toHaveTextContent('not measured');
    expect(screen.queryByTestId('set-window-qwen3.5:9b')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('set-window-gemma4:12b'));

    await waitFor(() => expect(api.setOllamaContextLength).toHaveBeenCalledWith('gemma4:12b'));
    await waitFor(() => expect(screen.getByTestId('window-gemma4:12b')).toHaveTextContent('32k window'));
    expect(screen.queryByTestId('set-window-gemma4:12b')).not.toBeInTheDocument();
  });

});

// ─── Custom instructions (Grill 2026-07-23, Mockup Variante A · State 4) ─────
// Dritter Tab "Instructions": Freitext + An/Aus-Switch, expliziter Save-Knopf
// (kein Auto-Save — halb getippte Anweisungen dürfen nie in den Prompt).

describe('SettingsModal – custom instructions (Instructions tab)', () => {
  const savedSettings: Settings = {
    ...ollamaSettings,
    custom_instructions: 'Correct my German after every answer.',
    custom_instructions_enabled: true,
  };

  async function openInstructionsTab(settings: Settings = savedSettings) {
    vi.mocked(api.getSettings).mockResolvedValue(settings);
    render(<SettingsModal open={true} onClose={vi.fn()} />);
    await screen.findByText('Theme');
    fireEvent.click(screen.getByRole('button', { name: /instructions/i }));
  }

  it('shows the saved text, the switch and a character counter', async () => {
    await openInstructionsTab();

    const textarea = screen.getByRole('textbox', { name: /custom instructions/i });
    expect(textarea).toHaveValue('Correct my German after every answer.');
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByText('37 / 2000')).toBeInTheDocument();
    // Kein Activate hier — der Instructions-Tab hat einen eigenen Save-Knopf.
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
  });

  it('keeps Save disabled until text or switch changes', async () => {
    await openInstructionsTab();

    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole('switch'));
    expect(save).toBeEnabled();
  });

  it('saves text and toggle via updateSettings and reports back', async () => {
    const updated: Settings = {
      ...savedSettings,
      custom_instructions: 'Use simple words.',
      custom_instructions_enabled: false,
    };
    vi.mocked(api.updateSettings).mockResolvedValue(updated);
    const onSaved = vi.fn();
    vi.mocked(api.getSettings).mockResolvedValue(savedSettings);
    render(<SettingsModal open={true} onClose={vi.fn()} onSaved={onSaved} />);
    await screen.findByText('Theme');
    fireEvent.click(screen.getByRole('button', { name: /instructions/i }));

    fireEvent.change(screen.getByRole('textbox', { name: /custom instructions/i }), {
      target: { value: 'Use simple words.' },
    });
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        custom_instructions: 'Use simple words.',
        custom_instructions_enabled: false,
      })
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    // Nach dem Speichern ist der Stand wieder sauber — Save deaktiviert sich.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('caps the textarea at 2000 characters', async () => {
    await openInstructionsTab();

    expect(
      screen.getByRole('textbox', { name: /custom instructions/i })
    ).toHaveAttribute('maxlength', '2000');
  });
});

// ─── App language (Grill 2026-07-24, Mockup Variante A · State 5) ────────────
// Vierter Tab "Language": Segmented-Auswahl English/Deutsch (Labels immer in
// der eigenen Sprache), wirkt sofort wie Themes (kein Activate), plus
// Read-only-Zeile fürs Diktat (Auto-Detect, ADR-0004).

describe('SettingsModal – App language (Language tab)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function openLanguageTab() {
    render(<SettingsModal open={true} onClose={vi.fn()} />);
    // Sprachrobust: das Modal kann je nach gespeicherter App language schon
    // deutsch rendern (Theme → Farbschema, Language → Sprache).
    await screen.findByText(/^(Theme|Farbschema)$/);
    fireEvent.click(screen.getByRole('button', { name: /^(Language|Sprache)$/ }));
  }

  it('offers English and Deutsch, each labeled in its own language, with no Activate', async () => {
    await openLanguageTab();

    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deutsch' })).toBeInTheDocument();
    // Wie Themes: sofortige Wirkung, kein Activate/Save auf diesem Tab.
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  it('applies a choice instantly by persisting it to localStorage', async () => {
    await openLanguageTab();

    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }));

    expect(localStorage.getItem('syflo.appLanguage')).toBe('de');
  });

  it('marks the stored language as selected', async () => {
    localStorage.setItem('syflo.appLanguage', 'de');
    await openLanguageTab();

    expect(screen.getByRole('button', { name: 'Deutsch' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows dictation as a read-only automatic row', async () => {
    await openLanguageTab();

    expect(screen.getByText('Dictation')).toBeInTheDocument();
    expect(screen.getByText('Automatic · German + English')).toBeInTheDocument();
    // Read-only: keine Auswahl, kein Switch fürs Diktat (ADR-0004).
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

// ─── Deutsche UI (strings.ts, Grill 2026-07-24) ──────────────────────────────
// Mit App language = Deutsch rendert das ganze Modal-Chrome deutsch; die
// Sprach-Labels selbst ("English"/"Deutsch") bleiben in der eigenen Sprache.

describe('SettingsModal – German App language', () => {
  it('renders the modal chrome in German when the App language is German', async () => {
    localStorage.setItem('syflo.appLanguage', 'de');
    render(<SettingsModal open={true} onClose={vi.fn()} />);
    await screen.findByText('Farbschema');

    expect(screen.getByText('Einstellungen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /erscheinungsbild/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sprache' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /anweisungen/i })).toBeInTheDocument();
    // X-Knopf (aria) und Footer-Knopf heißen beide "Schließen".
    expect(screen.getAllByRole('button', { name: /schließen/i })).toHaveLength(2);

    // Die Sprach-Optionen bleiben immer in ihrer eigenen Sprache.
    fireEvent.click(screen.getByRole('button', { name: 'Sprache' }));
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deutsch' })).toBeInTheDocument();
  });

  it('re-renders instantly from English to German when Deutsch is picked', async () => {
    render(<SettingsModal open={true} onClose={vi.fn()} />);
    await screen.findByText('Theme');
    fireEvent.click(screen.getByRole('button', { name: /language/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Deutsch' }));

    // Sofortige Wirkung: das Chrome springt ohne Neuladen auf Deutsch um.
    expect(screen.getByText('Einstellungen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sprache' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /schließen/i }).length).toBeGreaterThan(0);
  });
});

// ─── Eye toggle on the key field (user report 2026-07-25) ────────────────────
// A saved key is never sent back to the frontend, so with an empty field the
// eye has nothing to reveal — it must only appear while something is typed.

describe('SettingsModal – key field eye toggle', () => {
  it('shows the eye only while a key is being typed, and toggles visibility', async () => {
    vi.mocked(api.getSettings).mockResolvedValue(geminiSettings);
    render(<SettingsModal open onClose={vi.fn()} initialTab="model" />);
    await screen.findByTestId('provider-card-gemini');

    // Empty field: no eye button (nothing to reveal).
    expect(screen.queryByRole('button', { name: /show api key/i })).not.toBeInTheDocument();

    const input = screen.getByPlaceholderText(/AIza|sk-|…/i);
    fireEvent.change(input, { target: { value: 'AIza-typed' } });

    // Typing reveals the toggle; clicking it flips password → text.
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: /show api key/i }));
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: /hide api key/i }));
    expect(input).toHaveAttribute('type', 'password');
  });
});
