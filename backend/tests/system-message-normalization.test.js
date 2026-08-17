/**
 * Only one system message per request (bug 2026-08-10).
 *
 * Gemini's OpenAI-compatibility layer keeps a single systemInstruction: with
 * several system messages the LAST one wins and every earlier one is dropped
 * without an error. Since the paper full text and the inherited branch context
 * live in the FIRST system message, the trailing instruction blocks deleted
 * them — the model answered "I have no access to the PDF" on a 70k prompt.
 */

const { normalizeSystemMessages, withMessageNormalization } = require('../llm');

const SYS_A = { role: 'system', content: 'PAPER TEXT ...' };
const SYS_B = { role: 'system', content: 'BRANCH FOCUS ...' };
const QUESTION = { role: 'user', content: 'What is V?' };

describe('normalizeSystemMessages', () => {
  it('keeps the first system message untouched — the shared KV prefix must not move', () => {
    const out = normalizeSystemMessages([SYS_A, QUESTION]);
    expect(out[0]).toEqual(SYS_A);
    expect(out[1]).toEqual(QUESTION);
  });

  it('turns every LATER system message into a user turn so it cannot erase the first', () => {
    const out = normalizeSystemMessages([SYS_A, QUESTION, SYS_B]);
    expect(out[0]).toEqual(SYS_A);
    expect(out[2].role).toBe('user');
    expect(out[2].content).toContain('BRANCH FOCUS');
    expect(out.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('labels the converted block as an instruction, not as something the user said', () => {
    const [, converted] = normalizeSystemMessages([SYS_A, SYS_B]);
    expect(converted.content.startsWith('[System instruction')).toBe(true);
  });

  it('leaves a message array without system messages alone', () => {
    const msgs = [QUESTION, { role: 'assistant', content: 'ok' }];
    expect(normalizeSystemMessages(msgs)).toEqual(msgs);
  });

  it('converts a non-string late system message without mangling its content', () => {
    const multimodal = { role: 'system', content: [{ type: 'text', text: 'x' }] };
    const [, converted] = normalizeSystemMessages([SYS_A, multimodal]);
    expect(converted).toEqual({ role: 'user', content: [{ type: 'text', text: 'x' }] });
  });
});

describe('withMessageNormalization', () => {
  it('normalizes every chat completion, whatever the call site', async () => {
    const create = jest.fn().mockResolvedValue({ choices: [] });
    const client = withMessageNormalization({ chat: { completions: { create } } });

    await client.chat.completions.create({ model: 'm', messages: [SYS_A, QUESTION, SYS_B] });

    const sent = create.mock.calls[0][0].messages;
    expect(sent.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(sent[0].content).toBe(SYS_A.content);
    expect(sent[2].role).toBe('user');
  });

  it('passes bodies without a message array straight through', async () => {
    const create = jest.fn().mockResolvedValue({});
    const client = withMessageNormalization({ chat: { completions: { create } } });
    await client.chat.completions.create({ model: 'm' });
    expect(create.mock.calls[0][0]).toEqual({ model: 'm' });
  });

  it('forwards the request options (abort signal, timeout) unchanged', async () => {
    const create = jest.fn().mockResolvedValue({});
    const client = withMessageNormalization({ chat: { completions: { create } } });
    const opts = { signal: new AbortController().signal };
    await client.chat.completions.create({ model: 'm', messages: [SYS_A] }, opts);
    expect(create.mock.calls[0][1]).toBe(opts);
  });
});
