import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEvent,
  deleteRecording,
  getBrowserState,
  getEvents,
  getHarEntries,
  getRecording,
  listRecordings,
  mergeBrowserFrameStorage,
  mergeBrowserOriginStorage,
  putBrowserState,
  putHarEntry,
  putRecording,
} from '../src/storage/db';
import { createHarEntry } from '../src/shared/har';

describe('recording storage', () => {
  beforeEach(async () => {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('rrweb-recorder');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it('stores recordings and tab events in timestamp order', async () => {
    await putRecording({ id: 'r1', title: 'Test', startedAt: 1, active: true, eventCount: 2, tabs: [], tabActivity: [] });
    await addEvent({ recordingId: 'r1', tabId: 4, timestamp: 20, event: { type: 0, data: {}, timestamp: 20 } });
    await addEvent({ recordingId: 'r1', tabId: 4, timestamp: 10, event: { type: 0, data: {}, timestamp: 10 } });
    expect((await getRecording('r1'))?.title).toBe('Test');
    expect((await getEvents('r1', 4)).map((item) => item.timestamp)).toEqual([10, 20]);
    expect(await listRecordings()).toHaveLength(1);
  });

  it('deletes a recording and its events', async () => {
    await putRecording({ id: 'r1', title: 'Test', startedAt: 1, active: false, eventCount: 1, tabs: [], tabActivity: [] });
    await addEvent({ recordingId: 'r1', tabId: 1, timestamp: 1, event: { type: 0, data: {}, timestamp: 1 } });
    await deleteRecording('r1');
    expect(await getRecording('r1')).toBeUndefined();
    expect(await getEvents('r1')).toEqual([]);
  });

  it('does not overwrite matching request IDs from different targets', async () => {
    for (const [tabId, sessionId, targetType] of [
      [1, 'root', 'page'],
      [1, 'worker-1', 'worker'],
      [2, 'root', 'page'],
    ] as const) {
      await putHarEntry({
        recordingId: 'r1',
        tabId,
        sessionId,
        requestId: 'shared-id',
        entry: createHarEntry({
          requestId: 'shared-id',
          tabId,
          sessionId,
          targetType,
          wallTimeMs: tabId,
          url: `https://example.test/${tabId}/${sessionId}`,
          method: 'GET',
          type: 'Fetch',
        }),
      });
    }

    const entries = await getHarEntries('r1');
    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => [entry.tabId, entry.sessionId]).sort()).toEqual([
      [1, 'root'],
      [1, 'worker-1'],
      [2, 'root'],
    ].sort());
  });

  it('migrates version 4 HAR entries into the version 5 compound key store', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('rrweb-recorder', 4);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('recordings', { keyPath: 'id' });
        const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
        events.createIndex('recordingId', 'recordingId');
        events.createIndex('recordingTab', ['recordingId', 'tabId']);
        const network = db.createObjectStore('network', {
          keyPath: ['recordingId', 'requestId'],
        });
        network.createIndex('recordingId', 'recordingId');
        network.createIndex('recordingTab', ['recordingId', 'tabId']);
        network.put({
          recordingId: 'legacy',
          requestId: 'request',
          tabId: 4,
          entry: createHarEntry({
            requestId: 'request',
            tabId: 4,
            sessionId: 'root',
            targetType: 'page',
            wallTimeMs: 1,
            url: 'https://example.test/legacy',
            method: 'GET',
            type: 'Document',
          }),
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    const [entry] = await getHarEntries('legacy');
    expect(entry).toMatchObject({
      recordingId: 'legacy',
      requestId: 'request',
      tabId: 4,
      sessionId: 'root',
      entry: { _sessionId: 'root', _targetType: 'page' },
    });
  });

  it('stores unredacted cookies and origin storage', async () => {
    await putBrowserState({
      recordingId: 'r1',
      capturedAt: 10,
      cookies: [{
        name: 'session',
        value: 'secret-token',
        domain: 'example.test',
        path: '/',
        expires: -1,
        size: 19,
        httpOnly: true,
        secure: true,
        session: true,
        priority: 'Medium',
        sameParty: false,
        sourceScheme: 'Secure',
        sourcePort: 443,
      }],
      origins: {},
    });
    await mergeBrowserOriginStorage('r1', 20, {
      origin: 'https://example.test',
      localStorage: { accessToken: 'secret-token' },
      sessionStorage: { flow: 'private-state' },
    });

    expect(await getBrowserState('r1')).toMatchObject({
      capturedAt: 20,
      cookies: [{ value: 'secret-token' }],
      origins: {
        'https://example.test': {
          localStorage: { accessToken: 'secret-token' },
          sessionStorage: { flow: 'private-state' },
        },
      },
    });
  });

  it('atomically merges concurrent frame storage snapshots', async () => {
    await putBrowserState({
      recordingId: 'frames',
      capturedAt: 1,
      cookies: [],
      origins: {},
    });
    await Promise.all([
      mergeBrowserFrameStorage('frames', 2, {
        tabId: 1,
        frameId: 0,
        origin: 'https://app.test',
        localStorage: { root: 'one' },
        sessionStorage: { rootSession: 'one' },
      }),
      mergeBrowserFrameStorage('frames', 2, {
        tabId: 1,
        frameId: 7,
        origin: 'https://frame.test',
        localStorage: { child: 'two' },
        sessionStorage: { childSession: 'two' },
      }),
    ]);

    const state = await getBrowserState('frames');
    expect(state?.origins['https://app.test'].frames).toHaveLength(1);
    expect(state?.origins['https://frame.test'].frames).toHaveLength(1);
    expect(state?.origins['https://app.test'].localStorage).toEqual({ root: 'one' });
    expect(state?.origins['https://frame.test'].sessionStorage).toEqual({
      childSession: 'two',
    });
  });

  it('preserves captured frames when origin storage arrives without frames', async () => {
    await putBrowserState({
      recordingId: 'keep-frames',
      capturedAt: 1,
      cookies: [],
      origins: {},
    });
    await mergeBrowserFrameStorage('keep-frames', 2, {
      tabId: 1,
      frameId: 7,
      origin: 'https://app.test',
      localStorage: { child: 'frame' },
      sessionStorage: {},
    });
    await mergeBrowserOriginStorage('keep-frames', 3, {
      origin: 'https://app.test',
      localStorage: { root: 'pagehide' },
      sessionStorage: { rootSession: 'pagehide' },
    });

    const state = await getBrowserState('keep-frames');
    expect(state?.origins['https://app.test'].localStorage).toEqual({ root: 'pagehide' });
    expect(state?.origins['https://app.test'].frames).toEqual([
      {
        tabId: 1,
        frameId: 7,
        origin: 'https://app.test',
        localStorage: { child: 'frame' },
        sessionStorage: {},
      },
    ]);
  });
});
