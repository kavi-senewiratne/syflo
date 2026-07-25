import '@testing-library/jest-dom';

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
