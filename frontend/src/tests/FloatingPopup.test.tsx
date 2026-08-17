import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FloatingPopup } from '../components/FloatingPopup';
import { _resetLabelsCacheForTests } from '../hooks/useLabels';
import type { WordPopup } from '../types';

// useLabels lädt die globalen Labels über den API-Client — gemockt, damit
// die Popup-Tests ohne Netz laufen und die Labels deterministisch sind.
vi.mock('../api', () => ({
  api: {
    getHighlightLabels: vi.fn().mockResolvedValue({
      yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
    }),
    setHighlightLabel: vi.fn(),
  },
}));

import { api } from '../api';

beforeEach(() => {
  vi.clearAllMocks();
  _resetLabelsCacheForTests();
  vi.mocked(api.getHighlightLabels).mockResolvedValue({
    yellow: 'Important', green: 'Agree', blue: 'Reference', pink: 'Question', orange: 'Disagree',
  });
  vi.mocked(api.setHighlightLabel).mockImplementation(async (color, label) => ({ color, label }));
});

const mockPopup: WordPopup = {
  word: 'quantum',
  context: 'Quantum physics is complex',
  x: 100,
  y: 100,
};

describe('FloatingPopup', () => {
  const defaultProps = {
    popup: mockPopup,
    explanation: 'Quantum refers to the smallest discrete unit of a phenomenon.',
    loading: false,
    onClose: vi.fn(),
    onOpenChildChat: vi.fn(),
  };

  it('renders nothing when popup is null', () => {
    const { container } = render(<FloatingPopup {...defaultProps} popup={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the word in the header', () => {
    render(<FloatingPopup {...defaultProps} />);
    expect(screen.getByText(/"quantum"/i)).toBeInTheDocument();
  });

  it('shows explanation text', () => {
    render(<FloatingPopup {...defaultProps} />);
    expect(screen.getByText(/Quantum refers to/i)).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<FloatingPopup {...defaultProps} loading={true} explanation="" />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('calls onClose when X button clicked', () => {
    const onClose = vi.fn();
    render(<FloatingPopup {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onOpenChildChat when branch button clicked', () => {
    const onOpenChildChat = vi.fn();
    render(<FloatingPopup {...defaultProps} onOpenChildChat={onOpenChildChat} />);
    fireEvent.click(screen.getByText(/Open as new chat/i));
    expect(onOpenChildChat).toHaveBeenCalledWith('quantum', 'Quantum physics is complex');
  });

  describe('Farb-Swatches (Slice 04, mockup-popup-edit-labels.html picker state)', () => {
    it('zeigt ohne onPickColor keine Farbzeile (Chat-Popups)', () => {
      render(<FloatingPopup {...defaultProps} />);
      expect(screen.queryByTestId('popup-color-section')).not.toBeInTheDocument();
    });

    it('zeigt fünf Swatches mit ihren Labels darunter', async () => {
      render(<FloatingPopup {...defaultProps} onPickColor={vi.fn()} />);
      expect(screen.getByTestId('popup-color-section')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByText('Important')).toBeInTheDocument());
      for (const label of ['Important', 'Agree', 'Reference', 'Question', 'Disagree']) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    it('Klick auf einen Swatch ruft onPickColor mit der Farbe auf', async () => {
      const onPickColor = vi.fn();
      render(<FloatingPopup {...defaultProps} onPickColor={onPickColor} />);
      await waitFor(() => expect(screen.getByText('Agree')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /highlight as agree/i }));
      expect(onPickColor).toHaveBeenCalledWith('green');
    });

    it('markiert activeColor mit Ring und Häkchen', async () => {
      render(<FloatingPopup {...defaultProps} onPickColor={vi.fn()} activeColor="pink" />);
      await waitFor(() => expect(screen.getByText('Question')).toBeInTheDocument());
      const active = screen.getByRole('button', { name: /highlight as question/i });
      expect(active.querySelector('.ring-2')).not.toBeNull();
    });
  });

  describe('Labels umbenennen (Slice 05, mockup-popup-edit-labels.html edit state)', () => {
    async function enterEditMode() {
      render(<FloatingPopup {...defaultProps} onPickColor={vi.fn()} />);
      await waitFor(() => expect(screen.getByText('Important')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /rename labels/i }));
      await waitFor(() => expect(screen.getByText(/rename colors/i)).toBeInTheDocument());
    }

    it('Stift-Icon wechselt in den Edit-Modus mit fünf Eingabefeldern', async () => {
      await enterEditMode();
      expect(screen.getAllByRole('textbox')).toHaveLength(5);
      expect(screen.getByText(/save labels/i)).toBeInTheDocument();
      // Der Branch-Button ist im Edit-Modus durch "Save labels" ersetzt.
      expect(screen.queryByText(/open as new chat/i)).not.toBeInTheDocument();
    });

    it('Save persistiert nur geänderte Labels über die API', async () => {
      await enterEditMode();
      const input = screen.getByRole('textbox', { name: /label for yellow/i });
      fireEvent.change(input, { target: { value: 'Merken' } });
      fireEvent.click(screen.getByText(/save labels/i));
      await waitFor(() => expect(api.setHighlightLabel).toHaveBeenCalledWith('yellow', 'Merken'));
      expect(api.setHighlightLabel).toHaveBeenCalledTimes(1);
      // Zurück im Picker-Modus mit dem neuen Label unter dem Swatch.
      await waitFor(() => expect(screen.getByText('Merken')).toBeInTheDocument());
    });

    it('Reset-Knopf leert die Zeile; Save setzt auf den Default zurück', async () => {
      await enterEditMode();
      const resets = screen.getAllByRole('button', { name: /reset to default/i });
      fireEvent.click(resets[0]);
      expect(screen.getByRole('textbox', { name: /label for yellow/i })).toHaveValue('');
      fireEvent.click(screen.getByText(/save labels/i));
      // Leerstring geht an die API — der Server antwortet mit dem Default.
      await waitFor(() => expect(api.setHighlightLabel).toHaveBeenCalledWith('yellow', ''));
    });

    it('Cancel verlässt den Edit-Modus ohne API-Aufruf', async () => {
      await enterEditMode();
      fireEvent.change(screen.getByRole('textbox', { name: /label for blue/i }), {
        target: { value: 'Weggeworfen' },
      });
      fireEvent.click(screen.getByText(/^cancel$/i));
      await waitFor(() => expect(screen.getByText(/highlight color/i)).toBeInTheDocument());
      expect(api.setHighlightLabel).not.toHaveBeenCalled();
    });
  });

  // Branching blocks on the passage-title lookup (App.tsx / passageTitle.ts):
  // measured 0.5 s with Gemini Flash, capped at TITLE_WAIT_MS = 2500. Until
  // this state existed the button just sat there dead (user report
  // 2026-08-08). Option A of design/mockup-branch-creation-loading.html.
  describe('creating state while the branch is being made', () => {
    it('turns the branch button into a spinner and blocks a second click', () => {
      const onOpenChildChat = vi.fn();
      render(
        <FloatingPopup {...defaultProps} onOpenChildChat={onOpenChildChat} creating />,
      );

      const branch = screen.getByTestId('popup-open-child-chat');
      expect(branch).toHaveTextContent(/creating chat/i);
      expect(branch).toBeDisabled();
      expect(branch).toHaveAttribute('aria-busy', 'true');

      fireEvent.click(branch);
      expect(onOpenChildChat).not.toHaveBeenCalled();
    });

    it('also blocks "Ask in chat" so the selection cannot be spent twice', () => {
      const onAskInChat = vi.fn();
      render(<FloatingPopup {...defaultProps} onAskInChat={onAskInChat} creating />);

      const ask = screen.getByTestId('popup-ask-in-chat');
      expect(ask).toBeDisabled();
      fireEvent.click(ask);
      expect(onAskInChat).not.toHaveBeenCalled();
    });

    it('stays a normal button while nothing is being created', () => {
      render(<FloatingPopup {...defaultProps} />);
      const branch = screen.getByTestId('popup-open-child-chat');
      expect(branch).toHaveTextContent(/open as new chat/i);
      expect(branch).not.toBeDisabled();
      expect(branch).not.toHaveAttribute('aria-busy', 'true');
    });
  });

  describe('copy button', () => {
    it('writes the popup word to the clipboard when clicked', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      render(<FloatingPopup {...defaultProps} />);
      fireEvent.click(screen.getByRole('button', { name: /copy text/i }));

      expect(writeText).toHaveBeenCalledWith('quantum');
    });

    it('switches the icon label to "Copied" after a successful copy', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      render(<FloatingPopup {...defaultProps} />);
      fireEvent.click(screen.getByRole('button', { name: /copy text/i }));

      // Wait for the async clipboard write + state update to flush.
      await screen.findByRole('button', { name: /copied/i });
    });
  });
});
