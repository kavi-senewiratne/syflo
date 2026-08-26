/**
 * tests/ModelPicker.test.tsx
 *
 * Composer model pill + grouped drop-up (design/mockup-model-flow.html §02–
 * §04). Core rules: one group per KEYED provider plus the local group,
 * selecting any row switches provider AND model in one click, cooldown
 * badges span all providers, the footer is honest about Ollama's state, and
 * the menu can open even where the pill is hidden.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelPicker, type PickerGroup } from '../components/ChatArea/ModelPicker';
import { api } from '../api';

// Availability groups (mockup-onboarding-flow §02, chosen 2026-08-15): one
// cloud bundle, cost and provider on the row. The picker splits off what is
// not usable right now — see ModelStates.test.tsx for that half.
const GROUPS: PickerGroup[] = [
  {
    tier: 'usable',
    models: [
      { name: 'gemini-flash-latest', label: 'Gemini Flash', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 20 },
      { name: 'openai/gpt-oss-120b', label: 'gpt-oss 120B', canThink: false, vision: false, provider: 'groq', providerLabel: 'Groq', free: true },
      { name: 'gemini-pro-latest', label: 'Gemini Pro', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: false },
    ],
  },
  {
    tier: 'local',
    provider: 'ollama',
    label: 'Local · Ollama',
    local: true,
    models: [{ name: 'qwen3.5:9b', parameter_size: '9.7B', canThink: true }],
  },
];

const defaultProps = {
  activeProvider: 'gemini' as const,
  activeModel: 'gemini-flash-latest',
  groups: GROUPS,
  ollamaReachable: true,
  cloudCount: 2,
  onSelectModel: vi.fn(),
  think: false,
  onToggleThink: vi.fn(),
  onOpenSettings: vi.fn(),
};

function openMenu() {
  fireEvent.click(screen.getByTestId('model-pill'));
}

let cooldownsSpy: ReturnType<typeof vi.spyOn>;
let usageSpy: ReturnType<typeof vi.spyOn>;

describe('ModelPicker (grouped)', () => {
  beforeEach(() => {
    defaultProps.onSelectModel.mockClear();
    defaultProps.onToggleThink.mockClear();
    defaultProps.onOpenSettings.mockClear();
    cooldownsSpy = vi.spyOn(api, 'getQuotaCooldowns').mockResolvedValue([]);
    usageSpy = vi.spyOn(api, 'getUsageSummary').mockResolvedValue({
      month: '2026-07', pricesAsOf: '2026-07-30', providers: {}, modelsToday: {}, kindsToday: {},
    });
  });
  afterEach(() => {
    cooldownsSpy.mockRestore();
    usageSpy.mockRestore();
  });

  it('groups models by availability with the provider on the subline', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(screen.getByText('Usable now')).toBeInTheDocument();
    expect(screen.getByText('Local · Ollama')).toBeInTheDocument();
    // The provider is no longer a group header — it lives on the row.
    expect(screen.getByTestId('model-item-gemini-flash-latest')).toHaveTextContent('Gemini');
    expect(screen.getByTestId('model-item-openai/gpt-oss-120b')).toHaveTextContent('Groq');
  });

  it('selecting any row switches provider AND model in one click', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    fireEvent.click(screen.getByTestId('model-item-qwen3.5:9b'));
    expect(defaultProps.onSelectModel).toHaveBeenCalledWith('ollama', 'qwen3.5:9b');
    expect(screen.queryByTestId('model-menu')).not.toBeInTheDocument();
  });

  it('paid rows carry the billing hint but stay selectable (escape hatch for keyed billing)', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    const pro = screen.getByTestId('model-item-gemini-pro-latest');
    // Mid-line the cost word is lower case (2026-08-21) — the group heading
    // keeps its capital, and this row's subline is mid-line.
    expect(pro).toHaveTextContent('needs billing');
    fireEvent.click(pro);
    expect(defaultProps.onSelectModel).toHaveBeenCalledWith('gemini', 'gemini-pro-latest');
  });

  it('free rows show a used/limit meter fed by the usage summary', async () => {
    usageSpy.mockResolvedValue({
      month: '2026-07', pricesAsOf: '2026-07-30', providers: {},
      modelsToday: { 'gemini/gemini-flash-latest': 17 },
    });
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(await screen.findByTestId('model-quota-gemini-flash-latest')).toHaveTextContent('17/20');
    // No requestsPerDay quota (Groq counts tokens, not requests) → no meter.
    expect(screen.queryByTestId('model-quota-openai/gpt-oss-120b')).not.toBeInTheDocument();
  });

  it('a daily-limited row drops its meter for the reset time (see ModelStates)', async () => {
    cooldownsSpy.mockResolvedValue([
      { provider: 'gemini', model: 'gemini-flash-latest', until: new Date(Date.now() + (6 * 60 + 12) * 60_000).toISOString(), kind: 'daily' },
    ]);
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(await screen.findByTestId('model-cooldown-gemini-flash-latest')).toHaveTextContent('daily limit');
    expect(screen.queryByTestId('model-quota-gemini-flash-latest')).not.toBeInTheDocument();
  });

  it('marks only the active (provider, model) pair as checked', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(screen.getByTestId('model-item-gemini-flash-latest')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('model-item-gemini-pro-latest')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('model-item-qwen3.5:9b')).toHaveAttribute('aria-checked', 'false');
  });

  it('labels text-only cloud models so the vision trap is visible before the click', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(screen.getByTestId('model-item-openai/gpt-oss-120b')).toHaveTextContent("can't read images");
    // Vision-capable rows carry no such label.
    expect(screen.getByTestId('model-item-gemini-pro-latest')).not.toHaveTextContent("can't read images");
  });

  it('shows cooldown badges across ALL providers, retired models without a time', async () => {
    cooldownsSpy.mockResolvedValue([
      { provider: 'groq', model: 'openai/gpt-oss-120b', until: new Date(Date.now() + 30_000).toISOString(), kind: 'minute' },
      { provider: 'gemini', model: 'gemini-pro-latest', until: new Date(Date.now() + 8 * 3600_000).toISOString(), kind: 'retired' },
    ]);
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(await screen.findByTestId('model-cooldown-openai/gpt-oss-120b')).toHaveTextContent(/back in \d+ s/);
    expect(screen.getByTestId('model-cooldown-gemini-pro-latest')).toHaveTextContent('no longer available');
  });

  it('footer: green dot + the free-provider gap while Ollama runs with models', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    const footer = screen.getByTestId('picker-provider-status');
    expect(footer).toHaveTextContent('Ollama running');
    // Measured in the running app: local state + cloud count + free count did
    // not fit the 288 px menu and truncated mid-word. The free count names a
    // gap the user can close, so it replaces the generic cloud count.
    expect(footer).toHaveTextContent('of 2 free providers set up');
    expect(footer).not.toHaveTextContent('cloud providers set up');
  });

  it('Ollama not reachable: dimmed local rows and a start hint that opens Settings', () => {
    render(<ModelPicker {...defaultProps} ollamaReachable={false} />);
    openMenu();
    expect(screen.getByTestId('model-item-qwen3.5:9b')).toBeDisabled();
    expect(screen.getByTestId('picker-provider-status')).toHaveTextContent('Ollama not reachable');
    fireEvent.click(screen.getByTestId('local-hint-row'));
    expect(defaultProps.onOpenSettings).toHaveBeenCalled();
  });

  it('Ollama running but zero vision models: distinguishes itself from "not reachable"', () => {
    const groups = GROUPS.map(g => (g.local ? { ...g, models: [] } : g));
    render(<ModelPicker {...defaultProps} groups={groups} />);
    openMenu();
    expect(screen.getByTestId('picker-provider-status')).toHaveTextContent('no vision-capable model installed');
    expect(screen.getByTestId('picker-provider-status')).not.toHaveTextContent('not reachable');
    expect(screen.getByTestId('local-hint-row')).toHaveTextContent('Install a vision-capable model');
  });

  it('pill shows the amber clock while the ACTIVE model cools down', async () => {
    cooldownsSpy.mockResolvedValue([
      { provider: 'gemini', model: 'gemini-flash-latest', until: new Date(Date.now() + 8 * 3600_000).toISOString(), kind: 'daily' },
    ]);
    render(<ModelPicker {...defaultProps} />);
    expect(await screen.findByTestId('pill-cooling-dot')).toBeInTheDocument();
  });

  it('no amber clock while only a sibling cools', async () => {
    cooldownsSpy.mockResolvedValue([
      { provider: 'gemini', model: 'gemini-pro-latest', until: new Date(Date.now() + 8 * 3600_000).toISOString(), kind: 'daily' },
    ]);
    render(<ModelPicker {...defaultProps} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('pill-cooling-dot')).not.toBeInTheDocument();
  });

  it('openSignal opens the menu on increment but not on remount with a stale counter', () => {
    const { rerender, unmount } = render(<ModelPicker {...defaultProps} openSignal={2} />);
    // Initial mount with a historic counter: stays closed.
    expect(screen.queryByTestId('model-menu')).not.toBeInTheDocument();
    rerender(<ModelPicker {...defaultProps} openSignal={3} />);
    expect(screen.getByTestId('model-menu')).toBeInTheDocument();
    unmount();
    // Fresh mount with the same counter (remount case): stays closed.
    render(<ModelPicker {...defaultProps} openSignal={3} />);
    expect(screen.queryByTestId('model-menu')).not.toBeInTheDocument();
  });

  it('narrow columns hide only the pill — the menu can still open via openSignal', () => {
    const { rerender } = render(<ModelPicker {...defaultProps} openSignal={0} />);
    // The container-query hidden class sits on the pill, not the wrapper.
    expect(screen.getByTestId('model-pill').className).toContain('@max-[19rem]:hidden');
    expect(screen.getByTestId('model-picker-root').className).not.toContain('@max-[19rem]:hidden');
    rerender(<ModelPicker {...defaultProps} openSignal={1} />);
    expect(screen.getByTestId('model-menu')).toBeInTheDocument();
  });

  // The chat pane carries overflow-hidden (ChatArea/index.tsx): as an
  // `absolute` child of the composer the 288 px menu lost everything left of
  // the column edge. Since the portal it hangs on the body instead.
  it('hangs the menu on the body so the chat column cannot clip it', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    const menu = screen.getByTestId('model-menu');
    expect(screen.getByTestId('model-picker-root')).not.toContainElement(menu);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).not.toContain('absolute');
    expect(menu.style.position).toBe('fixed');
  });

  it('offers the Thinking row only when the active model can think', () => {
    const { rerender } = render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(screen.getByTestId('thinking-row')).toHaveTextContent('Off');
    fireEvent.click(screen.getByTestId('thinking-row'));
    expect(defaultProps.onToggleThink).toHaveBeenCalled();

    rerender(<ModelPicker {...defaultProps} activeProvider="groq" activeModel="openai/gpt-oss-120b" />);
    expect(screen.queryByTestId('thinking-row')).not.toBeInTheDocument();
  });

  it('keeps the manage-models path to Settings', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    fireEvent.click(screen.getByTestId('manage-models-row'));
    expect(defaultProps.onOpenSettings).toHaveBeenCalled();
  });
});

// G3 (mockup-onboarding-flow §07, chosen 2026-08-15): a free provider without
// a key gets a permanent row of its own — numbers and limits, no nagging and
// no "recommended". The row is a door to Settings, never a model to pick.
const SETUP_GROUPS: PickerGroup[] = [
  {
    tier: 'usable',
    models: [
      { name: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 500 },
    ],
  },
  {
    tier: 'setup',
    label: 'To set up',
    models: [
      { name: 'openai/gpt-oss-120b', label: 'Groq', vision: false, provider: 'groq', providerLabel: 'Groq', free: true, tokensPerDay: 200000 },
    ],
  },
  {
    tier: 'local',
    provider: 'ollama',
    label: 'Local · Ollama',
    local: true,
    models: [{ name: 'qwen3.5:9b', parameter_size: '9.7B', canThink: true }],
  },
];

describe('ModelPicker (setup group)', () => {
  beforeEach(() => {
    defaultProps.onSelectModel.mockClear();
    defaultProps.onOpenSettings.mockClear();
    cooldownsSpy = vi.spyOn(api, 'getQuotaCooldowns').mockResolvedValue([]);
    usageSpy = vi.spyOn(api, 'getUsageSummary').mockResolvedValue({
      month: '2026-07', pricesAsOf: '2026-07-30', providers: {}, modelsToday: {}, kindsToday: {},
    });
  });
  afterEach(() => {
    cooldownsSpy.mockRestore();
    usageSpy.mockRestore();
  });

  it('names the provider with its free quota and what the quota is good for', () => {
    render(<ModelPicker {...defaultProps} groups={SETUP_GROUPS} />);
    openMenu();
    expect(screen.getByText('To set up')).toBeInTheDocument();
    const row = screen.getByTestId('setup-item-groq');
    expect(row).toHaveTextContent('Groq');
    expect(row).toHaveTextContent('free · 200,000 tokens a day');
    expect(row).toHaveTextContent('reserve once the daily limit is reached');
    expect(row).toHaveTextContent('Set up');
  });

  it('a click asks for that provider’s key instead of selecting a model', () => {
    const onSetupProvider = vi.fn();
    render(<ModelPicker {...defaultProps} groups={SETUP_GROUPS} onSetupProvider={onSetupProvider} />);
    openMenu();
    const row = screen.getByTestId('setup-item-groq');
    // Not a radio: nothing here is a choice between models.
    expect(row).toHaveAttribute('role', 'menuitem');
    fireEvent.click(row);
    expect(onSetupProvider).toHaveBeenCalledWith('groq');
    expect(defaultProps.onSelectModel).not.toHaveBeenCalled();
    expect(screen.queryByTestId('model-menu')).not.toBeInTheDocument();
  });

  it('falls back to the generic Settings path when no setup handler is wired', () => {
    render(<ModelPicker {...defaultProps} groups={SETUP_GROUPS} />);
    openMenu();
    fireEvent.click(screen.getByTestId('setup-item-groq'));
    expect(defaultProps.onOpenSettings).toHaveBeenCalled();
  });

  it('footer counts the free providers that are set up against those that exist', () => {
    render(<ModelPicker {...defaultProps} groups={SETUP_GROUPS} />);
    openMenu();
    expect(screen.getByTestId('picker-provider-status')).toHaveTextContent('1 of 2 free providers set up');
  });

  it('shows no usage meter on a setup row — nothing has been spent there yet', async () => {
    usageSpy.mockResolvedValue({
      month: '2026-07', pricesAsOf: '2026-07-30', providers: {},
      modelsToday: { 'groq/openai/gpt-oss-120b': 4 },
    });
    render(<ModelPicker {...defaultProps} groups={SETUP_GROUPS} />);
    openMenu();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('model-quota-openai/gpt-oss-120b')).not.toBeInTheDocument();
  });

  it('leaves out the image caveat for a setup provider that does read images', () => {
    const geminiToSet: PickerGroup[] = [
      {
        tier: 'setup',
        label: 'To set up',
        models: [
          { name: 'gemini-flash-lite-latest', label: 'Gemini', vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 500 },
        ],
      },
    ];
    render(<ModelPicker {...defaultProps} groups={geminiToSet} />);
    openMenu();
    const row = screen.getByTestId('setup-item-gemini');
    expect(row).toHaveTextContent('free · 500 questions a day');
    expect(row).not.toHaveTextContent("can't read images");
  });
});
