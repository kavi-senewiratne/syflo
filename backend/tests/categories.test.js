process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const request = require('supertest');
const { createApp } = require('../server');
const { createDb } = require('../database');
const path = require('path');
const fs = require('fs');

const TEST_DB_PATH = path.join(__dirname, 'test-categories.db');

let app;
let db;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = createDb(TEST_DB_PATH);
  app = createApp(db);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('POST /api/categories', () => {
  it('creates a top-level category', async () => {
    const res = await request(app).post('/api/categories').send({ name: 'Robotics' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Robotics');
    expect(res.body.id).toBeDefined();
    expect(res.body.parent_id).toBeNull();
  });
});

describe('DELETE /api/categories/:id', () => {
  // The promise the menu makes out loud: "The 12 chats stay and return to
  // their date sections." Deleting a container must never delete content.
  it('keeps every chat and frees it, including chats of its subcategories', async () => {
    const parent = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const sub = await request(app).post('/api/categories')
      .send({ name: 'Teleop data', parent_id: parent.body.id });
    const inParent = await request(app).post('/api/chats').send({ title: 'Gripper limits' });
    const inSub = await request(app).post('/api/chats').send({ title: 'Recording rig' });
    await request(app).patch(`/api/chats/${inParent.body.id}`).send({ category_id: parent.body.id });
    await request(app).patch(`/api/chats/${inSub.body.id}`).send({ category_id: sub.body.id });

    const res = await request(app).delete(`/api/categories/${parent.body.id}`);
    expect(res.status).toBe(200);

    expect((await request(app).get('/api/categories')).body).toEqual([]);
    const chats = (await request(app).get('/api/chats')).body;
    expect(chats).toHaveLength(2);
    expect(chats.every(c => c.category_id === null)).toBe(true);
  });

  it('deletes a subcategory without touching its parent', async () => {
    const parent = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const sub = await request(app).post('/api/categories')
      .send({ name: 'Teleop data', parent_id: parent.body.id });

    await request(app).delete(`/api/categories/${sub.body.id}`);
    const remaining = (await request(app).get('/api/categories')).body;
    expect(remaining.map(c => c.name)).toEqual(['Robotics']);
  });

  it('404s on a category that does not exist', async () => {
    expect((await request(app).delete('/api/categories/nope')).status).toBe(404);
  });
});

describe('filing a chat into a category', () => {
  it('files a root chat and reports it back in the chat list', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const chat = await request(app).post('/api/chats').send({ title: 'Gripper limits' });

    const res = await request(app).patch(`/api/chats/${chat.body.id}`)
      .send({ category_id: cat.body.id });

    expect(res.status).toBe(200);
    expect(res.body.category_id).toBe(cat.body.id);
    const listed = (await request(app).get('/api/chats')).body.find(c => c.id === chat.body.id);
    expect(listed.category_id).toBe(cat.body.id);
  });

  it('unfiles a chat when category_id is null', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const chat = await request(app).post('/api/chats').send({ title: 'Gripper limits' });
    await request(app).patch(`/api/chats/${chat.body.id}`).send({ category_id: cat.body.id });

    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ category_id: null });
    expect(res.status).toBe(200);
    expect(res.body.category_id).toBeNull();
  });

  it('files into a subcategory, which is the same column', async () => {
    const parent = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const sub = await request(app).post('/api/categories')
      .send({ name: 'Teleop data', parent_id: parent.body.id });
    const chat = await request(app).post('/api/chats').send({ title: 'Recording rig' });

    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ category_id: sub.body.id });
    expect(res.body.category_id).toBe(sub.body.id);
  });

  it('refuses to file a branch — categories hold trees', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const root = await request(app).post('/api/chats').send({ title: 'Root' });
    const branch = await request(app).post('/api/chats')
      .send({ title: 'Branch', parent_id: root.body.id, parent_word: 'gripper' });

    const res = await request(app).patch(`/api/chats/${branch.body.id}`)
      .send({ category_id: cat.body.id });
    expect(res.status).toBe(400);
  });

  it('refuses a category that does not exist', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Gripper limits' });
    const res = await request(app).patch(`/api/chats/${chat.body.id}`)
      .send({ category_id: 'no-such-category' });
    expect(res.status).toBe(400);
  });
});

