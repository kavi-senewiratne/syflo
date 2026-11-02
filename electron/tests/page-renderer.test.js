const test = require('node:test');
const assert = require('node:assert');
const { createRequestGuard, QUIET_SCRIPT } = require('../page-renderer');

const assertPublicHost = async (host) => {
  if (host === '127.0.0.1' || host === 'intranet.test') throw Object.assign(new Error('x'), { reason: 'blocked-local-address' });
};

test('request guard allows public http(s) and inline schemes, refuses the rest', async () => {
  const allow = createRequestGuard(assertPublicHost);
  assert.strictEqual(await allow('https://example.com/a.js'), true);
  assert.strictEqual(await allow('http://example.com/'), true);
  assert.strictEqual(await allow('data:image/png;base64,AAAA'), true);
  assert.strictEqual(await allow('blob:https://example.com/uuid'), true);
  assert.strictEqual(await allow('http://127.0.0.1:3001/api/chats'), false);
  assert.strictEqual(await allow('http://intranet.test/'), false); // resolves to a private address
  assert.strictEqual(await allow('file:///etc/passwd'), false);
  assert.strictEqual(await allow('ftp://example.com/'), false);
  assert.strictEqual(await allow('ws://example.com/'), false);
  assert.strictEqual(await allow('not a url'), false);
});

test('quiet script is syntactically valid JavaScript', () => {
  // eslint-disable-next-line no-new-func
  assert.doesNotThrow(() => new Function(`return (${QUIET_SCRIPT(800, 10000)});`));
});
