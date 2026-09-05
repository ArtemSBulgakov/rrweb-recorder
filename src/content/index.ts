import type { RecorderCommand } from '../shared/types';
const ext = chrome;
let tabId: number | undefined;
let recorderReady = false;
let pendingStart: Extract<RecorderCommand, { type: 'RRWEB_START' }> | undefined;

function captureStorage() {
  return {
    origin: location.origin,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
  };
}

function sendStorage(type: 'CONTENT_READY' | 'BROWSER_STORAGE_STATE'): void {
  void ext.runtime.sendMessage({
    type,
    ...(type === 'CONTENT_READY' ? { url: location.href, title: document.title } : {}),
    ...captureStorage(),
  });
}

window.addEventListener('message', (event: MessageEvent<RecorderCommand>) => {
  if (event.source !== window) return;
  if (event.data?.type === 'RRWEB_RECORDER_READY') {
    recorderReady = true;
    if (pendingStart) {
      window.postMessage(pendingStart, '*');
      pendingStart = undefined;
    }
    return;
  }
  if (event.data?.type !== 'RRWEB_EVENT') return;
  void ext.runtime.sendMessage({
    type: 'RECORDED_EVENT',
    recordingId: event.data.recordingId,
    tabId: event.data.tabId,
    event: event.data.event,
  });
});

ext.runtime.onMessage.addListener((message: RecorderCommand & { config?: unknown }, _sender, sendResponse) => {
  if (message.type === 'RRWEB_START') {
    if (tabId === undefined) tabId = message.tabId;
    const startMessage = { ...message, tabId };
    if (recorderReady) window.postMessage(startMessage, '*');
    else pendingStart = startMessage;
  } else if (message.type === 'RRWEB_STOP') {
    window.postMessage(message, '*');
  } else if (message.type === 'CAPTURE_BROWSER_STORAGE') {
    sendResponse(captureStorage());
  }
});

addEventListener('pagehide', () => sendStorage('BROWSER_STORAGE_STATE'));
sendStorage('CONTENT_READY');
addEventListener('DOMContentLoaded', () => sendStorage('CONTENT_READY'), { once: true });

void ext.runtime.sendMessage({ type: 'CONTENT_BRIDGE_READY' });

