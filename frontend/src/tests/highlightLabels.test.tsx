/**
 * highlightLabels.test.tsx
 *
 * The name of a highlight color has two sources (user request 2026-08-06):
 * the App language supplies the DEFAULT, the database supplies the user's own
 * rename — and the rename wins in every language. These tests pin both halves
 * plus the new category set (Unclear/Key point/Definition/Idea/Doubt).
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setAppLanguage } from '../appLanguage';
import { useLabels, _resetLabelsCacheForTests } from '../hooks/useLabels';
import { HIGHLIGHT_COLORS } from '../types';

vi.mock('../api', () => ({
  api: {
    getHighlightLabels: vi.fn(),
    setHighlightLabel: vi.fn(),
  },
}));

import { api } from '../api';

const NO_OVERRIDES = {
  yellow: null, green: null, blue: null, pink: null, orange: null,
};

// Minimal consumer: renders one row per color so the assertions can read the
// resolved names straight out of the DOM.
function LabelList() {
  const { labels } = useLabels();
  return (
    <ul>
      {HIGHLIGHT_COLORS.map((c) => (
        <li key={c} data-testid={`label-${c}`}>{labels[c]}</li>
      ))}
    </ul>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetLabelsCacheForTests();
  localStorage.clear();
  vi.mocked(api.getHighlightLabels).mockResolvedValue({ ...NO_OVERRIDES });
  vi.mocked(api.setHighlightLabel).mockImplementation(async (color, label) => ({
    color,
    label: label.trim() || null,
  }));
});

describe('highlight label defaults follow the App language', () => {
  it('shows the German categories when the app language is German', async () => {
    setAppLanguage('de');
    render(<LabelList />);
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Unklar'));
    expect(screen.getByTestId('label-green')).toHaveTextContent('Kernaussage');
    expect(screen.getByTestId('label-blue')).toHaveTextContent('Definition');
    expect(screen.getByTestId('label-pink')).toHaveTextContent('Idee');
    expect(screen.getByTestId('label-orange')).toHaveTextContent('Zweifel');
  });

  it('shows the English categories when the app language is English', async () => {
    setAppLanguage('en');
    render(<LabelList />);
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Unclear'));
    expect(screen.getByTestId('label-green')).toHaveTextContent('Key point');
    expect(screen.getByTestId('label-orange')).toHaveTextContent('Doubt');
  });

  it('switches the names live when the language changes', async () => {
    setAppLanguage('en');
    render(<LabelList />);
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Unclear'));
    setAppLanguage('de');
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Unklar'));
  });

  it('never shows the retired categories', async () => {
    setAppLanguage('en');
    render(<LabelList />);
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Unclear'));
    for (const retired of ['Important', 'Agree', 'Disagree', 'Reference', 'Question']) {
      expect(screen.queryByText(retired)).toBeNull();
    }
  });
});

describe('a rename beats the language default', () => {
  it('keeps the stored name in both languages', async () => {
    vi.mocked(api.getHighlightLabels).mockResolvedValue({
      ...NO_OVERRIDES,
      yellow: 'Nachfragen',
    });
    setAppLanguage('de');
    render(<LabelList />);
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Nachfragen'));
    // Other colors still follow the language …
    expect(screen.getByTestId('label-green')).toHaveTextContent('Kernaussage');
    // … and the override survives the switch to English.
    setAppLanguage('en');
    await waitFor(() => expect(screen.getByTestId('label-green')).toHaveTextContent('Key point'));
    expect(screen.getByTestId('label-yellow')).toHaveTextContent('Nachfragen');
  });

  it('falls back to the language default when the rename is cleared', async () => {
    function Harness() {
      const { labels, renameLabel } = useLabels();
      return (
        <>
          <span data-testid="label-yellow">{labels.yellow}</span>
          <button onClick={() => void renameLabel('yellow', '  ')}>reset</button>
        </>
      );
    }
    vi.mocked(api.getHighlightLabels).mockResolvedValue({ ...NO_OVERRIDES, yellow: 'Nachfragen' });
    setAppLanguage('de');
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Nachfragen'));
    screen.getByRole('button', { name: 'reset' }).click();
    await waitFor(() => expect(screen.getByTestId('label-yellow')).toHaveTextContent('Unklar'));
    expect(api.setHighlightLabel).toHaveBeenCalledWith('yellow', '  ');
  });
});
