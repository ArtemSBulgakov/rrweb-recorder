import {
  addEventAndIncrement,
  appendCaptureIssue,
  getRecording,
  mergeBrowserFrameStorage,
  mergeBrowserOriginStorage,
  putBrowserState,
  putRecording,
  updateBrowserCookies,
} from '../storage/db';
import {
  attachNetworkDebugger,
  detachNetworkDebugger,
  drainNetworkCapture,
  handleNetworkDebuggerEvent,
  handleTargetDebuggerEvent,
  markNetworkDebuggerDetached,
  networkDebuggerTabIds,
  settleNetworkDebuggerAttachments,
} from './network-capture';
import type { ExtensionMessage, RecorderConfig, Recording, RecordingOptions, RuntimeState } from '../shared/types';
import { cookieDomainAllowed, normalizeCookieDomains } from '../shared/cookie-domains';
const ext = chrome;
const defaultOptions: RecordingOptions = {
  recordConsole: true,
  recordNetwork: true,
  sequentialId: true,
  captureAllNetworkBodies: true,
  cookieDomains: [],
};
let state: RuntimeState = { active: false, trackedTabIds: [], options: defaultOptions };
const initialization = ext.storage.local.get('runtimeState').then((stored) => {
  const saved = stored.runtimeState as RuntimeState | undefined;
  if (saved) state = { ...saved, options: { ...defaultOptions, ...saved.options } };
});
const pendingTabs = new Set<number>();

async function injectRecorder(tabId: number): Promise<void> {
  await ext.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['assets/recorder.js'],
    world: 'MAIN',
  });
}

function recorderConfig(options = state.options): RecorderConfig {
  const { recordConsole, recordNetwork, sequentialId, captureAllNetworkBodies } = options;
  return { recordConsole, recordNetwork, sequentialId, captureAllNetworkBodies };
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

async function addCaptureIssue(
  recordingId: string,
  issue: NonNullable<Recording['captureIssues']>[number],
): Promise<void> {
  await appendCaptureIssue(recordingId, issue);
}

async function startRecording(options: RecordingOptions): Promise<RuntimeState> {
  await initialization;
  if (state.active) return state;
  options = { ...options, cookieDomains: normalizeCookieDomains(options.cookieDomains) };
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
  await putRecording(recording);
  state = { active: true, activeRecordingId: id, trackedTabIds, options };
  await ext.storage.local.set({ runtimeState: state });
  await putBrowserState({ recordingId: id, capturedAt: now, cookies: [], origins: {} });
  try {
    if (options.captureAllNetworkBodies) {
      if (!ext.debugger?.attach) throw new Error('Deep network capture is available in Chromium only.');
      if (!await attachNetworkDebugger(tab.id)) throw new Error('Could not attach Chromium debugger to this tab.');
      await captureCookies(id, now);
      await ext.tabs.reload(tab.id, { bypassCache: true });
    } else {
      await injectRecorder(tab.id);
      await broadcast({ type: 'RRWEB_START', recordingId: id, config: recorderConfig(options) });
    }
  } catch (error) {
    await Promise.all(networkDebuggerTabIds().map(detachNetworkDebugger));
    await putRecording({ ...recording, active: false, endedAt: Date.now() });
    state = { active: false, trackedTabIds: [], options };
    await ext.storage.local.set({ runtimeState: state });
    throw error;
  }
  await updateAction();
  return state;
}

async function captureCookies(recordingId: string, capturedAt: number): Promise<void> {
  if (!ext.debugger?.sendCommand || !networkDebuggerTabIds().length) return;
  const tabId = networkDebuggerTabIds()[0];
  const result = await ext.debugger.sendCommand(
    { tabId },
    'Storage.getCookies',
  ) as { cookies?: import('../shared/types').CDPCookie[] };
  await updateBrowserCookies(recordingId, capturedAt,
    (result.cookies ?? []).filter((cookie) => cookieDomainAllowed(cookie.domain, state.options.cookieDomains)));
}

async function captureTabStorage(
  recordingId: string,
  tabId: number,
  capturedAt: number,
): Promise<void> {
  const results = await ext.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({
      origin: location.origin,
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
    }),
  });
  const frames = results.map((result) => ({
    tabId,
    frameId: result.frameId,
    origin: result.result?.origin ?? '',
    localStorage: result.result?.localStorage ?? {},
    sessionStorage: result.result?.sessionStorage ?? {},
  })).filter((frame) => frame.origin);
  await Promise.all(frames.map((frame) =>
    mergeBrowserFrameStorage(recordingId, capturedAt, frame),
  ));
}

