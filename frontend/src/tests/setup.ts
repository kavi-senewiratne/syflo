import '@testing-library/jest-dom';
import { beforeEach } from 'vitest';

// The sidebar folds the older history sections away ONCE per browser and
// records that in localStorage (Sidebar/index.tsx). jsdom hands every test a
// fresh browser, so without this the default would fire in all of them, and
// the two dozen suites whose fixtures carry real dates from months ago would
// suddenly be asserting against a folded-up list they never meant to test.
// Pre-setting the flag puts every test in the position of a browser that has
// already seen the default; the suites that test the default itself clear
// localStorage in their own beforeEach and get it back.
beforeEach(() => {
  localStorage.setItem('syflo.sidebarOlderGroupsCollapsed', '1');
});

// jsdom does not implement scrollIntoView
window.HTMLElement.prototype.scrollIntoView = () => {};

// jsdom does not implement ResizeObserver (used e.g. for the expandable
// "Branched from" quote in ChatArea). No-op is enough — layout-dependent
// behavior is driven via mocked scrollHeight/clientHeight in the tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom kennt kein DOMMatrix; pdf.js referenziert es schon beim Import.
// Fürs reine Parsen (pdfParse.test.ts) reicht eine Identitätsmatrix.
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  } as unknown as typeof DOMMatrix;
}
