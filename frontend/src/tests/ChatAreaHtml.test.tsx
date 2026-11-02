/**
 * ChatAreaHtml.test.tsx
 *
 * ChatArea's part of the HTML source (ADR-0013 decision 8, mockup-html-app):
 * one upload entry for PDF and HTML, a new "Web page" entry, and the freeze
 * card under the FIRST answer only.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatArea } from '../components/ChatArea';
import type { ChatDetail } from '../types';

const now = new Date().toISOString();
const chat: ChatDetail = {
  id: '1',
  title: 'Lernpfad',
  parent_id: null,
  parent_word: null,
  created_at: now,
  messages: [
    { id: 'u1', chat_id: '1', role: 'user', content: 'Gliederung?', created_at: '2026-09-29T10:00:00Z' },
    { id: 'a1', chat_id: '1', role: 'assistant', content: 'Erste Antwort.', created_at: '2026-09-29T10:00:01Z' },
    { id: 'u2', chat_id: '1', role: 'user', content: 'Mehr?', created_at: '2026-09-29T10:00:02Z' },
    { id: 'a2', chat_id: '1', role: 'assistant', content: 'Zweite Antwort.', created_at: '2026-09-29T10:00:03Z' },
  ],
  children: [],
};

const props = {
  streaming: false,
  onSendMessage: vi.fn().mockResolvedValue(undefined),
  onWordRightClick: vi.fn(),
  onSelectChat: vi.fn(),
};

const unfrozen = [{ url: 'https://cdn.example/a.js', kind: 'script', reason: 'no-internet' }];

describe('ChatArea, HTML source', () => {
  it('the upload entry names both kinds and its file input accepts PDF and HTML', () => {
    render(<ChatArea chat={chat} loading={false} {...props} onUploadPdf={vi.fn()} />);
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    const entry = screen.getByTestId('attach-menu-upload-pdf');
    expect(entry).toHaveTextContent('Upload file');
    expect(entry).toHaveTextContent('PDF, HTML');
    const accept = screen.getByTestId('pdf-file-input').getAttribute('accept') ?? '';
    expect(accept).toContain('.pdf');
    expect(accept).toContain('.html');
  });

  it('hands an HTML file to the same upload handler (the app routes by kind)', () => {
    const onUpload = vi.fn();
    render(<ChatArea chat={chat} loading={false} {...props} onUploadPdf={onUpload} />);
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    fireEvent.click(screen.getByTestId('attach-menu-upload-pdf'));
    const html = new File(['<html></html>'], 'lernpfad.html', { type: 'text/html' });
    fireEvent.change(screen.getByTestId('pdf-file-input'), { target: { files: [html] } });
    expect(onUpload).toHaveBeenCalledWith(html);
  });

  it('offers "Web page" only when the app handles it, and opens the dialog', () => {
    const { unmount } = render(<ChatArea chat={chat} loading={false} {...props} />);
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    expect(screen.queryByTestId('attach-menu-webpage')).not.toBeInTheDocument();
    unmount();

    const onOpenWebpage = vi.fn();
    render(<ChatArea chat={chat} loading={false} {...props} onOpenWebpage={onOpenWebpage} />);
    fireEvent.click(screen.getByTestId('attach-plus-button'));
    const entry = screen.getByTestId('attach-menu-webpage');
    expect(entry).toHaveTextContent('Web page');
    fireEvent.click(entry);
    expect(onOpenWebpage).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('attach-menu')).not.toBeInTheDocument();
  });

  it('puts the freeze card under the first answer only', () => {
    render(
      <ChatArea chat={chat} loading={false} {...props} htmlFreeze={{ unfrozen, retrying: false, onRetry: vi.fn() }} />,
    );
    const cards = screen.getAllByTestId('html-freeze-card');
    expect(cards).toHaveLength(1);
    const first = screen.getByText('Erste Antwort.').closest('[data-message-id], div')!;
    expect(first.parentElement).toContainElement(cards[0]);
    expect(screen.getByText('Zweite Antwort.').parentElement).not.toContainElement(cards[0]);
  });

  it('shows no card without the prop', () => {
    render(<ChatArea chat={chat} loading={false} {...props} />);
    expect(screen.queryByTestId('html-freeze-card')).not.toBeInTheDocument();
  });
});
