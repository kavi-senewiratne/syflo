import { describe, expect, it } from 'vitest';
import { resourceLabel } from '../html/resourceLabel';

describe('resourceLabel', () => {
  it('names a resource by file and host', () => {
    expect(resourceLabel('https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-mml-chtml.js'))
      .toBe('tex-mml-chtml.js (cdnjs.cloudflare.com)');
  });

  it('drops the query string', () => {
    expect(resourceLabel('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans'))
      .toBe('css2 (fonts.googleapis.com)');
  });

  it('falls back to the host for a bare origin', () => {
    expect(resourceLabel('https://example.org/')).toBe('example.org');
  });

  it('returns an unparsable address verbatim', () => {
    expect(resourceLabel('not a url')).toBe('not a url');
  });
});
