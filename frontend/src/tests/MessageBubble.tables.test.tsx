/**
 * MessageBubble.tables.test.tsx
 *
 * GFM-Tabellen in Assistenten-Antworten (Report 2026-07-24): ohne eigene
 * Renderer klebten die Zellen ungepolstert aneinander und die Kopfzeile war
 * zentriert, während die Zellen links standen. Die Tests decken die
 * gfmTableComponents ab: Padding-Klassen, Links-Default, explizite
 * Ausrichtung aus der Markdown-Syntax, Scroll-Wrapper und mehrzeilige
 * Zellen-Ausrichtung oben.
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from '../components/ChatArea/MessageBubble';
import type { Message } from '../types';

function assistant(content: string): Message {
  return {
    id: 'a-tbl',
    chat_id: 'c1',
    role: 'assistant',
    content,
    created_at: new Date().toISOString(),
  };
}

function renderTable(content: string) {
  const { container } = render(
    <MessageBubble message={assistant(content)} onWordRightClick={vi.fn()} />,
  );
  return container;
}

const BASIC_TABLE = [
  '| Neues Wort | Artikel | Englisch |',
  '| --- | --- | --- |',
  '| Context | der Context | Kontext |',
  '| Embedding | das Embedding | Einbettung |',
].join('\n');

describe('MessageBubble – GFM-Tabellen', () => {
  it('rendert eine Markdown-Tabelle als <table> mit Kopf- und Datenzeilen', () => {
    const container = renderTable(BASIC_TABLE);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(container.querySelectorAll('th')).toHaveLength(3);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table!.textContent).toContain('Embedding');
  });

  it('polstert Zellen und Kopfzellen (kein Aneinanderkleben der Spalten)', () => {
    const container = renderTable(BASIC_TABLE);
    const th = container.querySelector('th')!;
    const td = container.querySelector('td')!;
    expect(th.className).toContain('px-3');
    expect(th.className).toContain('py-1.5');
    expect(td.className).toContain('px-3');
    expect(td.className).toContain('py-1.5');
  });

  it('richtet Kopfzellen ohne explizite Ausrichtung links aus (kein Browser-Zentrieren)', () => {
    const container = renderTable(BASIC_TABLE);
    for (const th of container.querySelectorAll('th')) {
      expect((th as HTMLElement).style.textAlign).toBe('left');
    }
  });

  it('übernimmt explizite Ausrichtung aus der Markdown-Syntax (:---: / ---:)', () => {
    const container = renderTable(
      [
        '| Links | Mitte | Rechts |',
        '| :--- | :---: | ---: |',
        '| a | b | c |',
      ].join('\n'),
    );
    const ths = Array.from(container.querySelectorAll('th')) as HTMLElement[];
    expect(ths.map((el) => el.style.textAlign)).toEqual(['left', 'center', 'right']);
    const tds = Array.from(container.querySelectorAll('td')) as HTMLElement[];
    expect(tds.map((el) => el.style.textAlign)).toEqual(['left', 'center', 'right']);
  });

  it('richtet Zellen vertikal oben aus (align-top) für mehrzeilige Inhalte', () => {
    const container = renderTable(
      [
        '| Wort | Erklärung |',
        '| --- | --- |',
        '| Overfit | überfitting (häufig: das Overfitting) — eine sehr lange Erklärung, die über mehrere Zeilen umbricht |',
      ].join('\n'),
    );
    for (const td of container.querySelectorAll('td')) {
      expect((td as HTMLElement).className).toContain('align-top');
    }
    const th = container.querySelector('th')!;
    expect(th.className).toContain('align-bottom');
  });

  it('umhüllt die Tabelle mit einem horizontal scrollbaren Wrapper', () => {
    const container = renderTable(BASIC_TABLE);
    const wrapper = container.querySelector('table')!.parentElement!;
    expect(wrapper.className).toContain('overflow-x-auto');
  });

  it('trennt Kopf und Zeilen mit gedimmten currentColor-Linien (theme-fest)', () => {
    // Kein border-gray-*: die Themes färben diese Utilities auf volles
    // Tinten-Navy um, die Linien wurden zu hart (Report 2026-07-24).
    const container = renderTable(BASIC_TABLE);
    const th = container.querySelector('th') as HTMLElement;
    const td = container.querySelector('td') as HTMLElement;
    expect(th.style.borderBottom).toContain('color-mix');
    expect(td.style.borderBottom).toContain('color-mix');
    expect(th.className).not.toContain('border-gray');
    expect(td.className).not.toContain('border-gray');
    // Die Zeilenlinie ist deutlich dezenter als die Kopf-Trennlinie.
    expect(th.style.borderBottom).toContain('35%');
    expect(td.style.borderBottom).toContain('12%');
  });

  it('rendert Inline-Markdown (fett, Code) innerhalb von Zellen', () => {
    const container = renderTable(
      [
        '| Begriff | Code |',
        '| --- | --- |',
        '| **Loss** | `nn.MSELoss` |',
      ].join('\n'),
    );
    expect(container.querySelector('td strong')!.textContent).toBe('Loss');
    expect(container.querySelector('td code')!.textContent).toBe('nn.MSELoss');
  });

  it('rendert eine Tabelle ohne Datenzeilen (nur Kopf) ohne Absturz', () => {
    const container = renderTable('| A | B |\n| --- | --- |');
    expect(container.querySelectorAll('th')).toHaveLength(2);
    expect(container.querySelectorAll('td')).toHaveLength(0);
  });

  it('rendert eine breite Tabelle mit vielen Spalten vollständig', () => {
    const header = `| ${Array.from({ length: 10 }, (_, i) => `Spalte${i}`).join(' | ')} |`;
    const sep = `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`;
    const row = `| ${Array.from({ length: 10 }, (_, i) => `Wert${i}`).join(' | ')} |`;
    const container = renderTable([header, sep, row].join('\n'));
    expect(container.querySelectorAll('th')).toHaveLength(10);
    expect(container.querySelectorAll('td')).toHaveLength(10);
  });
});
