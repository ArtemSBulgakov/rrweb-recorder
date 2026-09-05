import { beforeEach, describe, expect, it, vi } from 'vitest';

const putHarEntry = vi.fn(async (_entry: unknown) => undefined);
const sendCommand = vi.fn();
const attach = vi.fn();
const detach = vi.fn();

vi.mock('../src/storage/db', () => ({ putHarEntry }));
vi.stubGlobal('chrome', {
  debugger: {
    sendCommand,
    attach,
    detach,
  },
});

describe('CDP network capture', () => {
  beforeEach(() => {
    putHarEntry.mockClear();
    sendCommand.mockReset();
    attach.mockReset();
    detach.mockReset();
  });

  it('uses tab and session identity in request keys', async () => {
    const { networkRequestKey } = await import('../src/background/network-capture');
    expect(networkRequestKey(1, undefined, '42')).toBe('1:root:42');
    expect(networkRequestKey(1, 'worker', '42')).toBe('1:worker:42');
    expect(networkRequestKey(2, undefined, '42')).toBe('2:root:42');
  });

  it('detaches when debugger setup fails after attach', async () => {
    const { attachNetworkDebugger } = await import('../src/background/network-capture');
    attach.mockResolvedValue(undefined);
    detach.mockResolvedValue(undefined);
    sendCommand.mockRejectedValueOnce(new Error('auto-attach failed'));

    await expect(attachNetworkDebugger(13)).resolves.toBe(false);
    expect(detach).toHaveBeenCalledWith({ tabId: 13 });
  });

  it('serializes concurrent debugger attachment for one tab', async () => {
    const { attachNetworkDebugger, detachNetworkDebugger } =
      await import('../src/background/network-capture');
    attach.mockResolvedValue(undefined);
    detach.mockResolvedValue(undefined);
    sendCommand.mockResolvedValue(undefined);

    await expect(Promise.all([
      attachNetworkDebugger(14),
      attachNetworkDebugger(14),
    ])).resolves.toEqual([true, true]);
    expect(attach).toHaveBeenCalledTimes(1);
    await detachNetworkDebugger(14);
  });

  it('waits for pending debugger attachments before cleanup', async () => {
    const {
      attachNetworkDebugger,
      detachNetworkDebugger,
      networkDebuggerTabIds,
      settleNetworkDebuggerAttachments,
    } = await import('../src/background/network-capture');
    let resolveAttach!: () => void;
    attach.mockImplementation(() => new Promise<void>((resolve) => {
      resolveAttach = resolve;
    }));
    detach.mockResolvedValue(undefined);
    sendCommand.mockResolvedValue(undefined);

    const attaching = attachNetworkDebugger(16);
    const settling = settleNetworkDebuggerAttachments();
    let settled = false;
    void settling.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveAttach();
    await attaching;
    await settling;
    expect(networkDebuggerTabIds()).toContain(16);
    await detachNetworkDebugger(16);
  });

  it('applies extra headers that arrive before the request event', async () => {
    const { handleNetworkDebuggerEvent } = await import('../src/background/network-capture');
    await handleNetworkDebuggerEvent(9, undefined, 'early-extra', 'Network.requestWillBeSentExtraInfo', {
      requestId: 'early',
      headers: { authorization: 'Bearer secret' },
    });
    await handleNetworkDebuggerEvent(9, undefined, 'early-extra', 'Network.responseReceivedExtraInfo', {
      requestId: 'early',
      statusCode: 201,
      headers: { 'set-cookie': 'session=secret' },
    });
    await handleNetworkDebuggerEvent(9, undefined, 'early-extra', 'Network.requestWillBeSent', {
      requestId: 'early',
      timestamp: 1,
      wallTime: 1,
      type: 'Fetch',
      request: { url: 'https://example.test/early', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(9, undefined, 'early-extra', 'Network.responseReceived', {
      requestId: 'early',
      timestamp: 1.05,
      type: 'Fetch',
      hasExtraInfo: true,
      response: {
        status: 201,
        statusText: 'Created',
        headers: {},
        mimeType: 'application/json',
      },
    });

    const stored = [...putHarEntry.mock.calls].reverse().find(([item]) =>
      (item as { entry: { response: { status: number } } }).entry.response.status === 201)?.[0] as {
      entry: {
        request: { headers: Array<{ name: string; value: string }> };
        response: { status: number; headers: Array<{ name: string; value: string }> };
      };
    };
    expect(stored.entry.request.headers).toContainEqual({
      name: 'authorization',
      value: 'Bearer secret',
    });
    expect(stored.entry.response.status).toBe(201);
    expect(stored.entry.response.headers).toContainEqual({
      name: 'set-cookie',
      value: 'session=secret',
    });
    await handleNetworkDebuggerEvent(9, undefined, 'early-extra', 'Network.loadingFailed', {
      requestId: 'early',
      timestamp: 1.1,
      type: 'Fetch',
      errorText: 'cancelled by test',
    });
  });

  it('stores each redirect in a separate ordered HAR entry', async () => {
    const {
      drainNetworkCapture,
      handleNetworkDebuggerEvent,
    } = await import('../src/background/network-capture');
    sendCommand.mockImplementation((_target, method) => {
      if (method === 'Network.getResponseBody') {
        return Promise.resolve({ body: 'done', base64Encoded: false });
      }
      return Promise.resolve({});
    });

    await handleNetworkDebuggerEvent(11, undefined, 'redirects', 'Network.requestWillBeSent', {
      requestId: 'chain',
      timestamp: 1,
      wallTime: 1,
      type: 'Document',
      request: { url: 'https://example.test/start', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(11, undefined, 'redirects', 'Network.requestWillBeSent', {
      requestId: 'chain',
      timestamp: 1.1,
      wallTime: 1.1,
      type: 'Document',
      redirectResponse: {
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://example.test/end' },
      },
      request: { url: 'https://example.test/end', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(11, undefined, 'redirects', 'Network.responseReceived', {
      requestId: 'chain',
      timestamp: 1.2,
      type: 'Document',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html' },
    });
    await handleNetworkDebuggerEvent(11, undefined, 'redirects', 'Network.loadingFinished', {
      requestId: 'chain',
      timestamp: 1.3,
    });
    await drainNetworkCapture(1_000);

    const stored = putHarEntry.mock.calls.map(([entry]) => entry as {
      requestId: string;
      entry: { request: { url: string }; response: { status: number; redirectURL: string } };
    });
    expect(stored.some((item) =>
      item.requestId === 'chain'
      && item.entry.request.url === 'https://example.test/start'
      && item.entry.response.status === 302
      && item.entry.response.redirectURL === 'https://example.test/end')).toBe(true);
    expect(stored.some((item) =>
      item.requestId === 'chain:r1'
      && item.entry.request.url === 'https://example.test/end'
      && item.entry.response.status === 200)).toBe(true);
  });

  it('does not apply redirect ExtraInfo status to the destination response', async () => {
    const { handleNetworkDebuggerEvent } = await import('../src/background/network-capture');
    await handleNetworkDebuggerEvent(12, undefined, 'redirect-extra', 'Network.requestWillBeSent', {
      requestId: 'chain-extra',
      timestamp: 1,
      wallTime: 1,
      type: 'Document',
      request: { url: 'https://example.test/start', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(12, undefined, 'redirect-extra', 'Network.requestWillBeSent', {
      requestId: 'chain-extra',
      timestamp: 1.1,
      wallTime: 1.1,
      type: 'Document',
      redirectHasExtraInfo: true,
      redirectResponse: {
        status: 302,
        statusText: 'Found',
        headers: { location: 'https://example.test/end' },
      },
      request: { url: 'https://example.test/end', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(12, undefined, 'redirect-extra', 'Network.responseReceivedExtraInfo', {
      requestId: 'chain-extra',
      statusCode: 302,
      headers: {
        location: 'https://example.test/end',
        'set-cookie': 'redirect=secret',
      },
    });
    await handleNetworkDebuggerEvent(12, undefined, 'redirect-extra', 'Network.responseReceived', {
      requestId: 'chain-extra',
      timestamp: 1.2,
      type: 'Document',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html' },
    });

    const stored = putHarEntry.mock.calls.map(([entry]) => entry as {
      requestId: string;
      entry: { response: { status: number; headers: Array<{ name: string; value: string }> } };
    });
    const redirect = stored.find((item) =>
      item.requestId === 'chain-extra'
      && item.entry.response.headers.some((header) => header.name === 'set-cookie'));
    const destination = stored.at(-1);
    expect(redirect?.entry.response.status).toBe(302);
    expect(destination?.requestId).toBe('chain-extra:r1');
    expect(destination?.entry.response.status).toBe(200);
    await handleNetworkDebuggerEvent(12, undefined, 'redirect-extra', 'Network.loadingFailed', {
      requestId: 'chain-extra',
      timestamp: 1.3,
      type: 'Document',
      errorText: 'cancelled by test',
    });
  });

  it('configures and resumes an attached child target session', async () => {
    const { handleTargetDebuggerEvent } = await import('../src/background/network-capture');
    sendCommand.mockResolvedValue(undefined);

    await handleTargetDebuggerEvent(15, 'target-recording', 'Target.attachedToTarget', {
      sessionId: 'child-session',
      targetInfo: { type: 'worker' },
    });

    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 15, sessionId: 'child-session' },
      'Network.enable',
      expect.any(Object),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 15, sessionId: 'child-session' },
      'Network.setBypassServiceWorker',
      { bypass: true },
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 15, sessionId: 'child-session' },
      'Runtime.runIfWaitingForDebugger',
    );
  });

  it('drains a response body task before returning', async () => {
    const {
      drainNetworkCapture,
      handleNetworkDebuggerEvent,
    } = await import('../src/background/network-capture');
    let resolveBody!: (value: { body: string; base64Encoded: boolean }) => void;
    sendCommand.mockImplementation((_target, method) => {
      if (method === 'Network.getResponseBody') {
        return new Promise((resolve) => {
          resolveBody = resolve;
        });
      }
      return Promise.resolve({});
    });

    await handleNetworkDebuggerEvent(7, 'worker-1', 'recording', 'Network.requestWillBeSent', {
      requestId: 'request',
      timestamp: 1,
      wallTime: 1,
      type: 'Fetch',
      request: {
        url: 'https://example.test/api',
        method: 'GET',
        headers: {},
      },
    });
    await handleNetworkDebuggerEvent(7, 'worker-1', 'recording', 'Network.responseReceived', {
      requestId: 'request',
      timestamp: 1.1,
      type: 'Fetch',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' },
    });
    await handleNetworkDebuggerEvent(7, 'worker-1', 'recording', 'Network.loadingFinished', {
      requestId: 'request',
      timestamp: 1.2,
      encodedDataLength: 11,
    });

    let drained = false;
    const drain = drainNetworkCapture(5_000).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolveBody({ body: '{"ok":true}', base64Encoded: false });
    await drain;

    const stored = putHarEntry.mock.calls.at(-1)?.[0] as {
      sessionId: string;
      entry: {
        response: { content: { text?: string } };
        _sessionId?: string;
      };
    };
    expect(stored.sessionId).toBe('worker-1');
    expect(stored.entry.response.content.text).toBe('{"ok":true}');
    expect(stored.entry._sessionId).toBe('worker-1');
  });

  it('persists a timeout error for unfinished body capture', async () => {
    const {
      drainNetworkCapture,
      handleNetworkDebuggerEvent,
    } = await import('../src/background/network-capture');
    sendCommand.mockImplementation((_target, method) => {
      if (method === 'Network.getResponseBody') return new Promise(() => undefined);
      return Promise.resolve({});
    });

    await handleNetworkDebuggerEvent(8, undefined, 'timeout-recording', 'Network.requestWillBeSent', {
      requestId: 'slow',
      timestamp: 1,
      wallTime: 1,
      type: 'Fetch',
      request: { url: 'https://example.test/slow', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(8, undefined, 'timeout-recording', 'Network.responseReceived', {
      requestId: 'slow',
      timestamp: 1.1,
      type: 'Fetch',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json' },
    });
    await handleNetworkDebuggerEvent(8, undefined, 'timeout-recording', 'Network.loadingFinished', {
      requestId: 'slow',
      timestamp: 1.2,
    });

    await drainNetworkCapture(0);
    const stored = putHarEntry.mock.calls.at(-1)?.[0] as {
      entry: { response: { _error?: string }; _captureError?: string };
    };
    expect(stored.entry.response._error).toBe('capture stopped before completion');
    expect(stored.entry._captureError).toBe('capture stopped before completion');
  });

  it('drains body work that starts while an earlier task is settling', async () => {
    const {
      drainNetworkCapture,
      handleNetworkDebuggerEvent,
    } = await import('../src/background/network-capture');
    const resolvers: Array<(value: { body: string; base64Encoded: boolean }) => void> = [];
    sendCommand.mockImplementation((_target, method) => {
      if (method === 'Network.getResponseBody') {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({});
    });

    const request = async (requestId: string) => {
      await handleNetworkDebuggerEvent(10, undefined, 'rolling-drain', 'Network.requestWillBeSent', {
        requestId,
        timestamp: 1,
        wallTime: 1,
        type: 'Fetch',
        request: { url: `https://example.test/${requestId}`, method: 'GET', headers: {} },
      });
      await handleNetworkDebuggerEvent(10, undefined, 'rolling-drain', 'Network.responseReceived', {
        requestId,
        timestamp: 1.1,
        type: 'Fetch',
        response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'text/plain' },
      });
      await handleNetworkDebuggerEvent(10, undefined, 'rolling-drain', 'Network.loadingFinished', {
        requestId,
        timestamp: 1.2,
      });
    };

    await request('first');
    const drain = drainNetworkCapture(5_000);
    await request('second');
    resolvers[0]({ body: 'first', base64Encoded: false });
    while (resolvers.length < 2) await Promise.resolve();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolvers[1]({ body: 'second', base64Encoded: false });
    await drain;
    expect(putHarEntry.mock.calls.some(([stored]) =>
      (stored as { entry: { response: { content: { text?: string } } } })
        .entry.response.content.text === 'second')).toBe(true);
  });

  it('does not wipe ExtraInfo Set-Cookie when responseReceived arrives later', async () => {
    const { handleNetworkDebuggerEvent } = await import('../src/background/network-capture');
    await handleNetworkDebuggerEvent(17, undefined, 'cookie-order', 'Network.requestWillBeSent', {
      requestId: 'cookie-order',
      timestamp: 1,
      wallTime: 1,
      type: 'Fetch',
      request: { url: 'https://example.test/cookie', method: 'GET', headers: {} },
    });
    await handleNetworkDebuggerEvent(17, undefined, 'cookie-order', 'Network.responseReceivedExtraInfo', {
      requestId: 'cookie-order',
      statusCode: 200,
      headers: { 'set-cookie': 'session=secret', 'content-type': 'text/plain' },
    });
    await handleNetworkDebuggerEvent(17, undefined, 'cookie-order', 'Network.responseReceived', {
      requestId: 'cookie-order',
      timestamp: 1.1,
      type: 'Fetch',
      hasExtraInfo: true,
      response: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        mimeType: 'text/plain',
      },
    });

    const stored = putHarEntry.mock.calls.at(-1)?.[0] as {
      entry: { response: { headers: Array<{ name: string; value: string }> } };
    };
    expect(stored.entry.response.headers).toContainEqual({
      name: 'set-cookie',
      value: 'session=secret',
    });
    expect(stored.entry.response.headers).toContainEqual({
      name: 'cache-control',
      value: 'no-store',
    });
    await handleNetworkDebuggerEvent(17, undefined, 'cookie-order', 'Network.loadingFailed', {
      requestId: 'cookie-order',
      timestamp: 1.2,
      type: 'Fetch',
      errorText: 'cancelled by test',
    });
  });
});
