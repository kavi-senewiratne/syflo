/**
 * tests/html-source.test.js
 *
 * HTML source (ADR-0013). Built one behavior at a time; the pure text
 * extraction comes first, the upload route follows in this same file.
 */
const request = require('supertest');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createApp } = require('../server');
const { createDb } = require('../database');
const { extractSections } = require('../html-source');

describe('extractSections — what the chat may read of an HTML source', () => {
  it('returns the visible text in reading order and drops script, style and JSON payloads', async () => {
    const html = `<!doctype html><html><head><title>Lecture</title>
      <style>body { color: red }</style>
      <script>window.secret = 'from-a-script';</script>
      <script type="application/json" id="quizdata">{"q":"quiz-answer"}</script>
      </head><body><p>First paragraph.</p><div><span>Second</span> paragraph.</div></body></html>`;

    const { text } = await extractSections(html);

    expect(text).toBe('First paragraph.\nSecond paragraph.');
  });

  it('cuts the text into sections at h1–h3 headings and keeps each heading level', async () => {
    const html = `<body><h1>Intro</h1><p>a</p>
      <h2>Pendulum</h2><p>b</p><p>c</p>
      <h3>Detail</h3><p>d</p>
      <h2>LQR</h2><p>e</p></body>`;

    const { sections } = await extractSections(html);

    expect(sections).toEqual([
      { level: 1, heading: 'Intro', text: 'a' },
      { level: 2, heading: 'Pendulum', text: 'b\nc' },
      { level: 3, heading: 'Detail', text: 'd' },
      { level: 2, heading: 'LQR', text: 'e' },
    ]);
  });
});

// The real lecture the feature was designed around (ADR-0013). It lives outside
// the repo (1 MB), so the test only runs on a machine that has it.
const REAL_LECTURE = process.env.SYFLO_REAL_LECTURE || path.join(
  os.homedir(),
  '.config/Claude/local-agent-mode-sessions/995b9ae0-bf71-4808-a37b-6d39f89b9677/a8fa3bad-cfc7-4ed6-9656-25791b4f217a/d55242f0/outputs/underactuated-lernpfad.html',
);
(fs.existsSync(REAL_LECTURE) ? describe : describe.skip)('extractSections on the real lecture', () => {
  it('finds the outline and leaves the quiz payload out of the text', async () => {
    const { title, text, sections } = await extractSections(fs.readFileSync(REAL_LECTURE, 'utf8'));

    expect(title).toMatch(/Underactuated/);
    expect(sections.length).toBeGreaterThan(5);
    expect(text.length).toBeGreaterThan(100000);
    expect(text).not.toMatch(/"correct"|quizdata/);
  });
});

describe('POST /api/html-sources — upload an HTML file into a chat tree', () => {
  const TEST_DB_PATH = path.join(__dirname, 'html-source-test.db');
  const TEST_UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syflo-html-uploads-'));
  const LECTURE = Buffer.from(
    '<!doctype html><html><head><title>Underactuated Lernpfad</title></head>'
    + '<body><h1>Einführung</h1><p>Text.</p></body></html>',
  );
  let app;
  let db;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    db = createDb(TEST_DB_PATH);
    app = createApp(db, { uploadsDir: TEST_UPLOADS_DIR });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  });

  async function createChat(title, parent_id) {
    const res = await request(app).post('/api/chats').send({ title, parent_id });
    return res.body;
  }

  function uploadHtml(chatId, filename = 'lecture.html', bytes = LECTURE) {
    return request(app)
      .post('/api/html-sources')
      .field('chat_id', chatId)
      .attach('html', bytes, { filename, contentType: 'text/html' });
  }

  it('stores the file, binds it to the tree root and names the chat after the page title', async () => {
    const root = await createChat('New chat');
    const branch = await createChat('Side thread', root.id);

    const res = await uploadHtml(branch.id);

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Underactuated Lernpfad');
    const chats = (await request(app).get('/api/chats')).body;
    const rootAfter = chats.find((c) => c.id === root.id);
    expect(rootAfter.html_source_id).toBe(res.body.id);
    expect(rootAfter.title).toBe('Underactuated Lernpfad');
  });

  it('refuses a second source in the same tree — from either side', async () => {
    const chat = await createChat('New chat');
    await uploadHtml(chat.id);

    const second = await uploadHtml(chat.id, 'other.html');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('tree-has-source');

    const pdf = await request(app)
      .post('/api/papers')
      .field('chat_id', chat.id)
      .attach('pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(409);

    const other = await createChat('Other chat');
    await request(app)
      .post('/api/papers')
      .field('chat_id', other.id)
      .attach('pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'a.pdf', contentType: 'application/pdf' });
    const html = await uploadHtml(other.id);
    expect(html.status).toBe(409);
  });

  it('rejects a file that is not HTML', async () => {
    const chat = await createChat('New chat');
    const res = await uploadHtml(chat.id, 'notes.txt', Buffer.from('just some notes, no markup'));
    expect(res.status).toBe(415);
    expect(fs.readdirSync(path.join(TEST_UPLOADS_DIR, 'html-sources')).some((f) => f.endsWith('.html') && fs.statSync(path.join(TEST_UPLOADS_DIR, 'html-sources', f)).size === 26)).toBe(false);
  });

  it('serves the outline of a stored source', async () => {
    const chat = await createChat('New chat');
    const { body } = await uploadHtml(chat.id);

    const res = await request(app).get(`/api/html-sources/${body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual([{ level: 1, heading: 'Einführung' }]);
  });
});

