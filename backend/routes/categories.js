/**
 * routes/categories.js
 *
 * User-made containers for ROOT chats, one nesting level deep
 * (design/mockup-sidebar-categories-v2.html, decided 2026-08-16).
 *
 * A subcategory is a category with a parent — same table, same endpoints. The
 * two-level cap lives here rather than in the schema: creating a category
 * under a category that already has a parent is rejected.
 */

const express = require('express');
const { randomUUID } = require('crypto');

module.exports = (db) => {
  const router = express.Router();

  // The whole flat list — parents and children together. The sidebar nests
  // them itself; sending a tree would only mean the client had to flatten it
  // again for every rename and move.
  router.get('/', (_req, res) => {
    res.json(db.prepare('SELECT * FROM categories ORDER BY position ASC, created_at ASC').all());
  });

  // Create a category, or a subcategory when parent_id is given.
  router.post('/', (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const parentId = req.body.parent_id ?? null;
    if (!name) return res.status(400).json({ error: 'name is required' });

    // The two-level cap. A parent that already has a parent is a subcategory,
    // and a subcategory holds chats, never more categories.
    if (parentId) {
      const parent = db.prepare('SELECT * FROM categories WHERE id = ?').get(parentId);
      if (!parent) return res.status(400).json({ error: 'Parent category not found' });
      if (parent.parent_id) {
        return res.status(400).json({ error: 'Categories nest one level deep' });
      }
    }

    const id = randomUUID();
    db.prepare(
      'INSERT INTO categories (id, name, parent_id, position, collapsed, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    ).run(id, name, parentId, 0, new Date().toISOString());

    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
  });

  // Rename, and remember open/closed. Both levels use this — a subcategory is
  // a category, so it renames with the same call.
  router.patch('/:id', (req, res) => {
    const { name, collapsed } = req.body;
    const wantsName = typeof name === 'string' && name.trim();
    const wantsCollapsed = typeof collapsed === 'boolean';
    if (!wantsName && !wantsCollapsed) {
      return res.status(400).json({ error: 'name or collapsed is required' });
    }

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    if (wantsName) {
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    }
    if (wantsCollapsed) {
      db.prepare('UPDATE categories SET collapsed = ? WHERE id = ?')
        .run(collapsed ? 1 : 0, req.params.id);
    }

    res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id));
  });

  // Delete a category. Its chats are FREED, never deleted — they fall back to
  // their date sections, which is what the menu promises in so many words.
  // Deleting a parent takes its subcategories with it and frees their chats
  // the same way.
  //
  // Both steps are spelled out rather than left to the schema. The FKs would do
  // it (better-sqlite3 runs with foreign_keys ON: ON DELETE CASCADE on
  // categories.parent_id, ON DELETE SET NULL on chats.category_id), but the
  // promise made to the user is too load-bearing to depend on a constraint a
  // future schema rebuild might drop — the same belt-and-braces reasoning as
  // the highlight unlink in routes/chats.js.
  router.delete('/:id', (req, res) => {
    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const freeChats = db.prepare('UPDATE chats SET category_id = NULL WHERE category_id = ?');
    const deleteCategory = db.prepare('DELETE FROM categories WHERE id = ?');
    const findSubcategories = db.prepare('SELECT id FROM categories WHERE parent_id = ?');

    db.transaction(() => {
      for (const sub of findSubcategories.all(category.id)) {
        freeChats.run(sub.id);
        deleteCategory.run(sub.id);
      }
      freeChats.run(category.id);
      deleteCategory.run(category.id);
    })();

    res.json({ success: true });
  });

  return router;
};
