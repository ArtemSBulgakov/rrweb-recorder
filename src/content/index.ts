import type { RecorderCommand } from '../shared/types';
const ext = chrome;
let tabId: number | undefined;
let recorderReady = false;
let pendingStart: Extract<RecorderCommand, { type: 'RRWEB_START' }> | undefined;

window.addEventListener('message', (event: MessageEvent<RecorderCommand>) => {
  if (event.source !== window) return;
  if (event.data?.type === 'RRWEB_RECORDER_READY') {
    recorderReady = true;
    if (pendingStart) {
      window.postMessage(pendingStart, '*');
      pendingStart = undefined;
    }
    void ext.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href, title: document.title });
    addEventListener('DOMContentLoaded', () => {
      void ext.runtime.sendMessage({ type: 'CONTENT_READY', url: location.href, title: document.title });
    }, { once: true });
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

ext.runtime.onMessage.addListener((message: RecorderCommand & { config?: unknown }) => {
  if (message.type === 'RRWEB_START') {
    if (tabId === undefined) tabId = message.tabId;
    const startMessage = { ...message, tabId };
    if (recorderReady) window.postMessage(startMessage, '*');
    else pendingStart = startMessage;
  } else if (message.type === 'RRWEB_STOP') {
    window.postMessage(message, '*');
  }
});

void ext.runtime.sendMessage({ type: 'CONTENT_BRIDGE_READY' });

