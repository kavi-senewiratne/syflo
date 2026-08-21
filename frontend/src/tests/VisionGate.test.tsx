/**
 * tests/VisionGate.test.tsx
 *
 * The vision gate at ATTACH time (design/mockup-onboarding-flow.html §04,
 * V1+V2): attaching an image the active model cannot read must say so before
 * the question is typed, not after it was sent.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import { getStrings } from '../strings';
import type { ChatDetail, VisionGate } from '../types';

const S = getStrings().chatArea;

const mockChat: ChatDetail = {
  id: '1',
  title: 'Test Chat',
  parent_id: null,
  parent_word: null,
  created_at: new Date().toISOString(),
  messages: [],
  children: [],
};

const defaultProps = {
  loading: false,
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

const ACTIVE_LABEL = 'Llama 3.3 70B';

const switchGate: VisionGate = {
  activeReadsImages: false,
  activeLabel: ACTIVE_LABEL,
  switchTarget: { provider: 'gemini', model: 'gemini-flash-lite', label: 'Gemini Flash Lite' },
  setupOptions: [],
};

// V2: nothing configured reads images, so there is no switch target at all.
const setupGate: VisionGate = {
  activeReadsImages: false,
  activeLabel: ACTIVE_LABEL,
  switchTarget: null,
  setupOptions: [
    {
      kind: 'cloud',
      provider: 'gemini',
      model: 'gemini-flash-lite',
      label: 'Gemini Flash Lite',
      requestsPerDay: 500,
    },
    { kind: 'local', provider: 'ollama', model: 'qwen3.5:9b', label: 'qwen3.5:9b', size: '5,4 GB' },
  ],
};

// jsdom has no object-URL factory; the composer makes one per image preview.
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});

/** Drops an image into the composer the way the file picker does. */
function attachImage(name = 'photo.png') {
  const input = screen.getByTestId('media-file-input');
  const file = new File(['x'], name, { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('vision gate at attach time', () => {
  it('warns next to the attachment chip and offers the configured vision model', () => {
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={switchGate}
        onSwitchVisionModel={vi.fn()}
      />,
    );

    attachImage();

    expect(screen.getByTestId('vision-warning-chip')).toHaveTextContent(
      S.visionChipWarning(ACTIVE_LABEL),
    );
    expect(screen.getByText(S.visionSwitchTitle)).toBeInTheDocument();
    expect(screen.getByTestId('vision-switch-button')).toHaveTextContent(
      S.visionSwitchAction('Gemini Flash Lite'),
    );
  });

  it('switches the model without losing the attachment or the typed question', () => {
    const onSwitchVisionModel = vi.fn();
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={switchGate}
        onSwitchVisionModel={onSwitchVisionModel}
      />,
    );

    attachImage();
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: 'What does this figure show?' } });

    fireEvent.click(screen.getByTestId('vision-switch-button'));

    expect(onSwitchVisionModel).toHaveBeenCalledWith(switchGate.switchTarget);
    expect(screen.getByTestId('attachment-alias')).toHaveTextContent('@foto1');
    expect(textarea).toHaveValue('What does this figure show?');
  });

  it('drops the attachment on "remove image", taking chip and card with it', () => {
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={switchGate}
        onSwitchVisionModel={vi.fn()}
      />,
    );

    attachImage();
    fireEvent.click(screen.getByTestId('vision-remove-image'));

    expect(screen.queryByTestId('attachment-alias')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-warning-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-switch-card')).not.toBeInTheDocument();
  });

  it('lists the models that could be set up when none reads images yet', () => {
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={setupGate}
        onOpenSettingsForProvider={vi.fn()}
      />,
    );

    attachImage();

    expect(screen.queryByTestId('vision-switch-card')).not.toBeInTheDocument();
    expect(screen.getByText(S.visionNoneTitle)).toBeInTheDocument();
    expect(screen.getByText(S.visionNoneBody)).toBeInTheDocument();

    const cloudRow = screen.getByTestId('vision-setup-row-gemini-flash-lite');
    expect(cloudRow).toHaveTextContent('Gemini Flash Lite');
    expect(cloudRow).toHaveTextContent(S.visionCloudRow(500));
    expect(cloudRow).toHaveTextContent(S.visionSetupBadge);

    const localRow = screen.getByTestId('vision-setup-row-qwen3.5:9b');
    expect(localRow).toHaveTextContent(S.visionLocalRow('5,4 GB'));
    expect(localRow).toHaveTextContent(S.visionLoadBadge);

    expect(screen.getByTestId('vision-ask-anyway')).toHaveTextContent(S.visionAskAnyway);
  });

  it('opens the settings of the provider whose cloud row was clicked', () => {
    const onOpenSettingsForProvider = vi.fn();
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={setupGate}
        onOpenSettingsForProvider={onOpenSettingsForProvider}
      />,
    );

    attachImage();
    fireEvent.click(screen.getByTestId('vision-setup-row-gemini-flash-lite'));

    expect(onOpenSettingsForProvider).toHaveBeenCalledWith('gemini');
  });

  it('drops every image on "ask anyway" and keeps the typed question', () => {
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={setupGate}
        onOpenSettingsForProvider={vi.fn()}
      />,
    );

    attachImage('figure-1.png');
    attachImage('figure-2.png');
    const textarea = screen.getByPlaceholderText(/Ask anything/i);
    fireEvent.change(textarea, { target: { value: 'Explain the attention formula' } });

    fireEvent.click(screen.getByTestId('vision-ask-anyway'));

    expect(screen.queryAllByTestId('attachment-alias')).toHaveLength(0);
    expect(screen.queryByTestId('vision-none-card')).not.toBeInTheDocument();
    expect(textarea).toHaveValue('Explain the attention formula');
  });

  it('stays silent when the active model reads images', () => {
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={{ ...switchGate, activeReadsImages: true }}
        onSwitchVisionModel={vi.fn()}
      />,
    );

    attachImage();

    expect(screen.queryByTestId('vision-warning-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-switch-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-none-card')).not.toBeInTheDocument();
  });

  it('stays silent for a non-image attachment, which reaches the model as text', () => {
    render(
      <ChatArea
        chat={mockChat}
        {...defaultProps}
        visionGate={switchGate}
        onSwitchVisionModel={vi.fn()}
      />,
    );

    const input = screen.getByTestId('media-file-input');
    fireEvent.change(input, {
      target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] },
    });

    expect(screen.getByTestId('attachment-alias')).toBeInTheDocument();
    expect(screen.queryByTestId('vision-warning-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('vision-switch-card')).not.toBeInTheDocument();
  });
});
