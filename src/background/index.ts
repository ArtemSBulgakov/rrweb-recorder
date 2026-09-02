import { addEventAndIncrement, getRecording, putNetworkRequest, putRecording } from '../storage/db';
import type { CapturedNetworkRequest, ExtensionMessage, RecorderConfig, Recording, RecordingOptions, RuntimeState } from '../shared/types';
const ext = chrome;
const defaultOptions: RecordingOptions = {
  recordConsole: true,
  recordNetwork: true,
  sequentialId: true,
  captureAllNetworkBodies: false,
};
let state: RuntimeState = { active: false, trackedTabIds: [], options: defaultOptions };
const initialization = ext.storage.local.get('runtimeState').then((stored) => {
  state = (stored.runtimeState as RuntimeState | undefined) ?? state;
});
const pendingTabs = new Set<number>();
const debuggerRequests = new Map<string, CapturedNetworkRequest>();
const debuggerTargets = new Set<number>();

function debuggerKey(tabId: number, requestId: string): string {
  return `${tabId}:${requestId}`;
}

async function configureDebugger(tabId: number): Promise<void> {
  await ext.debugger.sendCommand({ tabId }, 'Network.enable');
  await ext.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true });
}

async function attachDebugger(tabId: number): Promise<boolean> {
  if (!ext.debugger?.attach) return false;
  if (debuggerTargets.has(tabId)) {
    try {
      await configureDebugger(tabId);
      return true;
    } catch {
      debuggerTargets.delete(tabId);
    }
  }
  try {
    await ext.debugger.attach({ tabId }, '1.3');
    debuggerTargets.add(tabId);
    await configureDebugger(tabId);
    return true;
  } catch {
    debuggerTargets.delete(tabId);
    return false;
  }
}

async function detachDebugger(tabId: number): Promise<void> {
  if (!ext.debugger?.detach || !debuggerTargets.delete(tabId)) return;
  await ext.debugger.detach({ tabId }).catch(() => undefined);
}

async function injectRecorder(tabId: number): Promise<void> {
  await ext.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['assets/recorder.js'],
    world: 'MAIN',
  });
}

function recorderConfig(options = state.options): RecorderConfig {
  return {
    ...options,
    redactHeaders: ['authorization', 'cookie', 'set-cookie', 'proxy-authorization'],
  };
}

function drawIcon(mode: 'idle' | 'recording' | 'recording-elsewhere'): Record<number, ImageData> {
  return Object.fromEntries([16, 32, 48, 128].map((size) => {
    const active = mode === 'recording';
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to create icon canvas');

    const scale = size / 128;
    context.fillStyle = active ? '#d7263d' : '#3759d7';
    context.beginPath();
    context.roundRect(8 * scale, 8 * scale, 112 * scale, 112 * scale, 28 * scale);
    context.fill();

    context.fillStyle = '#ffffff';
    context.beginPath();
    context.arc(64 * scale, 64 * scale, 31 * scale, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = active ? '#d7263d' : '#3759d7';
    context.beginPath();
    context.arc(64 * scale, 64 * scale, 19 * scale, 0, Math.PI * 2);
    context.fill();

    if (mode === 'recording-elsewhere') {
      context.fillStyle = '#d7263d';
      context.beginPath();
      context.arc(101 * scale, 27 * scale, 15 * scale, 0, Math.PI * 2);
      context.fill();
      context.lineWidth = 5 * scale;
      context.strokeStyle = '#ffffff';
      context.stroke();
    }

    return [size, context.getImageData(0, 0, size, size)];
  }));
}

async function updateAction(): Promise<void> {
  const [activeTab] = await ext.tabs.query({ active: true, currentWindow: true });
  const mode = !state.active
    ? 'idle'
    : activeTab?.id !== undefined && state.trackedTabIds.includes(activeTab.id)
      ? 'recording'
      : 'recording-elsewhere';
  const imageData = drawIcon(mode);
  await ext.action.setIcon({ imageData });
  await ext.action.setBadgeText({ text: mode === 'recording' ? 'REC' : mode === 'recording-elsewhere' ? '•' : '' });
  if (mode !== 'idle') await ext.action.setBadgeBackgroundColor({ color: '#d7263d' });
}

async function broadcast(message: object): Promise<void> {
  await Promise.allSettled(state.trackedTabIds.map((tabId) =>
    ext.tabs.sendMessage(tabId, { ...message, tabId }),
  ));
}

async function startRecording(options: RecordingOptions): Promise<RuntimeState> {
  await initialization;
  if (state.active) return state;
  const id = crypto.randomUUID();
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !/^https?:/.test(tab.url ?? '')) throw new Error('Open an HTTP(S) page before recording.');
  const trackedTabIds = [tab.id];
  const now = Date.now();
  const recording: Recording = {
    id,
    title: `Recording ${new Date(now).toLocaleString()}`,
    startedAt: now,
    active: true,
    eventCount: 0,
    tabActivity: [{ tabId: tab.id, timestamp: now }],
    tabs: [{ tabId: tab.id, title: tab.title ?? 'Untitled', url: tab.url ?? '', startedAt: now, eventCount: 0 }],
  };
  await injectRecorder(tab.id);
  if (options.captureAllNetworkBodies) {
    if (!ext.debugger?.attach) throw new Error('Deep network capture is available in Chromium only.');
    if (!await attachDebugger(tab.id)) throw new Error('Could not attach Chromium debugger to this tab.');
  }
  await putRecording(recording);
  state = { active: true, activeRecordingId: id, trackedTabIds, options };
  await ext.storage.local.set({ runtimeState: state });
  await updateAction();
  await broadcast({ type: 'RRWEB_START', recordingId: id, config: recorderConfig(options) });
  return state;
}

