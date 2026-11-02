/**
 * HighlightsDrawerHtml.test.tsx
 *
 * The HTML source's marks are the fourth kind in the tree-wide drawer
 * (ADR-0013): quote, source line "HTML · <section>", click jumps, right-click
 * opens the actions menu.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api';
import { HighlightsDrawer } from '../components/HighlightsDrawer';
import { _resetTreeHighlightsCacheForTests } from '../hooks/useTreeHighlights';
import { _resetLabelsCacheForTests } from '../hooks/useLabels';
import type { TreeHighlight } from '../types';

vi.mock('../api', () => ({
  api: { listTreeHighlights: vi.fn(), getHighlightLabels: vi.fn() },
}));

const html: TreeHighlight = {
  kind: 'html', id: 'k1', color: 'pink', text: 'Pendel mit Motor', htmlSourceId: 'h1',
  anchor: { exact: 'Pendel mit Motor', prefix: 'Das ', suffix: ' ist' },
  section: '1.2 Pendel', chatId: null,
  createdAt: '2026-09-29T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetTreeHighlightsCacheForTests();
  _resetLabelsCacheForTests();
  vi.mocked(api.getHighlightLabels).mockResolvedValue({ yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree' });
  vi.mocked(api.listTreeHighlights).mockResolvedValue([html]);
});

describe('HighlightsDrawer, HTML marks', () => {
  it('shows the quote with its section as the source line', async () => {
    render(<HighlightsDrawer chatId="root" onClose={() => {}} onJump={() => {}} onItemContextMenu={() => {}} />);
    expect(await screen.findByText('Pendel mit Motor')).toBeInTheDocument();
    expect(screen.getByText('HTML · 1.2 Pendel')).toBeInTheDocument();
  });

  it('jumps and opens the menu with the html item', async () => {
    const onJump = vi.fn();
    const onItemContextMenu = vi.fn();
    render(<HighlightsDrawer chatId="root" onClose={() => {}} onJump={onJump} onItemContextMenu={onItemContextMenu} />);
    const card = (await screen.findByText('Pendel mit Motor')).closest('button')!;
    fireEvent.click(card);
    expect(onJump).toHaveBeenCalledWith(html);
    fireEvent.contextMenu(card, { clientX: 5, clientY: 6 });
    expect(onItemContextMenu).toHaveBeenCalledWith(html, 5, 6);
  });
});
