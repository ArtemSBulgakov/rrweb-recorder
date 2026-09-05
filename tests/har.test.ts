import { describe, expect, it } from 'vitest';
import {
  applyHarResponse,
  bodyByteLength,
  createHarEntry,
  durationFromTimings,
  mergeHarHeaders,
  setHarRequestBody,
  setHarResponseBody,
  timingsFromResourceTiming,
  wrapHarEntries,
} from '../src/shared/har';
import { buildCaptureDiagnostics, buildStandManifest } from '../src/shared/export';

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
      sessionId: 'root',
      targetType: 'page',
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

  it('keeps binary response bodies byte-for-byte in base64', () => {
    const bytes = Uint8Array.from([0, 255, 10, 20, 30, 40]);
    const base64 = Buffer.from(bytes).toString('base64');
    const entry = createHarEntry({
      requestId: 'binary',
      tabId: 1,
      sessionId: 'root',
      targetType: 'page',
      wallTimeMs: 1,
      url: 'https://example.test/font.woff2',
      method: 'GET',
      type: 'Font',
    });
    setHarResponseBody(entry, base64, true);

    expect(entry.response.content.encoding).toBe('base64');
    expect(entry.response.content.size).toBe(bytes.byteLength);
    expect(bodyByteLength(base64, true)).toBe(bytes.byteLength);
    expect(Buffer.from(entry.response.content.text!, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('marks bodyless startup resources incomplete', () => {
    const document = createHarEntry({
      requestId: 'doc',
      tabId: 1,
      sessionId: 'root',
      targetType: 'page',
      wallTimeMs: 1,
      url: 'https://visa.almaviva-russia.ru/appointment',
      method: 'GET',
      type: 'Document',
    });
    document.response.status = 200;
    setHarResponseBody(document, '<html></html>');
    const script = createHarEntry({
      requestId: 'script',
      tabId: 1,
      sessionId: 'root',
      targetType: 'page',
      wallTimeMs: 2,
      url: 'https://visa.almaviva-russia.ru/main.js',
      method: 'GET',
      type: 'Script',
    });
    script.response.status = 200;

    const recording = {
      id: 'r1',
      title: 'Test',
      startedAt: 1,
      active: false,
      eventCount: 0,
      tabActivity: [],
      tabs: [{
        tabId: 1,
        title: 'AlmaViva',
        url: 'https://visa.almaviva-russia.ru/appointment',
        startedAt: 1,
        eventCount: 0,
      }],
    };
    const diagnostics = buildCaptureDiagnostics(recording, [
      { recordingId: 'r1', tabId: 1, sessionId: 'root', requestId: 'doc', entry: document },
      { recordingId: 'r1', tabId: 1, sessionId: 'root', requestId: 'script', entry: script },
    ]);

    expect(diagnostics.complete).toBe(false);
    expect(diagnostics.errors.map((error) => error.code)).toContain('missing-runtime-config');
    expect(diagnostics.errors.map((error) => error.code)).toContain('missing-response-body');
    expect(buildStandManifest(recording)).toEqual({
      version: 1,
      startUrl: 'https://visa.almaviva-russia.ru/appointment',
      capturedAt: 1,
      har: '../recording.har',
      storageState: './storage-state.json',
    });
  });

  it('keeps ExtraInfo Set-Cookie when later response headers arrive', () => {
    const entry = createHarEntry({
      requestId: 'cookie',
      tabId: 1,
      sessionId: 'root',
      targetType: 'page',
      wallTimeMs: 1,
      url: 'https://example.test/api',
      method: 'GET',
      type: 'XHR',
    });
    entry.response.headers = mergeHarHeaders(entry.response.headers, [
      { name: 'set-cookie', value: 'session=secret' },
      { name: 'content-type', value: 'application/json' },
    ]);
    applyHarResponse(entry, {
      status: 200,
      statusText: 'OK',
      headers: [
        { name: 'content-type', value: 'application/json' },
        { name: 'cache-control', value: 'no-store' },
      ],
    });
    expect(entry.response.headers).toContainEqual({
      name: 'set-cookie',
      value: 'session=secret',
    });
    expect(entry.response.headers).toContainEqual({
      name: 'cache-control',
      value: 'no-store',
    });
  });

  it('uses the final Document body after redirect hops', () => {
    const redirect = createHarEntry({
      requestId: 'doc',
      tabId: 1,
      sessionId: 'root',
      targetType: 'page',
      wallTimeMs: 1,
      url: 'http://example.test/',
      method: 'GET',
      type: 'Document',
    });
    redirect.response.status = 302;
    const finalDocument = createHarEntry({
      requestId: 'doc:r1',
      tabId: 1,
      sessionId: 'root',
      targetType: 'page',
      wallTimeMs: 2,
      url: 'https://example.test/',
      method: 'GET',
      type: 'Document',
    });
    finalDocument.response.status = 200;
    setHarResponseBody(finalDocument, '<html>final</html>');

    const diagnostics = buildCaptureDiagnostics({
      id: 'r2',
      title: 'Redirect',
      startedAt: 1,
      active: false,
      eventCount: 0,
      tabActivity: [],
      tabs: [{
        tabId: 1,
        title: 'Example',
        url: 'https://example.test/',
        startedAt: 1,
        eventCount: 0,
      }],
    }, [
      { recordingId: 'r2', tabId: 1, sessionId: 'root', requestId: 'doc', entry: redirect },
      { recordingId: 'r2', tabId: 1, sessionId: 'root', requestId: 'doc:r1', entry: finalDocument },
    ]);

    expect(diagnostics.errors.map((error) => error.code)).not.toContain('missing-main-document-body');
  });
});
