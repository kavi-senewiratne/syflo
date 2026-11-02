/**
 * page-renderer.js — renders a URL in a hidden, sandboxed BrowserWindow and
 * returns the serialized DOM (ADR-0013, "Web pages").
 *
 * Runs in the Electron MAIN process only. The window has no preload, no Node,
 * a throw-away in-memory partition, denied permissions/downloads/popups, and
 * every request (sub-resources and redirects too) goes through the SSRF guard:
 * only public http(s) addresses, plus inline data:/blob:/about: URLs.
 * Known limit: Chromium resolves DNS again after our own lookup (rebinding
 * window); the guard checks the resolved addresses at request time.
 */
const crypto = require('crypto');

const OVERALL_TIMEOUT_MS = 25000;
const QUIET_MS = 800;
const MAX_QUIET_WAIT_MS = 10000;

// Returns async (url) => boolean. `assertPublicHost(hostname)` throws for
// loopback/private/link-local hosts (literal or resolved).
function createRequestGuard(assertPublicHost) {
  return async function allow(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (_) { return false; }
    if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    try {
      await assertPublicHost(url.hostname);
      return true;
    } catch (_) {
      return false;
    }
  };
}

// Script run inside the page: resolves once the DOM stayed unchanged for
// `quietMs`, or after `maxMs` at the latest.
const QUIET_SCRIPT = (quietMs, maxMs) => `() => new Promise((resolve) => {
  let quietTimer;
  const done = () => { observer.disconnect(); clearTimeout(quietTimer); clearTimeout(maxTimer); resolve(true); };
  const observer = new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(done, ${quietMs}); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  quietTimer = setTimeout(done, ${quietMs});
  const maxTimer = setTimeout(done, ${maxMs});
})`;

class RenderError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function withTimeout(promise, ms, reason) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RenderError(reason)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Injected `electron` makes this loadable (and testable) without Electron.
function createPageRenderer({
  electron, assertPublicHost, overallTimeoutMs = OVERALL_TIMEOUT_MS, quietMs = QUIET_MS, maxQuietWaitMs = MAX_QUIET_WAIT_MS,
}) {
  const { BrowserWindow, session } = electron;
  const allow = createRequestGuard(assertPublicHost);

  async function render(url) {
    if (!(await allow(url))) throw new RenderError('blocked-local-address');
    const ses = session.fromPartition(`syflo-render-${crypto.randomBytes(8).toString('hex')}`); // no "persist:" = in memory
    let blocked = false;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, cb) => {
      allow(details.url).then((ok) => {
        if (!ok) blocked = true;
        cb({ cancel: !ok });
      });
    });

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: ses,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));

    const work = (async () => {
      try {
        await wc.loadURL(url);
      } catch (err) {
        // ERR_ABORTED after our own cancel, or a real network failure.
        if (blocked) throw new RenderError('blocked-local-address');
        if (!wc.getURL() || wc.getURL() === 'about:blank') throw new RenderError('no-internet');
      }
      await wc.executeJavaScript(`(${QUIET_SCRIPT(quietMs, maxQuietWaitMs)})()`);
      const finalUrl = wc.getURL();
      const html = await wc.executeJavaScript(`(() => {
        const base = document.createElement('base');
        base.href = ${JSON.stringify(finalUrl)};
        const head = document.head || document.documentElement.insertBefore(document.createElement('head'), document.documentElement.firstChild);
        head.insertBefore(base, head.firstChild);
        return '<!doctype html>' + document.documentElement.outerHTML;
      })()`);
      return { html, finalUrl };
    })();

    try {
      return await withTimeout(work, overallTimeoutMs, 'timeout');
    } finally {
      work.catch(() => {});
      if (!win.isDestroyed()) win.destroy();
      try { await ses.clearStorageData(); } catch (_) { /* window is gone */ }
    }
  }
  return render;
}

module.exports = { createPageRenderer, createRequestGuard, QUIET_SCRIPT, RenderError };