async function stopRecording(): Promise<RuntimeState> {
  await initialization;
  const id = state.activeRecordingId;
  if (!id) return state;
  await broadcast({ type: 'RRWEB_STOP', recordingId: id });
  await Promise.all([...debuggerTargets].map(detachDebugger));
  const recording = await getRecording(id);
  if (recording) await putRecording({ ...recording, active: false, endedAt: Date.now() });
  state = { active: false, trackedTabIds: [], options: state.options };
  await ext.storage.local.set({ runtimeState: state });
  await updateAction();
  return state;
}

ext.runtime.onInstalled.addListener(async () => {
  await initialization;
  await updateAction();
});

ext.tabs.onActivated.addListener((activeInfo) => {
  void (async () => {
    await initialization;
    if (state.activeRecordingId && state.trackedTabIds.includes(activeInfo.tabId)) {
      const recording = await getRecording(state.activeRecordingId);
      if (recording) {
        recording.tabActivity ??= [];
        const previous = recording.tabActivity.at(-1);
        if (previous?.tabId !== activeInfo.tabId) {
          recording.tabActivity.push({ tabId: activeInfo.tabId, timestamp: Date.now() });
          await putRecording(recording);
        }
      }
    }
    await updateAction();
  })();
});

ext.windows.onFocusChanged.addListener(() => {
  void updateAction();
});

async function trackOpenedTab(tabId: number, sourceTabId: number): Promise<void> {
  await initialization;
  if (!state.activeRecordingId || !state.trackedTabIds.includes(sourceTabId) ||
      state.trackedTabIds.includes(tabId) || pendingTabs.has(tabId)) return;
  pendingTabs.add(tabId);
  state.trackedTabIds.push(tabId);
  await ext.storage.local.set({ runtimeState: state });
  const recordingId = state.activeRecordingId;
  try {
  const tab = await ext.tabs.get(tabId);
  const recording = await getRecording(recordingId);
  if (!recording) return;
  recording.tabs.push({ tabId, title: tab.title ?? 'Untitled', url: tab.url ?? '', startedAt: Date.now(), eventCount: 0 });
  await putRecording(recording);
  if (state.options.captureAllNetworkBodies) {
    await attachDebugger(tabId);
  }
  await ext.tabs.sendMessage(tabId, {
    type: 'RRWEB_START', recordingId, tabId, config: recorderConfig(),
  }).catch(() => undefined);
  await updateAction();
  } finally {
    pendingTabs.delete(tabId);
  }
}

ext.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void trackOpenedTab(details.tabId, details.sourceTabId);
});

ext.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && /^https?:/.test(details.url)) {
    if (state.active && state.options.captureAllNetworkBodies && state.trackedTabIds.includes(details.tabId)) {
      void attachDebugger(details.tabId);
    }
    void injectRecorder(details.tabId).catch(() => undefined);
  }
});

ext.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0 && state.active && state.options.captureAllNetworkBodies &&
      state.trackedTabIds.includes(details.tabId)) {
    void attachDebugger(details.tabId);
  }
});

ext.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) {
    void trackOpenedTab(tab.id, tab.openerTabId);
  }
});

ext.tabs.onRemoved.addListener(async (tabId) => {
  await initialization;
  if (!state.activeRecordingId || !state.trackedTabIds.includes(tabId)) return;
  const recording = await getRecording(state.activeRecordingId);
  const track = recording?.tabs.find((tab) => tab.tabId === tabId);
  if (recording && track) {
    track.endedAt = Date.now();
    await putRecording(recording);
  }
  state.trackedTabIds = state.trackedTabIds.filter((id) => id !== tabId);
  await ext.storage.local.set({ runtimeState: state });
  await detachDebugger(tabId);
  await updateAction();
});

ext.debugger?.onDetach?.addListener((source) => {
  if (source.tabId !== undefined) debuggerTargets.delete(source.tabId);
});

