import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { addEvent, deleteRecording, getEvents, getRecording, listRecordings, putRecording } from '../src/storage/db';

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
});
