/**
 * Tests for the `syflo` command (ADR-0009, npm-first distribution).
 *
 * House rule for this file: NO test may start a process, run `npm pack`, or
 * write anywhere near the data directory. Every unit here is a pure function
 * with its filesystem, its Node binary and its Electron lookup injected — the
 * launcher decides, the tests read the decision.
 */

const fs = require('fs');
const path = require('path');
const {
  resolvePaths,
  buildLaunchPlan,
  detectLinuxSandboxBlock,
  APPARMOR_PROFILE_TARGET,
  APPARMOR_PROFILE_SOURCE,
} = require('../bin/lib/launch');

// A fake filesystem: a set of paths that "exist". Keeps the tests honest about
// which files the launcher actually probes.
function fakeExists(paths) {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('resolvePaths', () => {
  it('locates the backend entry and the frontend build relative to the package root', () => {
    const root = '/usr/local/lib/node_modules/syflo';
    const paths = resolvePaths({
      packageRoot: root,
      exists: fakeExists([
        path.join(root, 'backend', 'server.js'),
        path.join(root, 'frontend', 'dist', 'index.html'),
      ]),
    });

    expect(paths.layout).toBe('package');
    expect(paths.backendEntry).toBe(path.join(root, 'backend', 'server.js'));
    expect(paths.frontendDir).toBe(path.join(root, 'frontend', 'dist'));
    expect(paths.backendFound).toBe(true);
    expect(paths.frontendFound).toBe(true);
  });
});

// A complete installation: backend entry, frontend build and Electron all in
// place. Individual tests below take this apart to describe the failure modes.
const INSTALL_ROOT = '/usr/local/lib/node_modules/syflo';

function completeInstall(overrides = {}) {
  return {
    packageRoot: INSTALL_ROOT,
    exists: fakeExists([
      path.join(INSTALL_ROOT, 'backend', 'server.js'),
      path.join(INSTALL_ROOT, 'frontend', 'dist', 'index.html'),
      path.join(INSTALL_ROOT, 'electron', 'main.js'),
    ]),
    execPath: '/opt/homebrew/bin/node',
    resolveElectron: () => '/usr/local/lib/node_modules/syflo/node_modules/electron/dist/electron',
    // A Mac, explicitly: with the platform left to default, the launcher would
    // read THIS machine's /proc and /etc for the Linux sandbox check, and the
    // suite would pass or fail depending on where it runs.
    platform: 'darwin',
    ...overrides,
  };
}

describe('buildLaunchPlan', () => {
  it('reads the mode and the port off the command line', () => {
    const deps = completeInstall();

    expect(buildLaunchPlan([], deps).mode).toBe('electron');
    expect(buildLaunchPlan(['--browser'], deps).mode).toBe('browser');
    expect(buildLaunchPlan(['--help'], deps).mode).toBe('help');
    expect(buildLaunchPlan([], deps).port).toBe(3001);
    expect(buildLaunchPlan(['--port', '4000'], deps).port).toBe(4000);
    expect(buildLaunchPlan(['--port=4000'], deps).port).toBe(4000);
  });

  it('starts the backend with the very Node binary that ran the command, not a bare "node"', () => {
    const deps = completeInstall({ execPath: '/Users/someone/.nvm/versions/node/v22.3.0/bin/node' });

    for (const argv of [[], ['--browser']]) {
      const plan = buildLaunchPlan(argv, deps);
      expect(plan.nodeBinary).toBe('/Users/someone/.nvm/versions/node/v22.3.0/bin/node');
      expect(plan.nodeBinary).not.toBe('node');
    }
  });

  it('refuses to launch with a missing frontend build instead of opening a blank page', () => {
    // A git clone that never ran `npm run build` in frontend/, or a broken
    // package: there is a server to talk to but nothing to show.
    const deps = completeInstall({
      exists: fakeExists([
        path.join(INSTALL_ROOT, 'backend', 'server.js'),
        path.join(INSTALL_ROOT, 'electron', 'main.js'),
      ]),
    });

    for (const argv of [[], ['--browser']]) {
      const plan = buildLaunchPlan(argv, deps);
      expect(plan.mode).toBe('error');
      expect(plan.reason).toBe('frontend-missing');
      // The message has to name the file, or the user cannot fix it.
      expect(plan.detail).toContain(path.join('frontend', 'dist', 'index.html'));
    }
  });

  it('falls back to the browser when Electron is unusable, and says why', () => {
    // ADR-0009 calls Electron's postinstall binary download the most likely
    // install failure (corporate proxies). The app still works — the window
    // does not — so the fallback happens by itself and names the reason, which
    // is how the user learns that `--browser` is the permanent workaround.
    const noBinary = buildLaunchPlan([], completeInstall({ resolveElectron: () => null }));
    expect(noBinary.mode).toBe('browser');
    expect(noBinary.fallbackFrom).toBe('electron');
    expect(noBinary.reason).toBe('electron-missing');

    // Same fallback when the shell script itself is not in the package.
    const noMain = buildLaunchPlan(
      [],
      completeInstall({
        exists: fakeExists([
          path.join(INSTALL_ROOT, 'backend', 'server.js'),
          path.join(INSTALL_ROOT, 'frontend', 'dist', 'index.html'),
        ]),
      })
    );
    expect(noMain.mode).toBe('browser');
    expect(noMain.reason).toBe('electron-main-missing');

    // An explicit --browser is a choice, not a fallback.
    const chosen = buildLaunchPlan(['--browser'], completeInstall());
    expect(chosen.mode).toBe('browser');
    expect(chosen.fallbackFrom).toBeUndefined();
    expect(chosen.reason).toBeUndefined();
  });
});

// Found on an Ubuntu 24.04 laptop (2026-09-16): `syflo` started the backend,
// then Electron died with "The SUID sandbox helper binary was found, but is not
// configured correctly" — Ubuntu locks unprivileged user namespaces, and the
// helper npm installs into $HOME can never be root-owned. The launcher must see
// this coming instead of letting the FATAL look like a closed window.
describe('Linux sandbox lock (Ubuntu 24.04+)', () => {
  const ELECTRON = '/home/someone/.nvm/versions/node/v22.3.0/lib/node_modules/syflo/node_modules/electron/dist/electron';
  const HELPER = path.join(path.dirname(ELECTRON), 'chrome-sandbox');
  const RESTRICT_FILE = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';

  // The failing machine: sysctl says 1, helper is a plain user file, no profile.
  function lockedUbuntu(overrides = {}) {
    return {
      electronBinary: ELECTRON,
      platform: 'linux',
      readFile: (file) => (file === RESTRICT_FILE ? '1\n' : null),
      stat: (file) => (file === HELPER ? { uid: 1000, mode: 0o100755 } : null),
      exists: () => false,
      ...overrides,
    };
  }

  it('detects the lock only when every condition holds', () => {
    expect(detectLinuxSandboxBlock(lockedUbuntu())).toBe(true);

    // Not Linux: no such restriction exists.
    expect(detectLinuxSandboxBlock(lockedUbuntu({ platform: 'darwin' }))).toBe(false);
    // Sysctl off, or absent (older kernels, other distributions).
    expect(detectLinuxSandboxBlock(lockedUbuntu({ readFile: () => '0\n' }))).toBe(false);
    expect(detectLinuxSandboxBlock(lockedUbuntu({ readFile: () => null }))).toBe(false);
    // The profile is installed: this binary is exempt.
    expect(
      detectLinuxSandboxBlock(lockedUbuntu({ exists: (file) => file === APPARMOR_PROFILE_TARGET }))
    ).toBe(false);
    // Someone did the chown root + chmod 4755 by hand: the SUID path works.
    expect(
      detectLinuxSandboxBlock(lockedUbuntu({ stat: () => ({ uid: 0, mode: 0o104755 }) }))
    ).toBe(false);
    // Root-owned but not setuid is NOT enough — that is exactly Chromium's complaint.
    expect(
      detectLinuxSandboxBlock(lockedUbuntu({ stat: () => ({ uid: 0, mode: 0o100755 }) }))
    ).toBe(true);
    // Nothing to check without a binary; the electron-missing path handles that.
    expect(detectLinuxSandboxBlock(lockedUbuntu({ electronBinary: null }))).toBe(false);
  });

  it('falls back to the browser with its own reason, so the message can name the way out', () => {
    const locked = lockedUbuntu();
    const deps = completeInstall({
      resolveElectron: () => ELECTRON,
      platform: 'linux',
      readFile: locked.readFile,
      stat: locked.stat,
      // The fake filesystem has the install but no /etc/apparmor.d/syflo.
    });

    const plan = buildLaunchPlan([], deps);
    expect(plan.mode).toBe('browser');
    expect(plan.fallbackFrom).toBe('electron');
    expect(plan.reason).toBe('linux-sandbox');

    // Same machine after `sudo syflo --install-linux-sandbox`: the window is back.
    const fixed = buildLaunchPlan([], {
      ...deps,
      exists: (file) => file === APPARMOR_PROFILE_TARGET || deps.exists(file),
    });
    expect(fixed.mode).toBe('electron');

    // macOS and Windows never run the probes at all.
    expect(buildLaunchPlan([], { ...deps, platform: 'darwin' }).mode).toBe('electron');
    expect(buildLaunchPlan([], { ...deps, platform: 'win32' }).mode).toBe('electron');
  });

  it('turns --install-linux-sandbox into a copy plan from the packaged profile', () => {
    const plan = buildLaunchPlan(['--install-linux-sandbox'], completeInstall({ platform: 'linux' }));
    expect(plan.mode).toBe('install-linux-sandbox');
    expect(plan.platform).toBe('linux');
    expect(plan.profileSource).toBe(path.join(INSTALL_ROOT, 'bin', 'apparmor', 'syflo'));
    expect(plan.profileTarget).toBe('/etc/apparmor.d/syflo');
  });

  it('ships a profile that exempts the electron binary of any install location', () => {
    const profile = fs.readFileSync(path.join(__dirname, '..', APPARMOR_PROFILE_SOURCE), 'utf8');
    // Ubuntu's pattern for VS Code, Slack and Discord: unconfined, plus userns.
    expect(profile).toMatch(/^profile syflo .* flags=\(unconfined\) \{/m);
    expect(profile).toMatch(/^\s+userns,/m);
    // nvm, fnm, volta, /usr/local — the path must not pin a Node version or a prefix.
    expect(profile).toContain('/**/node_modules/syflo/node_modules/electron/dist/electron');
    expect(profile).not.toMatch(/\/v\d+\.\d+\.\d+\//);
    // The profile lives under bin/, which is what puts it in the npm package.
    expect(APPARMOR_PROFILE_SOURCE.startsWith('bin' + path.sep)).toBe(true);
  });

  // The installer runs as root and cannot be exercised here (house rule: no
  // process, and certainly no sudo). What CAN be pinned is the one line that
  // was wrong on the first real run: copyFileSync as root kept the source
  // file's owner, so /etc/apparmor.d/syflo belonged to the user. Policy files
  // belong to root, like every profile Ubuntu ships.
  it('hands the installed profile to root instead of copying the owner along', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'syflo.js'), 'utf8');
    expect(source).toContain('fs.chownSync(plan.profileTarget, 0, 0)');
    expect(source).not.toContain('fs.copyFileSync(');
  });
});

