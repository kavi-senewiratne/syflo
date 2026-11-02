/**
 * html/resourceLabel.ts
 *
 * The short name of a page resource for the "not frozen" lines (freeze card
 * under the first answer, warnings popover in the HtmlPane header). The
 * mockup (design/mockup-html-source.html §02) names a resource by what it is
 * and where it comes from — "MathJax (cdnjs.cloudflare.com)" — never by its
 * full address: a 90-character URL in a 300px chat column wraps three times
 * and the reason at its end gets cut mid-word. File name + host carries the
 * same information in one line; the reason stays verbatim next to it.
 */
export function resourceLabel(url: string): string {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return file ? `${file} (${u.host})` : u.host;
  } catch {
    return url;
  }
}
