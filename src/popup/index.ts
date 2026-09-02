import '../ui.css';
import type { Recording, RuntimeState } from '../shared/types';
const ext = chrome;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const toggle = document.querySelector<HTMLButtonElement>('#toggle')!;
const consoleInput = document.querySelector<HTMLInputElement>('#console')!;
const networkInput = document.querySelector<HTMLInputElement>('#network')!;
const deepNetworkInput = document.querySelector<HTMLInputElement>('#deep-network')!;
const sequentialInput = document.querySelector<HTMLInputElement>('#sequential')!;
const tracked = document.querySelector<HTMLElement>('#tracked')!;
const tabList = document.querySelector<HTMLUListElement>('#tabs')!;
const timer = document.querySelector<HTMLElement>('#timer')!;
const summary = document.querySelector<HTMLElement>('#summary')!;
const eventCount = document.querySelector<HTMLElement>('#event-count')!;
const tabCount = document.querySelector<HTMLElement>('#tab-count')!;
const errorMessage = document.querySelector<HTMLElement>('#error')!;
const reloadTabs = document.querySelector<HTMLButtonElement>('#reload-tabs')!;
let refreshTimer: number | undefined;
const debuggerAvailable = Boolean(ext.debugger?.attach);
if (!debuggerAvailable) {
  deepNetworkInput.disabled = true;
  deepNetworkInput.checked = false;
  deepNetworkInput.closest('label')!.title = 'Available in Chromium only';
}

async function render(state: RuntimeState): Promise<void> {
  const recording = state.active
    ? await ext.runtime.sendMessage({ type: 'GET_ACTIVE_RECORDING' }) as Recording | undefined
    : undefined;
  status.textContent = state.active ? 'Recording' : 'Ready to record';
  status.className = state.active ? 'recording' : 'muted';
  toggle.textContent = state.active ? 'Stop' : 'Play';
  toggle.className = state.active ? 'danger' : '';
  consoleInput.checked = state.options.recordConsole;
  networkInput.checked = state.options.recordNetwork;
  deepNetworkInput.checked = debuggerAvailable && state.options.captureAllNetworkBodies;
  sequentialInput.checked = state.options.sequentialId;
  for (const input of [consoleInput, networkInput, deepNetworkInput, sequentialInput]) input.disabled = state.active;
  tracked.hidden = !state.active;
  summary.hidden = !state.active;
  timer.hidden = !state.active;
  document.querySelector<HTMLElement>('#options')!.hidden = state.active;
  reloadTabs.hidden = !(state.active && state.options.captureAllNetworkBodies);
  if (recording) {
    timer.textContent = formatDuration(Date.now() - recording.startedAt);
    eventCount.textContent = recording.eventCount.toLocaleString();
    tabCount.textContent = String(recording.tabs.length);
  }
  if (state.active) {
    const tabs = await Promise.all(state.trackedTabIds.map(async (tabId) => {
      try { return await ext.tabs.get(tabId); } catch { return undefined; }
    }));
    const fragment = document.createDocumentFragment();
    for (const tab of tabs) {
      if (!tab) continue;
      const item = document.createElement('li');
      const recordedTab = recording?.tabs.find((item) => item.tabId === tab.id);
      const title = document.createElement('strong');
      title.textContent = tab.title || recordedTab?.title || 'Untitled';
      title.title = tab.url || '';
      const details = document.createElement('span');
      const duration = recordedTab ? formatDuration((recordedTab.endedAt ?? Date.now()) - recordedTab.startedAt) : '00:00';
      details.textContent = `${duration} · ${(recordedTab?.eventCount ?? 0).toLocaleString()} events`;
      item.append(title, details);
      item.tabIndex = 0;
      item.addEventListener('click', async () => {
        const activated = await ext.runtime.sendMessage({ type: 'ACTIVATE_TAB', tabId: tab.id });
        if (activated) window.close();
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') item.click();
      });
      fragment.append(item);
    }
    if (!fragment.children.length) {
      const item = document.createElement('li');
      item.textContent = 'Waiting for a recordable tab';
      fragment.append(item);
    }
    tabList.replaceChildren(fragment);
  } else {
    tabList.replaceChildren();
  }
}

async function refresh(): Promise<void> {
  const state = await ext.runtime.sendMessage({ type: 'GET_STATE' }) as RuntimeState;
  await render(state);
  if (refreshTimer) clearTimeout(refreshTimer);
  if (state.active) refreshTimer = window.setTimeout(() => void refresh(), 1000);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

void refresh();
toggle.addEventListener('click', async () => {
  errorMessage.hidden = true;
  toggle.disabled = true;
  try {
    const state = await ext.runtime.sendMessage({ type: 'GET_STATE' }) as RuntimeState;
    const message = state.active ? { type: 'STOP_RECORDING' } : {
      type: 'START_RECORDING',
      options: {
        recordConsole: consoleInput.checked,
        recordNetwork: networkInput.checked,
      captureAllNetworkBodies: deepNetworkInput.checked,
        sequentialId: sequentialInput.checked,
      },
    };
    await ext.runtime.sendMessage(message);
    await refresh();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : String(error);
    errorMessage.hidden = false;
  } finally {
    toggle.disabled = false;
  }
});
document.querySelector('#library')!.addEventListener('click', () => {
  void ext.runtime.sendMessage({ type: 'OPEN_LIBRARY' });
});
reloadTabs.addEventListener('click', async () => {
  reloadTabs.disabled = true;
  try {
    await ext.runtime.sendMessage({ type: 'RELOAD_RECORDED_TABS' });
    window.close();
  } finally {
    reloadTabs.disabled = false;
  }
});