ext.debugger?.onEvent?.addListener((source, method, params) => {
  void (async () => {
    await initialization;
    const tabId = source.tabId;
    if (tabId === undefined || !state.activeRecordingId || !state.trackedTabIds.includes(tabId)) return;
    const data = params as Record<string, any>;
    if (method === 'Network.requestWillBeSent') {
      const request = data.request;
      const capturedRequest: CapturedNetworkRequest = {
        requestId: data.requestId,
        tabId,
        timestamp: Date.now(),
        url: request.url,
        method: request.method,
        type: data.type ?? 'Other',
        requestHeaders: request.headers,
        requestBody: request.postData,
      };
      debuggerRequests.set(debuggerKey(tabId, data.requestId), capturedRequest);
      await putNetworkRequest(state.activeRecordingId, capturedRequest);
      return;
    }
    const key = debuggerKey(tabId, data.requestId);
    const request = debuggerRequests.get(key);
    if (!request) return;
    if (method === 'Network.responseReceived') {
      request.status = data.response.status;
      request.responseHeaders = data.response.headers;
      request.type = data.type ?? request.type;
      await putNetworkRequest(state.activeRecordingId, request);
      return;
    }
    if (method === 'Network.requestServedFromCache') {
      request.type = `${request.type} (cache)`;
      await putNetworkRequest(state.activeRecordingId, request);
      return;
    }
    if (method === 'Network.loadingFinished') {
      try {
        const body = await ext.debugger.sendCommand({ tabId }, 'Network.getResponseBody', {
          requestId: data.requestId,
        }) as { body?: string; base64Encoded?: boolean };
        request.responseBody = body.body;
        request.encodedResponse = body.base64Encoded;
      } catch {
        request.responseBody = undefined;
      }
      await putNetworkRequest(state.activeRecordingId, request);
      debuggerRequests.delete(key);
    } else if (method === 'Network.loadingFailed') {
      await putNetworkRequest(state.activeRecordingId, request);
      debuggerRequests.delete(key);
    }
  })();
});

ext.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  void (async () => {
    await initialization;
    if (message.type === 'START_RECORDING') return sendResponse(await startRecording(message.options));
    if (message.type === 'STOP_RECORDING') return sendResponse(await stopRecording());
    if (message.type === 'GET_STATE') return sendResponse(state);
    if (message.type === 'GET_ACTIVE_RECORDING') {
      return sendResponse(state.activeRecordingId ? await getRecording(state.activeRecordingId) : undefined);
    }
    if (message.type === 'OPEN_LIBRARY') {
      await ext.tabs.create({ url: ext.runtime.getURL('src/library/index.html') });
      return sendResponse(true);
    }
    if (message.type === 'ACTIVATE_TAB') {
      if (!state.trackedTabIds.includes(message.tabId)) return sendResponse(false);
      const tab = await ext.tabs.get(message.tabId);
      await ext.tabs.update(message.tabId, { active: true });
      await ext.windows.update(tab.windowId, { focused: true });
      return sendResponse(true);
    }
    if (message.type === 'RELOAD_RECORDED_TABS') {
      if (!state.active || !state.options.captureAllNetworkBodies) return sendResponse(false);
      await Promise.all(state.trackedTabIds.map((tabId) => ext.tabs.reload(tabId, { bypassCache: true })));
      return sendResponse(true);
    }
    if (message.type === 'CONTENT_BRIDGE_READY' && sender.tab?.id !== undefined &&
        state.activeRecordingId && state.trackedTabIds.includes(sender.tab.id)) {
      await injectRecorder(sender.tab.id);
      await ext.tabs.sendMessage(sender.tab.id, {
        type: 'RRWEB_START', recordingId: state.activeRecordingId,
        tabId: sender.tab.id, config: recorderConfig(),
      });
      return sendResponse(true);
    }
    if (message.type === 'CONTENT_READY' && state.activeRecordingId && sender.tab?.id !== undefined &&
        state.trackedTabIds.includes(sender.tab.id)) {
      const recording = await getRecording(state.activeRecordingId);
      const track = recording?.tabs.find((tab) => tab.tabId === sender.tab!.id);
      if (recording && track) {
        track.url = message.url;
        track.title = message.title || track.title;
        await putRecording(recording);
      }
      await ext.tabs.sendMessage(sender.tab.id, {
        type: 'RRWEB_START', recordingId: state.activeRecordingId, tabId: sender.tab.id, config: recorderConfig(),
      });
      return sendResponse(true);
    }
    if (message.type === 'RECORDED_EVENT' && message.recordingId === state.activeRecordingId) {
      const senderTabId = sender.tab?.id;
      if (senderTabId === undefined || !state.trackedTabIds.includes(senderTabId)) return sendResponse(false);
      await addEventAndIncrement({
        recordingId: message.recordingId, tabId: senderTabId,
        timestamp: message.event.timestamp, event: message.event,
      });
      return sendResponse(true);
    }
  })();
  return true;
});

void initialization.then(() => {
  void updateAction();
});
