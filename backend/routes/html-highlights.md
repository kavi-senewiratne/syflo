# HTML highlights API (fourth highlight kind, ADR-0013 decision 5)

Quote-anchored marks inside an HTML source. The backend only stores the anchor;
the in-page bridge resolves it. Shape (camelCase, like the other kinds):

```json
{ "id": "uuid", "htmlSourceId": "hs-…", "chatId": "uuid|null", "color": "yellow",
  "anchor": { "exact": "…", "prefix": "…", "suffix": "…" },
  "section": "Heading text|null", "createdAt": "ISO", "updatedAt": "ISO" }
```

- `GET /api/html-highlights?html_source_id=ID` -> 200 array, oldest first; 400 without the param.
- `POST /api/html-highlights` body `{ htmlSourceId, color, anchor, section?, chatId? }`
  -> 201 highlight. 400: bad color, anchor without non-empty `exact` or without string
  `prefix`/`suffix`, non-string `section`. 404: unknown source or chat.
- `PATCH /api/html-highlights/:id` body `{ color?, chatId? }` (`chatId: null` unlinks)
  -> 200 highlight; 400 bad color; 404 unknown highlight/chat. Anchor is immutable
  (move = delete + re-create).
- `DELETE /api/html-highlights/:id` -> 204; 404 unknown.

`chatId` is the chat opened from the passage: a menu item, never the click. It is
ON DELETE SET NULL (marks outlive chats); marks are deleted with their source (CASCADE).

## Tree drawer

`GET /api/chats/:chatId/tree-highlights` now also returns, for a tree whose root
chat has `html_source_id`:

```json
{ "kind": "html", "id", "color", "text": "<anchor.exact>", "htmlSourceId",
  "anchor": { "exact", "prefix", "suffix" }, "section": "location text|null",
  "chatId": "uuid|null", "createdAt", "updatedAt" }
```

Order: pdf, video (transcript/chapter), html, chat items.
