/**
 * HtmlWebDialog.test.tsx
 *
 * The "Web page" dialog (design/mockup-html-app.html, §03 of
 * mockup-html-source.html; ADR-0013 "Web pages"). A page that shows nothing
 * without signing in is a limit of the page, not a fault: a quiet gray hint
 * with an Info icon plus one accent-pill exit — never the red error surface.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HtmlWebDialog } from '../components/HtmlWebDialog';
import { HtmlNoReadableTextError } from '../api';

function setup(onImport = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  const onUploadFile = vi.fn();
  render(<HtmlWebDialog onImport={onImport} onClose={onClose} onUploadFile={onUploadFile} />);
  return { onImport, onClose, onUploadFile };
}

const type = (url: string) =>
  fireEvent.change(screen.getByLabelText('Web address'), { target: { value: url } });

describe('HtmlWebDialog', () => {
  it('is a modal dialog with the filled Load button disabled until an address is typed', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    const load = screen.getByRole('button', { name: 'Load' });
    expect(load).toBeDisabled();
    // The filled primary of the source dialogs (same recipe as the YouTube dialog).
    expect(load.className).toContain('bg-blue-500');
    expect(load.className).toContain('text-white');
    type('example.org/article');
    expect(load).toBeEnabled();
  });

  it('shares the anatomy of the other source dialogs: icon + title, one explanatory line, inline button', () => {
    setup();
    const title = screen.getByRole('heading', { name: 'Load a web page' });
    expect(title.querySelector('svg')).not.toBeNull();
    expect(screen.getByText("The page becomes this tree's source; Syflo keeps a copy that reads offline.")).toBeInTheDocument();
    // Input and Load button are siblings in one row — no footer bar below.
    const row = screen.getByTestId('html-web-url-input').closest('div')!.parentElement!;
    expect(row).toContainElement(screen.getByRole('button', { name: 'Load' }));
    expect(document.querySelector('.bg-gray-50')).toBeNull();
  });

  it('imports the typed address (Enter works too)', async () => {
    const { onImport } = setup();
    type('https://example.org/article');
    fireEvent.keyDown(screen.getByLabelText('Web address'), { key: 'Enter' });
    await waitFor(() => expect(onImport).toHaveBeenCalledWith('https://example.org/article'));
  });

  it('is busy while loading and cannot be submitted twice', async () => {
    let finish: () => void = () => {};
    const onImport = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    setup(onImport);
    type('https://example.org/a');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const btn = screen.getByRole('button', { name: 'Load' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(onImport).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load' })).not.toHaveAttribute('aria-busy', 'true'));
  });

  it('answers a page without readable text with a quiet hint and an upload exit, not an error box', async () => {
    const onImport = vi.fn().mockRejectedValue(new HtmlNoReadableTextError());
    const { onUploadFile } = setup(onImport);
    type('https://example.org/login');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const hint = await screen.findByTestId('html-web-no-text');
    expect(hint).toHaveTextContent('No readable text found: the page is empty or needs a sign-in.');
    // Quiet: gray text, no red surface anywhere.
    expect(hint.className).toContain('text-gray-500');
    expect(document.querySelector('.bg-red-50, .text-red-600')).toBeNull();
    // One accent-pill exit that opens a file picker.
    const exit = screen.getByRole('button', { name: 'Upload HTML file' });
    expect(exit.className).toContain('bg-blue-50');
    const input = screen.getByTestId('html-web-file-input') as HTMLInputElement;
    expect(input.getAttribute('accept')).toContain('.html');
    const file = new File(['<html></html>'], 'saved.html', { type: 'text/html' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onUploadFile).toHaveBeenCalledWith(file);
  });

  it('shows a real failure on the red error surface', async () => {
    setup(vi.fn().mockRejectedValue(new Error('Could not reach the page')));
    type('https://nowhere.test');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    const err = await screen.findByRole('alert');
    expect(err).toHaveTextContent('Could not reach the page');
    expect(err.className).toContain('text-red-600');
  });

  it.each([
    ['blocked-local-address', 'This address is on your own network and is never loaded.'],
    ['no-internet', 'No internet connection.'],
    ['timeout', 'The page took too long to answer.'],
    ['http-404', 'The page answered with an error (HTTP 404).'],
    ['some-unknown-code', 'some-unknown-code'],
  ])('turns the backend reason %s into a readable sentence', async (code, sentence) => {
    setup(vi.fn().mockRejectedValue(new Error(code)));
    type('https://nowhere.test');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
  });

  it('clears an old hint when the address changes', async () => {
    setup(vi.fn().mockRejectedValue(new HtmlNoReadableTextError()));
    type('https://example.org/login');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await screen.findByTestId('html-web-no-text');
    type('https://example.org/other');
    expect(screen.queryByTestId('html-web-no-text')).not.toBeInTheDocument();
  });

  it('closes on Escape, on the close button and on a click outside the panel', () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
