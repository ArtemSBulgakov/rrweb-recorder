import { describe, expect, it } from 'vitest';
import {
  createHarEntry,
  durationFromTimings,
  setHarRequestBody,
  setHarResponseBody,
  timingsFromResourceTiming,
  wrapHarEntries,
} from '../src/shared/har';

describe('HAR timings', () => {
  it('maps CDP resource timing to HAR timings', () => {
    const timings = timingsFromResourceTiming(
      {
        requestTime: 100,
        proxyStart: -1,
        proxyEnd: -1,
        dnsStart: 1,
        dnsEnd: 3,
        connectStart: 3,
        connectEnd: 10,
        sslStart: 4,
        sslEnd: 9,
        workerStart: -1,
        workerReady: -1,
        sendStart: 10,
        sendEnd: 11,
        receiveHeadersEnd: 40,
        pushStart: 0,
        pushEnd: 0,
      },
      100,
      100.04,
      100.09,
    );
    expect(timings).toEqual({
      blocked: 1,
      dns: 2,
      connect: 7,
      ssl: 5,
      send: 1,
      wait: 29,
      receive: 50,
    });
    expect(durationFromTimings(timings)).toBe(90);
  });

  it('builds and wraps HAR entries with bodies', () => {
    const entry = createHarEntry({
      requestId: '1',
      tabId: 1,
      wallTimeMs: 1_700_000_000_000,
      url: 'https://example.com/api?x=1',
      method: 'POST',
      type: 'Fetch',
      headers: { 'content-type': 'application/json' },
    });
    setHarRequestBody(entry, '{"a":1}');
    entry.response.status = 200;
    entry.response.statusText = 'OK';
    entry.timings = {
      blocked: 0,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 1,
      wait: 30,
      receive: 11,
    };
    entry.time = 42;
    setHarResponseBody(entry, '{"ok":true}');

    const har = wrapHarEntries([entry], { title: 'Test', startedAt: 1_700_000_000_000 });
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.method).toBe('POST');
    expect(har.log.entries[0].request.postData?.text).toBe('{"a":1}');
    expect(har.log.entries[0].request.queryString).toEqual([{ name: 'x', value: '1' }]);
    expect(har.log.entries[0].response.content.text).toBe('{"ok":true}');
    expect(har.log.entries[0].time).toBe(42);
    expect(har.log.entries[0].timings.wait).toBe(30);
  });
});