async function stopRecording(): Promise<RuntimeState> {
  await initialization;
  const id = state.activeRecordingId;
  if (!id) return state;
  try {
    await Promise.allSettled(state.trackedTabIds.map((tabId) =>
      captureTabStorage(id, tabId, Date.now()),
    ));
    await captureCookies(id, Date.now()).catch((error) =>
      addCaptureIssue(id, {
        capturedAt: Date.now(),
        code: 'cookie-capture-failed',
        message: error instanceof Error ? error.message : String(error),
      }));
    await broadcast({ type: 'RRWEB_STOP', recordingId: id });
    await drainNetworkCapture(5_000);
  } finally {
    await settleNetworkDebuggerAttachments();
    await Promise.all(networkDebuggerTabIds().map(detachNetworkDebugger));
    const recording = await getRecording(id);
    if (recording) await putRecording({ ...recording, active: false, endedAt: Date.now() });
    state = { active: false, trackedTabIds: [], options: state.options };
    await ext.storage.local.set({ runtimeState: state });
    await updateAction();
  }
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
    if (await attachNetworkDebugger(tabId)) {
      if (state.activeRecordingId === recordingId && state.trackedTabIds.includes(tabId)) {
        await ext.tabs.reload(tabId, { bypassCache: true });
      } else {
        await detachNetworkDebugger(tabId);
      }
    } else {
      await addCaptureIssue(recordingId, {
        capturedAt: Date.now(),
        code: 'debugger-attach-failed',
        message: 'Could not attach Chromium debugger to a tracked tab.',
        tabId,
      });
    }
  } else {
    await ext.tabs.sendMessage(tabId, {
      type: 'RRWEB_START', recordingId, tabId, config: recorderConfig(),
    }).catch(() => undefined);
  }
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
      void attachNetworkDebugger(details.tabId);
    }
    void injectRecorder(details.tabId).catch(() => undefined);
  }
});

ext.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0 && state.active && state.options.captureAllNetworkBodies &&
      state.trackedTabIds.includes(details.tabId)) {
    void attachNetworkDebugger(details.tabId);
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
  await detachNetworkDebugger(tabId);
  await updateAction();
});

ext.debugger?.onDetach?.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const recordingId = state.activeRecordingId;
  void markNetworkDebuggerDetached(source.tabId).then(async () => {
    if (!recordingId || !state.trackedTabIds.includes(source.tabId!)) return;
    await addCaptureIssue(recordingId, {
      capturedAt: Date.now(),
      code: 'debugger-detached',
      message: `Chromium debugger detached during capture: ${reason}`,
      tabId: source.tabId,
    });
  });
});

ext.debugger?.onEvent?.addListener((source, method, params) => {
  void (async () => {
    await initialization;
    const tabId = source.tabId;
    if (tabId === undefined || !state.activeRecordingId || !state.trackedTabIds.includes(tabId)) return;
    if (method.startsWith('Target.')) {
      try {
        await handleTargetDebuggerEvent(
          tabId,
          state.activeRecordingId,
          method,
          (params ?? {}) as Record<string, any>,
        );
      } catch (error) {
        await addCaptureIssue(state.activeRecordingId, {
          capturedAt: Date.now(),
          code: 'child-target-configuration-failed',
          message: error instanceof Error ? error.message : String(error),
          tabId,
          sessionId: String((params as Record<string, any> | undefined)?.sessionId ?? source.sessionId ?? ''),
          targetType: String((params as Record<string, any> | undefined)?.targetInfo?.type ?? 'unknown'),
        });
      }
      return;
    }
    if (!method.startsWith('Network.')) return;
    await handleNetworkDebuggerEvent(
      tabId,
      source.sessionId,
      state.activeRecordingId,
      method,
      (params ?? {}) as Record<string, any>,
    );
  })();
});

ext.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  void (async () => {
    await initialization;
    if (message.type === 'SAVE_COOKIE_DOMAINS') {
      if (state.active) throw new Error('Stop recording before changing cookie domains.');
      const options = { ...state.options, cookieDomains: normalizeCookieDomains(message.domains) };
      state = { ...state, options };
      await ext.storage.local.set({ runtimeState: state });
      return sendResponse(state);
    }
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
      await captureTabStorage(state.activeRecordingId, sender.tab.id, Date.now())
        .catch(() => mergeBrowserOriginStorage(state.activeRecordingId!, Date.now(), message));
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
    if (message.type === 'BROWSER_STORAGE_STATE' && state.activeRecordingId &&
        sender.tab?.id !== undefined && state.trackedTabIds.includes(sender.tab.id)) {
      await mergeBrowserOriginStorage(state.activeRecordingId, Date.now(), message);
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
  })().catch((error: unknown) => sendResponse({
    error: error instanceof Error ? error.message : String(error),
  }));
  return true;
});

void initialization.then(() => {
  void updateAction();
});
