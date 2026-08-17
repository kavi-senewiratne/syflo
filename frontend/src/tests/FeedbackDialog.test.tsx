/**
 * FeedbackDialog — sidebar button + /feedback composer command (ADR-0010).
 * Kind chip (Bug/Idea/Question) + text + optional reply-to email, sent via
 * api.sendFeedback. Text only — no attachments (Web3Forms free tier gates
 * those behind a paid plan).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../api', () => ({
  api: { sendFeedback: vi.fn(), getFeedbackIssuesUrl: vi.fn() },
}));

import { api } from '../api';
import { FeedbackDialog } from '../components/FeedbackDialog';

beforeEach(() => {
  vi.mocked(api.sendFeedback).mockReset();
  vi.mocked(api.getFeedbackIssuesUrl).mockReset();
  vi.mocked(api.getFeedbackIssuesUrl).mockResolvedValue('https://github.com/kavi-senewiratne/syflo/issues');
});

describe('FeedbackDialog', () => {
  it('sends the selected kind and typed text, then shows a confirmation', async () => {
    vi.mocked(api.sendFeedback).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<FeedbackDialog open onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Idea' }));
    await user.type(screen.getByPlaceholderText('What happened, or what would help?'), 'Dark mode for the mind map');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.sendFeedback).toHaveBeenCalledWith('idea', 'Dark mode for the mind map', undefined));
    expect(await screen.findByText('Feedback sent — thank you!')).toBeInTheDocument();
  });

  it('defaults to Bug and includes the optional email', async () => {
    vi.mocked(api.sendFeedback).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<FeedbackDialog open onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('What happened, or what would help?'), 'Picker closes too fast');
    await user.type(screen.getByPlaceholderText('you@example.com'), 'me@example.com');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(api.sendFeedback).toHaveBeenCalledWith('bug', 'Picker closes too fast', 'me@example.com'));
  });

  it('offers the GitHub issues page as fallback when sending fails', async () => {
    // Hybrid feedback (2026-08-08): Web3Forms down, key rotated, or quota
    // exhausted must degrade to a link, never to a dead end.
    vi.mocked(api.sendFeedback).mockRejectedValue(new Error('quota'));
    const user = userEvent.setup();
    render(<FeedbackDialog open onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('What happened, or what would help?'), 'It broke');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Could not send feedback. Please try again.')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: 'Open a GitHub issue instead' });
    expect(link).toHaveAttribute('href', 'https://github.com/kavi-senewiratne/syflo/issues');
  });

  it('picks up initialText when opened from an already-mounted, previously-closed instance', () => {
    // App.tsx keeps ONE FeedbackDialog instance mounted the whole time and
    // just flips `open` — useState(initialText) only seeds on first mount,
    // so a later open with new initialText was silently ignored (bug found
    // live 2026-08-02: "/feedback hello" opened the dialog with an empty
    // textarea).
    const { rerender } = render(<FeedbackDialog open={false} onClose={vi.fn()} initialText="" />);
    rerender(<FeedbackDialog open onClose={vi.fn()} initialText="hello" />);

    expect(screen.getByPlaceholderText('What happened, or what would help?')).toHaveValue('hello');
  });

  it('resets to a blank Bug-kind form each time it reopens, discarding the previous session', async () => {
    const user = userEvent.setup();
    vi.mocked(api.sendFeedback).mockResolvedValue(undefined);
    const { rerender } = render(<FeedbackDialog open onClose={vi.fn()} initialText="" />);

    await user.click(screen.getByRole('button', { name: 'Idea' }));
    await user.type(screen.getByPlaceholderText('What happened, or what would help?'), 'first note');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Feedback sent — thank you!')).toBeInTheDocument();

    rerender(<FeedbackDialog open={false} onClose={vi.fn()} initialText="" />);
    rerender(<FeedbackDialog open onClose={vi.fn()} initialText="" />);

    expect(screen.getByRole('button', { name: 'Bug' })).toHaveClass('bg-blue-600');
    expect(screen.getByPlaceholderText('What happened, or what would help?')).toHaveValue('');
    expect(screen.queryByText('Feedback sent — thank you!')).not.toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<FeedbackDialog open={false} onClose={vi.fn()} />);
    expect(screen.queryByText('Send feedback')).not.toBeInTheDocument();
  });

  it('calls onClose when Cancel is clicked, without sending', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<FeedbackDialog open onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalled();
    expect(api.sendFeedback).not.toHaveBeenCalled();
  });
});
