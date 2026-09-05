import type {
  CapturedBrowserState,
  CapturedFrameStorage,
  CapturedOriginStorage,
  CDPCookie,
  Recording,
  StoredEvent,
} from '../shared/types';
import type { StoredHarEntry } from '../shared/har';

const DB_NAME = 'rrweb-recorder';
const DB_VERSION = 5;
const RECORDINGS = 'recordings';
const EVENTS = 'events';
const NETWORK = 'network';
const BROWSER_STATE = 'browserState';

function createNetworkStore(db: IDBDatabase): IDBObjectStore {
  const network = db.createObjectStore(NETWORK, {
    keyPath: ['recordingId', 'tabId', 'sessionId', 'requestId'],
  });
  network.createIndex('recordingId', 'recordingId');
  network.createIndex('recordingTab', ['recordingId', 'tabId']);
  return network;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(EVENTS)) {
        const events = db.createObjectStore(EVENTS, { keyPath: 'id', autoIncrement: true });
        events.createIndex('recordingId', 'recordingId');
        events.createIndex('recordingTab', ['recordingId', 'tabId']);
      }
      if (event.oldVersion < 5 && db.objectStoreNames.contains(NETWORK)) {
        const previousStore = request.transaction!.objectStore(NETWORK);
        const previousEntries = previousStore.getAll();
        previousEntries.onsuccess = () => {
          db.deleteObjectStore(NETWORK);
          const network = createNetworkStore(db);
          for (const value of previousEntries.result as Array<StoredHarEntry & { sessionId?: string }>) {
            const sessionId = value.sessionId ?? 'root';
            network.put({
              ...value,
              sessionId,
              entry: {
                ...value.entry,
                _sessionId: value.entry._sessionId ?? sessionId,
                _targetType: value.entry._targetType ?? 'page',
              },
            } satisfies StoredHarEntry);
          }
        };
      } else if (!db.objectStoreNames.contains(NETWORK)) {
        createNetworkStore(db);
      }
      if (!db.objectStoreNames.contains(BROWSER_STATE)) {
        db.createObjectStore(BROWSER_STATE, { keyPath: 'recordingId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putRecording(recording: Recording): Promise<void> {
  const db = await openDb();
  await requestResult(db.transaction(RECORDINGS, 'readwrite').objectStore(RECORDINGS).put(recording));
  db.close();
}

export async function appendCaptureIssue(
  recordingId: string,
  issue: NonNullable<Recording['captureIssues']>[number],
): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(RECORDINGS, 'readwrite');
  const store = transaction.objectStore(RECORDINGS);
  const recording = await requestResult(store.get(recordingId)) as Recording | undefined;
  if (recording) {
    store.put({
      ...recording,
      captureIssues: [...(recording.captureIssues ?? []), issue],
    });
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

export async function getRecording(id: string): Promise<Recording | undefined> {
  const db = await openDb();
  const result = await requestResult(db.transaction(RECORDINGS).objectStore(RECORDINGS).get(id));
  db.close();
  return result as Recording | undefined;
}

export async function listRecordings(): Promise<Recording[]> {
  const db = await openDb();
  const result = await requestResult(db.transaction(RECORDINGS).objectStore(RECORDINGS).getAll());
  db.close();
  return (result as Recording[]).sort((a, b) => b.startedAt - a.startedAt);
}

export async function addEvent(event: StoredEvent): Promise<void> {
  const db = await openDb();
  await requestResult(db.transaction(EVENTS, 'readwrite').objectStore(EVENTS).add(event));
  db.close();
}

export async function addEventAndIncrement(event: StoredEvent): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([RECORDINGS, EVENTS], 'readwrite');
  transaction.objectStore(EVENTS).add(event);
  const recordings = transaction.objectStore(RECORDINGS);
  const recording = await requestResult(recordings.get(event.recordingId)) as Recording | undefined;
  if (recording?.active) {
    recording.eventCount = (recording.eventCount ?? 0) + 1;
    const tab = recording.tabs.find((item) => item.tabId === event.tabId);
    if (tab) {
      tab.eventCount = (tab.eventCount ?? 0) + 1;
      tab.lastEventAt = event.timestamp;
    }
    recordings.put(recording);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

export async function getEvents(recordingId: string, tabId?: number): Promise<StoredEvent[]> {
  const db = await openDb();
  const store = db.transaction(EVENTS).objectStore(EVENTS);
  const index = store.index(tabId === undefined ? 'recordingId' : 'recordingTab');
  const key = tabId === undefined ? recordingId : [recordingId, tabId];
  const result = await requestResult(index.getAll(IDBKeyRange.only(key)));
  db.close();
  return (result as StoredEvent[]).sort((a, b) => a.timestamp - b.timestamp);
}

export async function putHarEntry(entry: StoredHarEntry): Promise<void> {
  const db = await openDb();
  await requestResult(db.transaction(NETWORK, 'readwrite').objectStore(NETWORK).put(entry));
  db.close();
}

export async function getHarEntries(recordingId: string, tabId?: number): Promise<StoredHarEntry[]> {
  const db = await openDb();
  const store = db.transaction(NETWORK).objectStore(NETWORK);
  const result = tabId === undefined
    ? await requestResult(store.index('recordingId').getAll(IDBKeyRange.only(recordingId)))
    : await requestResult(store.index('recordingTab').getAll(IDBKeyRange.only([recordingId, tabId])));
  db.close();
  return (result as StoredHarEntry[]).sort(
    (a, b) => Date.parse(a.entry.startedDateTime) - Date.parse(b.entry.startedDateTime),
  );
}

export async function putBrowserState(state: CapturedBrowserState): Promise<void> {
  const db = await openDb();
  await requestResult(
    db.transaction(BROWSER_STATE, 'readwrite').objectStore(BROWSER_STATE).put(state),
  );
  db.close();
}

async function updateBrowserState(
  recordingId: string,
  update: (current: CapturedBrowserState | undefined) => CapturedBrowserState,
): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(BROWSER_STATE, 'readwrite');
  const store = transaction.objectStore(BROWSER_STATE);
  const current = await requestResult(store.get(recordingId)) as CapturedBrowserState | undefined;
  store.put(update(current));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

export async function updateBrowserCookies(
  recordingId: string,
  capturedAt: number,
  cookies: CDPCookie[],
): Promise<void> {
  await updateBrowserState(recordingId, (current) => ({
    recordingId,
    capturedAt,
    cookies,
    origins: current?.origins ?? {},
  }));
}

export async function getBrowserState(
  recordingId: string,
): Promise<CapturedBrowserState | undefined> {
  const db = await openDb();
  const result = await requestResult(
    db.transaction(BROWSER_STATE).objectStore(BROWSER_STATE).get(recordingId),
  );
  db.close();
  return result as CapturedBrowserState | undefined;
}

export async function mergeBrowserOriginStorage(
  recordingId: string,
  capturedAt: number,
  storage: CapturedOriginStorage,
): Promise<void> {
  await updateBrowserState(recordingId, (current) => {
    const previous = current?.origins[storage.origin];
    return {
      recordingId,
      capturedAt: Math.max(capturedAt, current?.capturedAt ?? 0),
      cookies: current?.cookies ?? [],
      origins: {
        ...current?.origins,
        [storage.origin]: {
          localStorage: storage.localStorage,
          sessionStorage: storage.sessionStorage,
          frames: storage.frames ?? previous?.frames,
        },
      },
    };
  });
}

export async function mergeBrowserFrameStorage(
  recordingId: string,
  capturedAt: number,
  frame: CapturedFrameStorage,
): Promise<void> {
  await updateBrowserState(recordingId, (current) => {
    const origin = current?.origins[frame.origin];
    const frames = [
      ...(origin?.frames ?? []).filter((existing) =>
        existing.tabId !== frame.tabId || existing.frameId !== frame.frameId),
      frame,
    ];
    const ownsOriginState = frame.frameId === 0 || origin === undefined;
    return {
      recordingId,
      capturedAt,
      cookies: current?.cookies ?? [],
      origins: {
        ...current?.origins,
        [frame.origin]: {
          localStorage: ownsOriginState ? frame.localStorage : origin.localStorage,
          sessionStorage: ownsOriginState ? frame.sessionStorage : origin.sessionStorage,
          frames,
        },
      },
    };
  });
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([RECORDINGS, EVENTS, NETWORK, BROWSER_STATE], 'readwrite');
  transaction.objectStore(RECORDINGS).delete(id);
  transaction.objectStore(BROWSER_STATE).delete(id);
  const index = transaction.objectStore(EVENTS).index('recordingId');
  const keys = await requestResult(index.getAllKeys(IDBKeyRange.only(id)));
  for (const key of keys) transaction.objectStore(EVENTS).delete(key);
  const networkIndex = transaction.objectStore(NETWORK).index('recordingId');
  const networkKeys = await requestResult(networkIndex.getAllKeys(IDBKeyRange.only(id)));
  for (const key of networkKeys) transaction.objectStore(NETWORK).delete(key);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function renameRecording(id: string, title: string): Promise<void> {
  const recording = await getRecording(id);
  if (!recording) return;
  recording.title = title.trim() || recording.title;
  await putRecording(recording);
}
