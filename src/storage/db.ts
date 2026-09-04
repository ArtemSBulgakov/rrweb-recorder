import type { Recording, StoredEvent } from '../shared/types';
import type { StoredHarEntry } from '../shared/har';

const DB_NAME = 'rrweb-recorder';
const DB_VERSION = 4;
const RECORDINGS = 'recordings';
const EVENTS = 'events';
const NETWORK = 'network';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDINGS)) db.createObjectStore(RECORDINGS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(EVENTS)) {
        const events = db.createObjectStore(EVENTS, { keyPath: 'id', autoIncrement: true });
        events.createIndex('recordingId', 'recordingId');
        events.createIndex('recordingTab', ['recordingId', 'tabId']);
      }
      if (request.oldVersion < 4 && db.objectStoreNames.contains(NETWORK)) {
        db.deleteObjectStore(NETWORK);
      }
      if (!db.objectStoreNames.contains(NETWORK)) {
        const network = db.createObjectStore(NETWORK, { keyPath: ['recordingId', 'requestId'] });
        network.createIndex('recordingId', 'recordingId');
        network.createIndex('recordingTab', ['recordingId', 'tabId']);
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

export async function deleteRecording(id: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction([RECORDINGS, EVENTS, NETWORK], 'readwrite');
  const recording = await requestResult(transaction.objectStore(RECORDINGS).get(id)) as Recording | undefined;
  transaction.objectStore(RECORDINGS).delete(id);
  const index = transaction.objectStore(EVENTS).index('recordingId');
  const keys = await requestResult(index.getAllKeys(IDBKeyRange.only(id)));
  for (const key of keys) transaction.objectStore(EVENTS).delete(key);
  const networkIndex = transaction.objectStore(NETWORK).index('recordingTab');
  for (const tabId of recording?.tabs ?? []) {
    const networkKeys = await requestResult(networkIndex.getAllKeys(IDBKeyRange.only([id, tabId.tabId])));
    for (const key of networkKeys) transaction.objectStore(NETWORK).delete(key);
  }
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
