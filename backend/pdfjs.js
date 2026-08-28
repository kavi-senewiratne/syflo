/**
 * pdfjs.js
 *
 * The one place that loads pdf.js.
 *
 * pdf.js is ESM-only, so a CommonJS module can't `require()` it. The
 * `new Function` wrapper keeps babel-jest from rewriting `import()` back into
 * `require()` — the import has to run through Node's real ESM loader, under
 * Jest too.
 *
 * pdf-text.js and pdf-citations.js each carried their own copy of this loader,
 * each with its own memo of the same specifier. Two memos mean two import
 * calls for one module, and under Jest's VM-modules loader the second one
 * intermittently came back as a different module instance — "Provided module
 * is not an instance of Module", roughly two runs in five, only when both
 * suites landed in the same worker. One memo, one instance.
 *
 * A FAILED import is deliberately not kept: memoising the rejection poisoned
 * pdf handling for the whole life of the backend process, with no way back
 * short of a restart. Dropping it lets the next caller try again.
 */

const importEsm = new Function('specifier', 'return import(specifier)');

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = importEsm('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
      pdfjsPromise = null;
      throw err;
    });
  }
  return pdfjsPromise;
}

module.exports = { loadPdfjs };
