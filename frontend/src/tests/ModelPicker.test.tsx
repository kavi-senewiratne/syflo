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

// Tier groups (mockup-model-cost-tiers W2b, chosen 2026-07-30): cost tier
// is the grouping axis, the provider moves to the subline.
const GROUPS: PickerGroup[] = [
  {
    tier: 'free',
    label: 'Free',
    models: [
      { name: 'gemini-flash-latest', label: 'Gemini Flash', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 20 },
      { name: 'openai/gpt-oss-120b', label: 'gpt-oss 120B', canThink: false, vision: false, provider: 'groq', providerLabel: 'Groq', free: true },
    ],
  },
  {
    tier: 'paid',
    label: 'Requires billing',
    models: [
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
      month: '2026-07', pricesAsOf: '2026-07-30', providers: {}, modelsToday: {},
    });
  });
  afterEach(() => {
    cooldownsSpy.mockRestore();
    usageSpy.mockRestore();
  });

  it('groups models by cost tier with the provider on the subline', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.getByText('Requires billing')).toBeInTheDocument();
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
    expect(pro).toHaveTextContent('Billing required');
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

  it('a daily-cooling free row swaps the fraction for a countdown to the reset', async () => {
    cooldownsSpy.mockResolvedValue([
      { provider: 'gemini', model: 'gemini-flash-latest', until: new Date(Date.now() + (6 * 60 + 12) * 60_000).toISOString(), kind: 'daily' },
    ]);
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    expect(await screen.findByTestId('model-quota-gemini-flash-latest')).toHaveTextContent(/\d+h \d+m/);
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

  it('footer: green dot + honest cloud count while Ollama runs with models', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();
    const footer = screen.getByTestId('picker-provider-status');
    expect(footer).toHaveTextContent('Ollama running');
    expect(footer).toHaveTextContent('2 cloud providers set up');
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
