import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import { getStrings } from '../strings';
import type { ChatDetail } from '../types';

// First run, variant O2 (design/mockup-onboarding-flow.html §03, chosen
// 2026-08-15). Until now `setupNotice` replaced the whole composer row, so the
// very first start of the app had no text field, no attach button, no dictation
// and no model pill — the app was sealed before the user could see what a key
// would even be for. O2 keeps the composer usable and locks only sending.

const mockChat: ChatDetail = {
  id: '1',
  title: 'Attention Is All You Need',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [],
  children: [],
};

const S = getStrings().chatArea;

const baseProps = {
  chat: mockChat,
  loading: false,
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

// The mic button only mounts with a microphone available; jsdom has none.
beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
  baseProps.onSendMessage.mockClear();
});

afterEach(() => {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
});

describe('First run (O2) — the composer stays usable', () => {
  it('keeps text field, attach button and dictation while the setup card is up', () => {
    render(
      <ChatArea
        {...baseProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
        onUploadPdf={vi.fn()}
      />,
    );

    const textarea = screen.getByTestId('chat-textarea');
    expect(textarea).toBeInTheDocument();
    expect(textarea).not.toBeDisabled();
    expect(screen.getByTestId('attach-plus-button')).not.toBeDisabled();
    expect(screen.getByTestId('mic-button')).not.toBeDisabled();

    // Usable, not just present: typing lands in the field.
    fireEvent.change(textarea, { target: { value: 'What is an attention head?' } });
    expect(textarea).toHaveValue('What is an attention head?');
  });

  it('shows the notice strip above the composer and opens the path choice on click', () => {
    const onOpenSetup = vi.fn();
    render(
      <ChatArea
        {...baseProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
        onOpenSetup={onOpenSetup}
      />,
    );

    const strip = screen.getByTestId('first-run-strip');
    expect(strip).toHaveTextContent(S.firstRunBanner);
    expect(strip).toHaveTextContent(S.firstRunBannerAction);

    fireEvent.click(strip);
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });

  it('locks the send button and explains it, even with a question typed', () => {
    render(
      <ChatArea
        {...baseProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
        onOpenSetup={vi.fn()}
      />,
    );

    const send = screen.getByTestId('send-button');
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('data-tip', S.firstRunSendTip);
    expect(send).toHaveAttribute('aria-label', S.firstRunSendTip);

    // Typed text normally enables the button — here it must not.
    fireEvent.change(screen.getByTestId('chat-textarea'), { target: { value: 'Why?' } });
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('answers Enter with the path choice and leaves the typed question standing', async () => {
    const onOpenSetup = vi.fn();
    render(
      <ChatArea
        {...baseProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
        onOpenSetup={onOpenSetup}
      />,
    );

    const textarea = screen.getByTestId('chat-textarea');
    // Focus like a real typist: the window-level Enter handler steps aside for
    // a focused field, so this counts the composer's own Enter exactly once.
    (textarea as HTMLTextAreaElement).focus();
    fireEvent.change(textarea, { target: { value: 'What is an attention head?' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    expect(baseProps.onSendMessage).not.toHaveBeenCalled();
    // The work already done must survive the detour into the setup.
    expect(textarea).toHaveValue('What is an attention head?');
  });

  it('puts a setup button where the model pill would sit', () => {
    const onOpenSetup = vi.fn();
    render(
      <ChatArea
        {...baseProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
        onOpenSetup={onOpenSetup}
        modelPicker={<div data-testid="model-picker-slot" />}
      />,
    );

    // Replaced, not hidden: the slot where a model is chosen keeps carrying
    // the way to choose one.
    expect(screen.queryByTestId('model-picker-slot')).not.toBeInTheDocument();
    const pill = screen.getByTestId('first-run-model-pill');
    expect(pill).toHaveTextContent(S.firstRunPillLabel);

    fireEvent.click(pill);
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });
});

describe('Without a setup card nothing changes', () => {
  it('sends normally, shows no strip and keeps the real model pill', async () => {
    const onOpenSetup = vi.fn();
    render(
      <ChatArea
        {...baseProps}
        onOpenSetup={onOpenSetup}
        modelPicker={<div data-testid="model-picker-slot" />}
      />,
    );

    expect(screen.queryByTestId('first-run-strip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('first-run-model-pill')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-picker-slot')).toBeInTheDocument();

    const textarea = screen.getByTestId('chat-textarea');
    (textarea as HTMLTextAreaElement).focus();
    fireEvent.change(textarea, { target: { value: 'Hello!' } });
    expect(screen.getByTestId('send-button')).not.toBeDisabled();
    expect(screen.getByTestId('send-button')).toHaveAttribute('data-tip', S.send);

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    await waitFor(() =>
      expect(baseProps.onSendMessage).toHaveBeenCalledWith('Hello!', [], undefined, null),
    );
    expect(onOpenSetup).not.toHaveBeenCalled();
  });
});

describe('The path card moved, it did not go away', () => {
  it('renders the card ABOVE the composer, both in the DOM at once', () => {
    render(
      <ChatArea
        {...baseProps}
        setupNotice={<div data-testid="setup-notice-slot" />}
        onOpenSetup={vi.fn()}
      />,
    );

    const card = screen.getByTestId('setup-notice-slot');
    const textarea = screen.getByTestId('chat-textarea');
    expect(card).toBeInTheDocument();
    expect(textarea).toBeInTheDocument();

    // "Above" in document order — the card precedes the composer inside the
    // shared composer shell.
    const shell = screen.getByTestId('chat-input-shell');
    expect(shell).toContainElement(card);
    expect(shell).toContainElement(textarea);
    expect(card.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
