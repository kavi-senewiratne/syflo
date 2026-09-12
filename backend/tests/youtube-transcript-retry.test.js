/**
 * tests/youtube-transcript-retry.test.js
 *
 * Tests for fetchTranscript's retry behaviour. YouTube's timedtext endpoint
 * answers in ~100 ms or not at all — measured live on 2026-08-28, roughly a
 * third of the calls never came back, while every successful one landed
 * between 90 ms and 5 s. A single attempt therefore failed the import a
 * third of the time and showed Node's raw "The operation was aborted due to
 * timeout" in the modal.
 *
 * The Innertube instance is injected (same pattern as routes/papers.js);
 * global.fetch is mocked so no test touches the network.
 */
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const { fetchTranscript } = require('../youtube');

const SRV3 = `<?xml version="1.0" encoding="utf-8"?>
<timedtext format="3"><body>
<p t="160" d="4080"><s>hi</s><s> everyone</s></p>
</body></timedtext>`;

// A caption track whose base_url is unique per call — the real endpoint
// signs each one with its own `ei`/`expire`, and re-reading the track is
// exactly what the retry is for.
function fakeInnertube({ tracks } = {}) {
  let issued = 0;
  const yt = {
    calls: 0,
    async getBasicInfo() {
      yt.calls += 1;
      issued += 1;
      return {
        basic_info: { title: 'Waymo', author: 'Y Combinator', duration: 2964 },
        captions: {
          caption_tracks:
            tracks ?? [{ base_url: `https://yt/timedtext?ei=${issued}`, language_code: 'en', kind: 'asr' }],
        },
      };
    },
  };
  return yt;
}

function timeoutError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

function okResponse(body) {
  return { ok: true, status: 200, text: async () => body };
}

afterEach(() => {
  delete global.fetch;
});

describe('fetchTranscript retries the caption fetch', () => {
  it('succeeds on a later attempt after timeouts, re-reading the track each time', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(timeoutError())
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(okResponse(SRV3));
    const yt = fakeInnertube();

    const info = await fetchTranscript('Gp4zrV3-6N8', { innertube: yt, retryDelayMs: 0 });

    expect(info.segments).toEqual([{ startMs: 160, text: 'hi everyone' }]);
    expect(info.title).toBe('Waymo');
    expect(global.fetch).toHaveBeenCalledTimes(3);
    // A URL that just timed out kept timing out in the measurements, so
    // every attempt asks for a freshly signed one.
    expect(yt.calls).toBe(3);
    const urls = global.fetch.mock.calls.map((c) => c[0]);
    expect(new Set(urls).size).toBe(3);
  });

  it('treats an empty caption body as a failed attempt, not as "no captions"', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(okResponse(''))
      .mockResolvedValueOnce(okResponse(SRV3));

    const info = await fetchTranscript('Gp4zrV3-6N8', { innertube: fakeInnertube(), retryDelayMs: 0 });

    expect(info.segments).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up with code captions-unavailable when every attempt fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(timeoutError());
    const yt = fakeInnertube();

    await expect(fetchTranscript('Gp4zrV3-6N8', { innertube: yt, retryDelayMs: 0 })).rejects.toMatchObject({
      code: 'captions-unavailable',
    });
    expect(global.fetch.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops at once on Google\'s throttle instead of retrying into it', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, text: async () => '<html>Sorry…' });
    const yt = fakeInnertube();

    await expect(fetchTranscript('Gp4zrV3-6N8', { innertube: yt, retryDelayMs: 0 })).rejects.toMatchObject({
      code: 'captions-rate-limited',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a video that carries no caption track at all', async () => {
    global.fetch = jest.fn();
    const yt = fakeInnertube({ tracks: [] });

    await expect(fetchTranscript('Gp4zrV3-6N8', { innertube: yt, retryDelayMs: 0 })).rejects.toMatchObject({
      code: 'no-transcript',
    });
    // No captions today means no captions in 400 ms either — one look is enough.
    expect(yt.calls).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('prefers a manually maintained track over auto captions', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse(SRV3));
    const yt = fakeInnertube({
      tracks: [
        { base_url: 'https://yt/asr', language_code: 'en', kind: 'asr' },
        { base_url: 'https://yt/manual', language_code: 'de' },
      ],
    });

    const info = await fetchTranscript('Gp4zrV3-6N8', { innertube: yt, retryDelayMs: 0 });

    expect(global.fetch).toHaveBeenCalledWith('https://yt/manual', expect.anything());
    expect(info.language).toBe('de');
  });

  it('picks the manual track in the spoken language, not the first translation', async () => {
    // The 3Blue1Brown case (2026-09-10): an English lecture with fan-made
    // translations listed alphabetically — Arabic first. The ASR track names
    // the spoken language; the manual track in that language must win.
    global.fetch = jest.fn().mockResolvedValue(okResponse(SRV3));
    const yt = fakeInnertube({
      tracks: [
        { base_url: 'https://yt/manual-ar', language_code: 'ar' },
        { base_url: 'https://yt/manual-en', language_code: 'en-US' },
        { base_url: 'https://yt/manual-fr', language_code: 'fr' },
        { base_url: 'https://yt/asr', language_code: 'en', kind: 'asr' },
      ],
    });

    const info = await fetchTranscript('Gp4zrV3-6N8', { innertube: yt, retryDelayMs: 0 });

    expect(global.fetch).toHaveBeenCalledWith('https://yt/manual-en', expect.anything());
    expect(info.language).toBe('en-US');
  });
});