describe('root package.json', () => {
  // Read as a file, never through `npm pack`: packing is a process, and a test
  // must not start one.
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
  );

  it('publishes the syflo command with a package that carries only what it runs', () => {
    expect(pkg.name).toBe('syflo');
    expect(pkg.license).toBe('MIT');
    // `npm pkg fix` normalises the bin path (drops the leading "./"), and
    // npm accepts both spellings; the test pins the file, not the prefix.
    expect(pkg.bin.syflo.replace(/^\.\//, '')).toBe('bin/syflo.js');
    // ADR-0009: Node >= 20 is the install prerequisite.
    expect(pkg.engines.node).toBe('>=20');
    // Electron is a regular dependency (its npm binaries carry no quarantine
    // attribute, so the window needs no code signing).
    expect(pkg.dependencies.electron).toBeDefined();

    const files = pkg.files;
    expect(files).toContain('bin/');
    expect(files).toContain('backend/');
    expect(files).toContain('frontend/dist/');
    // The repo is not the package: mockups, articles, scripts and every test
    // suite stay out — and the backend's own tests are excluded explicitly,
    // because `backend/` would otherwise drag them in.
    expect(files).toContain('!backend/tests/');
    // Found by inspecting `npm pack --dry-run` by hand: backend/.gitignore
    // covers `*.db`, so an 8.8 MB file named `syflo.db.backup-...` slipped
    // through the pattern and would have been published — someone's real
    // chats. The package must exclude every database-shaped file.
    expect(files).toContain('!backend/*.db*');
    for (const excluded of ['design/', 'article/', 'tests/', 'searxng/']) {
      expect(files.some((entry) => entry.startsWith(excluded))).toBe(false);
    }
    // scripts/ is excluded EXCEPT the postinstall script, and that exception is
    // pinned rather than loosened: without the file in the package,
    // `npm install -g syflo` would run it, hit MODULE_NOT_FOUND and fail the
    // install outright — the opposite of what a skippable model download is for.
    expect(files.filter((entry) => entry.startsWith('scripts/')))
      .toEqual(['scripts/download-embedding-model.js']);
  });

  // Found by installing the packed tarball and opening it (2026-08-21):
  // frontend/dist was FIVE DAYS old, so the package shipped a stale UI with a
  // current backend — the first-run screen still replaced the composer instead
  // of keeping it usable. `npm pack` copies dist, it never builds it, and
  // nothing forced a build. prepack does.
  it('builds the frontend before packing, so the tarball can never ship a stale UI', () => {
    expect(pkg.scripts.prepack).toBeTruthy();
    expect(pkg.scripts.prepack).toMatch(/frontend/);
    expect(pkg.scripts.prepack).toMatch(/build/);
  });
});

describe('electron/main.js', () => {
  // main.js cannot be required here — it pulls in the electron runtime — so the
  // agreement is checked where it can be: the file delegates to resolvePaths,
  // and resolvePaths answers both start routes with the same paths.
  it('resolves its parts through the same resolvePaths, package route and bundle route alike', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    expect(source).toContain('resolvePaths');
    expect(source).toContain('bin/lib/launch');

    const bundleResources = '/Applications/Syflo.app/Contents/Resources';
    const bundle = resolvePaths({
      packageRoot: INSTALL_ROOT,
      resourcesPath: bundleResources,
      exists: fakeExists([
        path.join(bundleResources, 'backend', 'server.js'),
        path.join(bundleResources, 'frontend', 'index.html'),
      ]),
    });
    // The pre-npm extraResources layout keeps working: it is one more place to
    // look, not a replacement.
    expect(bundle.layout).toBe('bundle');
    expect(bundle.backendEntry).toBe(path.join(bundleResources, 'backend', 'server.js'));
    expect(bundle.frontendDir).toBe(path.join(bundleResources, 'frontend'));

    // Started from npm (or a clone), the window resolves exactly what the CLI
    // hands the backend — one answer for both routes.
    const deps = completeInstall();
    const fromWindow = resolvePaths({
      packageRoot: INSTALL_ROOT,
      resourcesPath: bundleResources,
      exists: deps.exists,
    });
    const fromCli = buildLaunchPlan([], deps);
    expect(fromWindow.layout).toBe('package');
    expect(fromWindow.backendEntry).toBe(fromCli.backendEntry);
    expect(fromWindow.frontendDir).toBe(fromCli.frontendDir);
  });
});
