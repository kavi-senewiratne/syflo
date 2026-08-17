/**
 * HighlightsDrawer.test.tsx
 *
 * Drawer über der Chat-Spalte (design/mockup-highlights-overview.html,
 * Variante A, Grill-Entscheidungen 2026-07-21):
 * - Gruppen nach Color label in fester Farbreihenfolge, leere ausgeblendet
 * - Chips: Mehrfachauswahl, "All" (mit Gesamtzahl) setzt zurück
 * - Karten: Zitat, Quelle (PDF · p. N / Chat · Branch-Name), Klick springt
 * - Esc schließt; Rechtsklick auf Karte öffnet das Aktions-Menü (Callback)
 * - Empty State bei 0 Highlights
 */

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';
import { HighlightsDrawer } from '../components/HighlightsDrawer';
import { _resetTreeHighlightsCacheForTests } from '../hooks/useTreeHighlights';
import { _resetLabelsCacheForTests } from '../hooks/useLabels';
import type { TreeHighlight } from '../types';

vi.mock('../api', () => ({
  api: {
    listTreeHighlights: vi.fn(),
    getHighlightLabels: vi.fn(),
  },
}));

const items: TreeHighlight[] = [
  {
    kind: 'pdf', id: 'h-1', color: 'yellow', text: 'CB-MCTS', paperId: 'paper-1',
    pageNumber: 3, rects: [{ left: 10, top: 20, width: 100, height: 14 }],
    chatId: null, createdAt: '2026-07-16T10:00:00.000Z', updatedAt: '2026-07-16T10:00:00.000Z',
  },
  {
    kind: 'pdf', id: 'h-2', color: 'yellow', text: 'page five insight', paperId: 'paper-1',
    pageNumber: 5, rects: [{ left: 10, top: 20, width: 100, height: 14 }],
    chatId: null, createdAt: '2026-07-17T10:00:00.000Z', updatedAt: '2026-07-17T10:00:00.000Z',
  },
  {
    kind: 'chat', id: 'mh-1', color: 'orange', text: 'annealed', chatId: 'branch-1',
    chatTitle: 'entropy bonus', childChatId: null, messageId: 'msg-1', startOffset: 22, endOffset: 30,
    createdAt: '2026-07-19T10:00:00.000Z', updatedAt: '2026-07-19T10:00:00.000Z',
  },
];

const noop = () => {};

function renderDrawer(overrides: Partial<Parameters<typeof HighlightsDrawer>[0]> = {}) {
  return render(
    <HighlightsDrawer
      chatId="root"
      onClose={noop}
      onJump={noop}
      onItemContextMenu={noop}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetTreeHighlightsCacheForTests();
  _resetLabelsCacheForTests();
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.listTreeHighlights).mockResolvedValue(items);
});

describe('HighlightsDrawer', () => {
  it('gruppiert nach Color label, blendet leere Gruppen aus, zeigt Quellen', async () => {
    renderDrawer();

    // Gruppenköpfe: Important (2× yellow) und Disagree (1× orange) — die
    // Farben ohne Highlights (Agree/Reference/Question) haben keine Gruppe.
    expect(await screen.findByRole('heading', { name: /Important/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Disagree/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Agree/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Reference/ })).toBeNull();

    // Karten mit Zitat und Quelle.
    expect(screen.getByText('CB-MCTS')).toBeInTheDocument();
    expect(screen.getByText('PDF · p. 3')).toBeInTheDocument();
    expect(screen.getByText('annealed')).toBeInTheDocument();
    expect(screen.getByText('Chat · entropy bonus')).toBeInTheDocument();
  });

  it('filtert per Chips mit Mehrfachauswahl; "All" setzt zurück', async () => {
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('CB-MCTS');

    // Nur "Disagree" → die Important-Gruppe verschwindet.
    await user.click(screen.getByRole('button', { name: /Disagree/ }));
    expect(screen.queryByText('CB-MCTS')).toBeNull();
    expect(screen.getByText('annealed')).toBeInTheDocument();

    // "Important" dazuschalten (Mehrfachauswahl) → beide Gruppen sichtbar.
    await user.click(screen.getByRole('button', { name: /Important/ }));
    expect(screen.getByText('CB-MCTS')).toBeInTheDocument();
    expect(screen.getByText('annealed')).toBeInTheDocument();

    // "All" (trägt die Gesamtzahl) setzt die Auswahl zurück.
    const allChip = screen.getByRole('button', { name: /All 3/ });
    await user.click(allChip);
    expect(allChip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('CB-MCTS')).toBeInTheDocument();
  });

  it('blasst nicht gewählte Chips ab, solange gefiltert wird (2026-08-02)', async () => {
    // Gleicher Stil wie die Leiste über der MindMap
    // (design/mockup-mindmap-lens-final.html §04): aktiver Chip mit
    // Akzentrahmen, nicht gewählte verblassen — aber NUR wenn gefiltert wird.
    const user = userEvent.setup();
    renderDrawer();
    await screen.findByText('CB-MCTS');

    const important = screen.getByRole('button', { name: /Important/ });
    const disagree = screen.getByRole('button', { name: /Disagree/ });
    // "All" aktiv: kein Chip ist ausgegraut.
    expect(important.className).not.toMatch(/opacity-40/);
    expect(disagree.className).not.toMatch(/opacity-40/);

    await user.click(disagree);
    expect(disagree.className).toMatch(/border-blue-600/);
    expect(important.className).toMatch(/opacity-40/);
  });

  it('hebt die Karte hervor, auf die ein MindMap-Klick gesprungen ist', async () => {
    renderDrawer({ focusHighlightId: 'mh-1' });
    await screen.findByText('annealed');
    const card = screen.getByText('annealed').closest('button')!;
    expect(card.className).toMatch(/border-blue-600/);
  });

  it('springt beim Klick auf eine Karte (onJump mit dem Item)', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    renderDrawer({ onJump });

    await user.click(await screen.findByText('annealed'));
    expect(onJump).toHaveBeenCalledWith(items[2]);
  });

  it('öffnet das Aktions-Menü per Rechtsklick auf eine Karte', async () => {
    const onItemContextMenu = vi.fn();
    renderDrawer({ onItemContextMenu });

    fireEvent.contextMenu(await screen.findByText('CB-MCTS'), { clientX: 40, clientY: 50 });
    expect(onItemContextMenu).toHaveBeenCalledWith(items[0], 40, 50);
  });

  it('schließt mit Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDrawer({ onClose });
    await screen.findByText('CB-MCTS');

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('zeigt den Empty State ohne Highlights', async () => {
    vi.mocked(api.listTreeHighlights).mockResolvedValue([]);
    renderDrawer();

    expect(
      await screen.findByText(/No highlights yet — select text and right-click to highlight\./),
    ).toBeInTheDocument();
  });
});
