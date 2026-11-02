/**
 * htmlGerman.test.tsx
 *
 * The HTML source's copy in the App language Deutsch (strings.ts keeps EN and
 * DE parallel by type; this pins the umlauts and the mockup's wording).
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import { HtmlWebDialog } from '../components/HtmlWebDialog';
import { getStrings } from '../strings';

beforeEach(() => localStorage.setItem('syflo.appLanguage', 'de'));
afterEach(() => localStorage.removeItem('syflo.appLanguage'));

describe('HTML source, Deutsch', () => {
  it('the freeze card names each resource with its exact German reason', () => {
    render(
      <MessageBubble
        message={{ id: 'a', chat_id: 'c', role: 'assistant', content: 'Hallo.', created_at: '2026-09-29T00:00:00Z' }}
        onWordRightClick={vi.fn()}
        htmlFreeze={{
          unfrozen: [
            { url: 'https://a.test/x.js', kind: 'script', reason: 'no-internet' },
            { url: 'https://a.test/y.woff', kind: 'font', reason: 'blocked-local-address' },
          ],
          retrying: false,
          onRetry: vi.fn(),
        }}
      />,
    );
    const card = screen.getByTestId('html-freeze-card');
    expect(card).toHaveTextContent('2 Ressourcen nicht eingefroren');
    expect(card).toHaveTextContent('x.js (a.test): kein Internet');
    expect(card).toHaveTextContent('y.woff (a.test): lokale Adresse gesperrt');
    expect(screen.getByRole('button', { name: 'Erneut versuchen' })).toBeInTheDocument();
  });

  it('the web dialog speaks German', () => {
    render(<HtmlWebDialog onImport={vi.fn()} onClose={vi.fn()} onUploadFile={vi.fn()} />);
    expect(screen.getByText('Webseite laden')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Adresse der Webseite'), { target: { value: 'https://x.test' } });
    expect(screen.getByRole('button', { name: 'Laden' })).toBeEnabled();
  });

  it('has the mockup wording and correct singular/plural', () => {
    const S = getStrings().htmlPane;
    expect(S.cardTitle(1)).toBe('1 Ressource nicht eingefroren');
    expect(S.webNoText).toBe('Kein lesbarer Text gefunden: Die Seite ist leer oder verlangt eine Anmeldung.');
    expect(S.webUploadInstead).toBe('HTML-Datei hochladen');
    expect(S.reason('http-404')).toBe('HTTP 404');
    expect(S.subtitle(1, true)).toBe('HTML · 1 Abschnitt · vollständig eingefroren');
  });
});
