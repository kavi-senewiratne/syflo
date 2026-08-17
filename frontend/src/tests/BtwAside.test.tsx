import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import type { ChatDetail } from '../types';

/**
 * /btw — the throwaway side question
 * (design/mockup-btw-composer-fold.html).
 *
 * The whole feature is defined by what the transcript does NOT get: the
 * question never becomes a message, and the answer lives in a panel above
 * the composer until the next keystroke removes it.
 */

const mockChat: ChatDetail = {
  id: '1',
  title: 'Attention Is All You Need',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [
    { id: 'm1', chat_id: '1', role: 'user', content: 'Why divide by the square root of d_k?', created_at: new Date().toISOString() },
    { id: 'm2', chat_id: '1', role: 'assistant', content: 'Because the dot products grow with dimension.', created_at: new Date().toISOString() },
  ],
  children: [],
};

const defaultProps = {
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

describe('/btw side question', () => {
  beforeEach(() => {
    defaultProps.onSendMessage.mockClear();
  });

  it('asks a side question instead of sending a chat message', async () => {
    const onAskAside = vi.fn();
    render(<ChatArea chat={mockChat} loading={false} {...defaultProps} onAskAside={onAskAside} />);
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: '/btw what does logit mean again?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    await waitFor(() => expect(onAskAside).toHaveBeenCalledWith('what does logit mean again?'));
    expect(defaultProps.onSendMessage).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('');
  });

  it('shows the question and the answer in the panel above the composer', () => {
    render(
      <ChatArea
        chat={mockChat}
        loading={false}
        {...defaultProps}
        aside={{ question: 'what does logit mean again?', answer: 'A raw, unnormalised score.', streaming: false }}
      />
    );
    expect(screen.getByText('what does logit mean again?')).toBeInTheDocument();
    expect(screen.getByText(/A raw, unnormalised score\./)).toBeInTheDocument();
    // The transcript is untouched — the aside is not a message.
    expect(screen.getAllByText(/what does logit mean again\?/)).toHaveLength(1);
  });

  // Section 02 of the mockup: three ways out, none of them explained in the
  // UI. All three do exactly the same thing, so there is one disappearance
  // to learn rather than three behaviours.
  describe('every way out', () => {
    const answered = { question: 'what does logit mean again?', answer: 'A raw score.', streaming: false };

    it('disappears on the first keystroke in the composer', () => {
      const onDismissAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onDismissAside={onDismissAside} />
      );
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: 'S' } });
      expect(onDismissAside).toHaveBeenCalled();
    });

    it('disappears on Escape', () => {
      const onDismissAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onDismissAside={onDismissAside} />
      );
      fireEvent.keyDown(screen.getByPlaceholderText(/Ask anything/i), { key: 'Escape' });
      expect(onDismissAside).toHaveBeenCalled();
    });

    // The panel outlives a trip to the settings, so by the time Escape is
    // pressed the composer usually no longer has focus. A key handler on the
    // textarea alone never sees that press — the listener has to be global.
    it('disappears on Escape after the composer lost focus', () => {
      const onDismissAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onDismissAside={onDismissAside} />
      );
      screen.getByPlaceholderText(/Ask anything/i).blur();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onDismissAside).toHaveBeenCalled();
    });

    // Escape peels one layer at a time: with a dialog on top, the press
    // belongs to the dialog. Losing the answer as collateral damage of
    // closing the settings is not one of the three ways out (bug 2026-08-09).
    it('survives Escape while a dialog is open on top', () => {
      const onDismissAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onDismissAside={onDismissAside} />
      );
      const overlay = document.createElement('div');
      overlay.setAttribute('data-overlay', '');
      document.body.appendChild(overlay);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onDismissAside).not.toHaveBeenCalled();

      // Once the dialog is gone, the next Escape reaches the panel.
      overlay.remove();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onDismissAside).toHaveBeenCalled();
    });

    it('disappears on the × in the header', () => {
      const onDismissAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onDismissAside={onDismissAside} />
      );
      fireEvent.click(screen.getByTestId('btw-dismiss'));
      expect(onDismissAside).toHaveBeenCalled();
    });

    // Clicking into the input to read the answer while getting ready to type
    // must not cost the answer — only a character that changes the text does.
    it('survives focus alone', () => {
      const onDismissAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onDismissAside={onDismissAside} />
      );
      fireEvent.focus(screen.getByPlaceholderText(/Ask anything/i));
      expect(onDismissAside).not.toHaveBeenCalled();
    });
  });

  // Section 03: exactly two actions, and only once the answer is complete —
  // there is nothing to keep or branch from half an answer.
  describe('the two actions', () => {
    const answered = { question: 'what does logit mean again?', answer: 'A raw score.', streaming: false };

    it('offers Keep in chat and Make a branch when the answer is done', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={answered} onKeepAside={vi.fn()} onBranchAside={vi.fn()}
        />
      );
      expect(screen.getByRole('button', { name: /Keep in chat/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Make a branch/i })).toBeInTheDocument();
    });

    it('hides both while the answer is still streaming', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{ ...answered, answer: 'A raw', streaming: true }}
          onKeepAside={vi.fn()} onBranchAside={vi.fn()}
        />
      );
      expect(screen.queryByRole('button', { name: /Keep in chat/i })).not.toBeInTheDocument();
      // The header corner stays empty: no × on a half answer (Escape is the
      // exit) and no second set of dots either — the answer field already
      // carries the loading signal (user decision 2026-08-11).
      expect(screen.queryByTestId('btw-dismiss')).not.toBeInTheDocument();
      expect(screen.queryByTestId('btw-streaming')).not.toBeInTheDocument();
    });

    // Before the first token there is nothing in the answer field, and an
    // empty field does not say whether anything is happening — so the chat's
    // own bouncing dots stand in until text arrives (user request 2026-08-11).
    it('shows the bouncing dots in the answer field until the first token', () => {
      const { rerender } = render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{ question: 'what does logit mean again?', answer: '', streaming: true }}
        />
      );
      expect(screen.getByTestId('btw-answer').querySelector('.syflo-typing')).toBeTruthy();

      rerender(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{ question: 'what does logit mean again?', answer: 'A raw', streaming: true }}
        />
      );
      expect(screen.getByTestId('btw-answer').querySelector('.syflo-typing')).toBeNull();
      expect(screen.getByTestId('btw-answer')).toHaveTextContent('A raw');
    });

    // A narrow chat column drops both labels and keeps only the icons (user
    // request 2026-08-11). The meaning has to survive that: an own tooltip
    // carries it on hover — not `title`, which stayed invisible in the running
    // window — and the accessible name stays the full wording, which is why
    // the queries above keep working at every width.
    it('carries the full wording as its own tooltip, not as title', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={answered} onKeepAside={vi.fn()} onBranchAside={vi.fn()}
        />
      );
      expect(screen.getByTestId('btw-keep')).toHaveAttribute('data-tip', 'Keep in chat');
      expect(screen.getByTestId('btw-branch')).toHaveAttribute('data-tip', 'Make a branch');
      // Not `title`: that one stayed invisible in the running window.
      expect(screen.getByTestId('btw-keep')).not.toHaveAttribute('title');
    });

    it('reports the click on Keep in chat', () => {
      const onKeepAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} aside={answered} onKeepAside={onKeepAside} onBranchAside={vi.fn()} />
      );
      fireEvent.click(screen.getByRole('button', { name: /Keep in chat/i }));
      expect(onKeepAside).toHaveBeenCalled();
    });
  });

  // Section 05: the switch happens without asking; the panel only says who
  // answered — and only when it was not the chat's own model.
  describe('automatic model switch', () => {
    // Same wording and same look as the note above a chat answer — a switch
    // reads identically wherever it happens (user request 2026-08-08).
    it('speaks the same sentence the chat uses when the provider stayed', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{
            question: 'q', answer: 'A raw score.', streaming: false,
            model: { was: 'gemini-2.5-flash', answered: 'gemini-flash-lite', fromProvider: 'gemini', toProvider: 'gemini' },
          }}
        />
      );
      const note = screen.getByTestId('btw-failover-note');
      expect(note).toHaveTextContent('Quota reached on gemini-2.5-flash — this answer comes from gemini-flash-lite.');
    });

    it('names the providers when the ladder crossed to another one', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          providerLabels={{ gemini: 'Gemini', groq: 'Groq' }}
          aside={{
            question: 'q', answer: 'A raw score.', streaming: false,
            model: { was: 'gemini-2.5-flash', answered: 'llama-3.3-70b', fromProvider: 'gemini', toProvider: 'groq' },
          }}
        />
      );
      expect(screen.getByTestId('btw-failover-note')).toHaveTextContent(/Gemini.*Groq.*llama-3\.3-70b/);
    });

    it('says nothing in the normal case', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{ question: 'q', answer: 'A raw score.', streaming: false, model: null }}
        />
      );
      expect(screen.queryByTestId('btw-failover-note')).not.toBeInTheDocument();
    });
  });

  // Section 04: a long answer is capped and scrolls; past the threshold the
  // two buttons swap so the branch — not the keep — is the obvious exit.
  describe('long answers', () => {
    const long = 'x'.repeat(950);

    it('makes Make a branch the primary action once the answer is no longer an aside', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{ question: 'walk me through the architecture', answer: long, streaming: false }}
          onKeepAside={vi.fn()} onBranchAside={vi.fn()}
        />
      );
      const buttons = screen.getAllByRole('button', { name: /Keep in chat|Make a branch/i });
      expect(buttons[0]).toHaveAccessibleName(/Make a branch/i);
    });

    it('keeps Keep in chat first for a short answer', () => {
      render(
        <ChatArea
          chat={mockChat} loading={false} {...defaultProps}
          aside={{ question: 'q', answer: 'A raw score.', streaming: false }}
          onKeepAside={vi.fn()} onBranchAside={vi.fn()}
        />
      );
      const buttons = screen.getAllByRole('button', { name: /Keep in chat|Make a branch/i });
      expect(buttons[0]).toHaveAccessibleName(/Keep in chat/i);
    });
  });

  // Section 00: typing "/" offers the commands, exactly as /feedback already
  // does — that menu is where a user discovers /btw in the first place.
  describe('the slash menu', () => {
    it('offers /btw next to /feedback while typing the slash', () => {
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onAskAside={vi.fn()} onOpenFeedback={vi.fn()} />
      );
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: '/' } });
      expect(screen.getByTestId('slash-item-btw')).toBeInTheDocument();
      expect(screen.getByTestId('slash-item-feedback')).toBeInTheDocument();
    });

    it('narrows to /btw once the command word is unambiguous', () => {
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onAskAside={vi.fn()} onOpenFeedback={vi.fn()} />
      );
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: '/b' } });
      expect(screen.getByTestId('slash-item-btw')).toBeInTheDocument();
      expect(screen.queryByTestId('slash-item-feedback')).not.toBeInTheDocument();
    });

    // /btw needs its question, so picking it fills the command in and leaves
    // the cursor there — unlike /feedback, which opens its dialog right away.
    it('fills the composer with the command instead of sending anything', () => {
      const onAskAside = vi.fn();
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onAskAside={onAskAside} onOpenFeedback={vi.fn()} />
      );
      const textarea = screen.getByPlaceholderText(/Ask anything/i);
      fireEvent.change(textarea, { target: { value: '/' } });
      fireEvent.click(screen.getByTestId('slash-item-btw'));
      expect(textarea).toHaveValue('/btw ');
      expect(onAskAside).not.toHaveBeenCalled();
    });

    it('closes once a question is being typed', () => {
      render(
        <ChatArea chat={mockChat} loading={false} {...defaultProps} onAskAside={vi.fn()} onOpenFeedback={vi.fn()} />
      );
      fireEvent.change(screen.getByPlaceholderText(/Ask anything/i), { target: { value: '/btw what does' } });
      expect(screen.queryByTestId('slash-item-btw')).not.toBeInTheDocument();
    });
  });
});