// Filing and pinning are two names for the same thing: where a tree lives.
// Holding both at once produced a chat that sat in a category while its menu
// still offered "Unpin" — the user hit exactly that (2026-08-16). One home per
// chat, so each gesture clears the other.
describe('filing and pinning are mutually exclusive', () => {
  it('clears the pin when a chat is filed', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Zero to Hero' });
    const chat = await request(app).post('/api/chats').send({ title: 'A Neural Probabilistic Language Model' });
    await request(app).patch(`/api/chats/${chat.body.id}`).send({ pinned: true });

    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ category_id: cat.body.id });
    expect(res.body.category_id).toBe(cat.body.id);
    expect(res.body.pinned_at).toBeNull();
  });

  it('takes a chat out of its category when it is pinned', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Zero to Hero' });
    const chat = await request(app).post('/api/chats').send({ title: 'Gripper limits' });
    await request(app).patch(`/api/chats/${chat.body.id}`).send({ category_id: cat.body.id });

    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ pinned: true });
    expect(res.body.pinned_at).not.toBeNull();
    expect(res.body.category_id).toBeNull();
  });

  it('leaves the pin alone when a chat is only taken OUT of a category', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Instruction sandwich' });
    await request(app).patch(`/api/chats/${chat.body.id}`).send({ pinned: true });

    // Unfiling something that was never filed must not quietly unpin it.
    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ category_id: null });
    expect(res.body.pinned_at).not.toBeNull();
  });

  it('unpinning leaves the chat where it is', async () => {
    const chat = await request(app).post('/api/chats').send({ title: 'Instruction sandwich' });
    await request(app).patch(`/api/chats/${chat.body.id}`).send({ pinned: true });

    const res = await request(app).patch(`/api/chats/${chat.body.id}`).send({ pinned: false });
    expect(res.body.pinned_at).toBeNull();
    expect(res.body.category_id).toBeNull();
  });
});

describe('PATCH /api/categories/:id', () => {
  it('renames a category', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Robotcs' });
    const res = await request(app).patch(`/api/categories/${cat.body.id}`).send({ name: 'Robotics' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Robotics');
  });

  it('remembers that a category is collapsed', async () => {
    const cat = await request(app).post('/api/categories').send({ name: 'Robotics' });
    expect(cat.body.collapsed).toBe(0);

    await request(app).patch(`/api/categories/${cat.body.id}`).send({ collapsed: true });
    const [stored] = (await request(app).get('/api/categories')).body;
    expect(stored.collapsed).toBe(1);

    await request(app).patch(`/api/categories/${cat.body.id}`).send({ collapsed: false });
    expect((await request(app).get('/api/categories')).body[0].collapsed).toBe(0);
  });

  it('404s on a category that does not exist', async () => {
    const res = await request(app).patch('/api/categories/nope').send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('the two-level cap', () => {
  it('refuses a category under a subcategory', async () => {
    const parent = await request(app).post('/api/categories').send({ name: 'Robotics' });
    const sub = await request(app).post('/api/categories')
      .send({ name: 'Teleop data', parent_id: parent.body.id });

    const res = await request(app).post('/api/categories')
      .send({ name: 'Too deep', parent_id: sub.body.id });

    expect(res.status).toBe(400);
    expect((await request(app).get('/api/categories')).body).toHaveLength(2);
  });

  it('refuses a parent that does not exist', async () => {
    const res = await request(app).post('/api/categories')
      .send({ name: 'Orphan', parent_id: 'no-such-category' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/categories', () => {
  it('lists categories with their subcategories, newest last', async () => {
    const parent = await request(app).post('/api/categories').send({ name: 'Robotics' });
    await request(app).post('/api/categories').send({ name: 'Teleop data', parent_id: parent.body.id });
    await request(app).post('/api/categories').send({ name: 'Attention papers' });

    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.map(c => c.name)).toEqual(['Robotics', 'Teleop data', 'Attention papers']);
    expect(res.body.find(c => c.name === 'Teleop data').parent_id).toBe(parent.body.id);
  });
});
