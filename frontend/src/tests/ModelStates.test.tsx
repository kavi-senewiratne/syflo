/**
 * tests/ModelStates.test.tsx
 *
 * Six states, six words — and two groups (design/mockup-onboarding-flow.html
 * §02, step 11, chosen 2026-08-15).
 *
 * Two measured complaints drive this file:
 *
 *  1. "Gerade nicht nutzbar" covered everything, so on a fresh install the
 *     picker read like a damage report. Nothing is broken there — nothing is
 *     set up. "Noch einzurichten" therefore stays a group of its own.
 *  2. "Countdown vorbei, Limit trotzdem erschöpft": when a wait ran out the
 *     row went green again although nothing had been checked. That state now
 *     has its own word — "Status unknown" — and its own gray badge.
 */

import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelPicker, type PickerGroup } from '../components/ChatArea/ModelPicker';
import { api } from '../api';

// One cloud group now (cost is a word on the row, not a group): the picker
// itself splits it into "usable now" and "not usable right now".
const GROUPS: PickerGroup[] = [
  {
    tier: 'usable',
    models: [
      { name: 'gemini-flash-latest', label: 'Gemini Flash', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 20 },
      { name: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 500 },
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

const openMenu = () => fireEvent.click(screen.getByTestId('model-pill'));

let cooldownsSpy: ReturnType<typeof vi.spyOn>;
let usageSpy: ReturnType<typeof vi.spyOn>;

function mockCooldowns(list: { provider: string; model: string; until: string; kind?: string }[]) {
  cooldownsSpy.mockResolvedValue(list);
}

beforeEach(() => {
  defaultProps.onSelectModel.mockClear();
  defaultProps.onOpenSettings.mockClear();
  cooldownsSpy = vi.spyOn(api, 'getQuotaCooldowns').mockResolvedValue([]);
  usageSpy = vi.spyOn(api, 'getUsageSummary').mockResolvedValue({
    month: '2026-08', pricesAsOf: '2026-08-15', providers: {}, modelsToday: {}, kindsToday: {},
  });
});
afterEach(() => {
  cooldownsSpy.mockRestore();
  usageSpy.mockRestore();
});

describe('state: status unknown (an expired wait)', () => {
  it('shows a gray "status unknown" badge and keeps the row selectable', async () => {
    // The backend keeps an expired entry as kind 'unknown' — the wait is over,
    // nothing was measured. Green would be a lie, amber would claim a wait
    // that no longer exists, so the badge is neutral gray.
    mockCooldowns([{
      provider: 'gemini',
      model: 'gemini-flash-latest',
      until: new Date(Date.now() - 60_000).toISOString(),
      kind: 'unknown',
    }]);
    render(<ModelPicker {...defaultProps} />);
    openMenu();

    const badge = await screen.findByTestId('model-cooldown-gemini-flash-latest');
    expect(badge).toHaveTextContent('Status unknown');
    expect(badge.className).toContain('border-gray-200');
    expect(badge.className).toContain('bg-gray-50');
    expect(badge.className).toContain('text-gray-500');
    expect(badge.className).not.toContain('amber');

    const row = screen.getByTestId('model-item-gemini-flash-latest');
    expect(row).toHaveAttribute(
      'title',
      'The wait is over, but nothing has been checked. The next question settles it.',
    );
    // Selectable on purpose: sending is exactly what settles the question.
    expect(row).not.toBeDisabled();
    fireEvent.click(row);
    expect(defaultProps.onSelectModel).toHaveBeenCalledWith('gemini', 'gemini-flash-latest');
  });
});

describe('state: daily limit reached', () => {
  it('names the clock time it is back, in the reader’s timezone', async () => {
    // Gemini's daily quota resets at Pacific midnight, so the moment lands at
    // an arbitrary hour of the local evening. "6h 12m" was a countdown to
    // nothing the reader could plan around; the wall-clock time is.
    const until = new Date(Date.now() + (6 * 60 + 12) * 60_000);
    const expected = until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    mockCooldowns([{
      provider: 'gemini', model: 'gemini-flash-latest', until: until.toISOString(), kind: 'daily',
    }]);
    render(<ModelPicker {...defaultProps} />);
    openMenu();

    const badge = await screen.findByTestId('model-cooldown-gemini-flash-latest');
    expect(badge).toHaveTextContent(`daily limit · back at ${expected}`);
    // No bare remaining time anywhere on the row, and no usage meter either:
    // a spent quota is not a fill level to admire.
    expect(badge).not.toHaveTextContent(/\d+h \d+m/);
    expect(screen.queryByTestId('model-quota-gemini-flash-latest')).not.toBeInTheDocument();
  });
});

describe('two groups: "usable now" and "not usable right now"', () => {
  it('sorts a cooling, an unknown and a retired model into the second group', async () => {
    mockCooldowns([
      { provider: 'groq', model: 'openai/gpt-oss-120b', until: new Date(Date.now() + 30_000).toISOString(), kind: 'minute' },
      { provider: 'gemini', model: 'gemini-pro-latest', until: new Date(Date.now() + 8 * 3600_000).toISOString(), kind: 'retired' },
      { provider: 'gemini', model: 'gemini-flash-latest', until: new Date(Date.now() - 60_000).toISOString(), kind: 'unknown' },
    ]);
    render(<ModelPicker {...defaultProps} />);
    openMenu();

    const unavailable = await screen.findByTestId('picker-group-unavailable');
    expect(unavailable).toHaveTextContent('Not usable right now');
    // All three unusable states share one group — a wait, a question mark and
    // a switched-off model are all "not right now".
    expect(within(unavailable).getByTestId('model-item-openai/gpt-oss-120b')).toBeInTheDocument();
    expect(within(unavailable).getByTestId('model-item-gemini-pro-latest')).toBeInTheDocument();
    expect(within(unavailable).getByTestId('model-item-gemini-flash-latest')).toBeInTheDocument();

    // What is left keeps the positive name — the picker reads as a list of
    // what works, not as a damage report.
    const usable = screen.getByTestId('picker-group-usable');
    expect(usable).toHaveTextContent('Usable now');
    expect(within(usable).getByTestId('model-item-gemini-flash-lite-latest')).toBeInTheDocument();
    expect(within(usable).queryByTestId('model-item-gemini-flash-latest')).not.toBeInTheDocument();
  });
});

describe('cost is a word on the row, not a group', () => {
  it('states provider, cost tier and image ability in the subline', () => {
    render(<ModelPicker {...defaultProps} />);
    openMenu();

    // Mockup §02/§07 row: "Gemini · kostenlos · liest Bilder". Cost stopped
    // being a group because it never answered "will this answer me now?".
    expect(screen.getByTestId('model-item-gemini-flash-latest')).toHaveTextContent('Gemini · free');
    expect(screen.getByTestId('model-item-openai/gpt-oss-120b'))
      .toHaveTextContent("Groq · free · can't read images");
    expect(screen.getByTestId('model-item-gemini-pro-latest'))
      .toHaveTextContent('Gemini · needs billing');
    // …and no cost-tier headline is left standing.
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
    expect(screen.queryByText('Requires billing')).not.toBeInTheDocument();
  });
});

// The core of the complaint: a provider that was never set up is NOT a
// provider that is broken. The two states keep two groups and two words.
const WITH_SETUP: PickerGroup[] = [
  {
    tier: 'usable',
    models: [
      { name: 'gemini-flash-latest', label: 'Gemini Flash', canThink: true, vision: true, provider: 'gemini', providerLabel: 'Gemini', free: true, requestsPerDay: 20 },
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

describe('"to set up" stays a group of its own', () => {
  it('never merges the keyless provider into "not usable right now"', async () => {
    // The one model that IS set up is in an unknown state, so both groups
    // exist side by side — the moment where the old single bucket lied.
    mockCooldowns([
      {
        provider: 'gemini', model: 'gemini-flash-latest',
        until: new Date(Date.now() - 60_000).toISOString(), kind: 'unknown',
      },
      // Groq's model carries a stale entry from a key that has since been
      // removed. A quota word must not drag a never-set-up provider into the
      // damage report — it has no key, so nothing about it is a limit.
      {
        provider: 'groq', model: 'openai/gpt-oss-120b',
        until: new Date(Date.now() + 30_000).toISOString(), kind: 'minute',
      },
    ]);
    render(<ModelPicker {...defaultProps} groups={WITH_SETUP} />);
    openMenu();

    const unavailable = await screen.findByTestId('picker-group-unavailable');
    expect(within(unavailable).getByTestId('model-item-gemini-flash-latest')).toBeInTheDocument();
    // Groq is not broken and not waiting — it was simply never set up.
    expect(within(unavailable).queryByTestId('setup-item-groq')).not.toBeInTheDocument();

    const setup = screen.getByTestId('picker-group-setup');
    expect(setup).toHaveTextContent('To set up');
    expect(within(setup).getByTestId('setup-item-groq')).toHaveTextContent('Set up');
  });
});

describe('the unusable group only exists when it has members', () => {
  it('is missing entirely on a fresh install, where "to set up" carries everything', async () => {
    // First start: no answer has failed yet, so there is nothing to report as
    // unusable. A headline over an empty list is what made the picker read
    // like a damage report.
    render(<ModelPicker {...defaultProps} groups={WITH_SETUP} />);
    openMenu();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('picker-group-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Not usable right now')).not.toBeInTheDocument();
    expect(screen.getByTestId('picker-group-setup')).toBeInTheDocument();
  });
});

describe('the pill claims a limit only when there is one', () => {
  it('stays plain while the active model is merely in an unknown state', async () => {
    // The amber clock says "at its limit, answers fail over" — for an
    // unchecked model that is the same false certainty the countdown had.
    mockCooldowns([{
      provider: 'gemini', model: 'gemini-flash-latest',
      until: new Date(Date.now() - 60_000).toISOString(), kind: 'unknown',
    }]);
    render(<ModelPicker {...defaultProps} />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('pill-cooling-dot')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-pill'))
      .toHaveAttribute('title', 'Switch model (gemini-flash-latest)');
  });
});
