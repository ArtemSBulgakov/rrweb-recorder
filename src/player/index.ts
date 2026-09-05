import '../ui.css';
import 'rrweb-player/dist/style.css';
import rrwebPlayer from 'rrweb-player';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { getEvents, getHarEntries, getRecording } from '../storage/db';
import { wrapHarEntries, type HarEntry } from '../shared/har';
import type { BrowserTab, Recording, StoredEvent } from '../shared/types';
import type { eventWithTime, NetworkData, NetworkRequest } from '@rrweb/types';
import type { LogData } from '@rrweb/rrweb-plugin-console-record';

type PluginEvent<T> = eventWithTime & { data: { plugin: string; payload: T } };

const recordingId = new URLSearchParams(location.search).get('id');
const recording = recordingId ? await getRecording(recordingId) : undefined;
let loadedRecording: Recording | undefined = recording;
let importedEvents: StoredEvent[] | undefined;
let importedHarEntries: HarEntry[] | undefined;
if (recordingId && !recording) throw new Error('Recording not found');

document.querySelector('#back')!.addEventListener('click', () => history.back());
const fileInput = document.querySelector<HTMLInputElement>('#recording-file')!;
document.querySelector('#import-recording')!.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void importRecording(file);
  fileInput.value = '';
});
const tabsTarget = document.querySelector<HTMLElement>('#tabs')!;
const tabButtons = new Map<number, HTMLButtonElement>();
let currentTabId: number | undefined;
let currentOffset = 0;
let currentPlaying = false;
let currentPlayer: rrwebPlayer | undefined;
let loadVersion = 0;
let activitySwitching = false;
let consoleTimeline: PluginEvent<LogData>[] = [];
let harEntries: HarEntry[] = [];
let networkTimeline: Array<{
  request: NetworkRequest;
  timestamp: number;
  source: 'debugger' | 'performance';
  har?: HarEntry;
}> = [];
document.querySelector('#export-har')!.addEventListener('click', exportNetworkHar);
document.querySelector('#export-pcap')!.addEventListener('click', exportNetworkPcap);
if (loadedRecording) await loadRecording();
else {
  document.querySelector('#player')!.textContent = 'Open an rrweb JSON or ZIP recording.';
  if (new URLSearchParams(location.search).has('import')) fileInput.click();
}

async function loadRecording(): Promise<void> {
  if (!loadedRecording) return;
  document.querySelector('#title')!.textContent = loadedRecording.title;
  document.querySelector('#recorded-at')!.textContent =
    `Recorded ${new Date(loadedRecording.startedAt).toLocaleString()}`;
  currentOffset = 0;
  updatePlaybackDateTime();
  tabsTarget.replaceChildren();
  tabButtons.clear();
  for (const tab of loadedRecording.tabs) {
  const button = document.createElement('button');
  button.className = 'replay-tab';
  button.textContent = tab.title;
  button.title = tab.url;
  button.addEventListener('click', () => void play(tab, currentOffset, currentPlaying));
  tabsTarget.append(button);
  tabButtons.set(tab.tabId, button);
  }
  if (loadedRecording.tabs[0]) await play(loadedRecording.tabs[0]);
}

async function play(tab: BrowserTab, absoluteOffset = 0, resume = false): Promise<void> {
  if (!loadedRecording) return;
  const activeRecording = loadedRecording;
  const version = ++loadVersion;
  const target = document.querySelector<HTMLElement>('#player')!;
  const events = importedEvents
    ? importedEvents.filter((event) => event.tabId === tab.tabId).sort((a, b) => a.timestamp - b.timestamp)
    : await getEvents(recordingId!, tab.tabId);
  const debuggerHar = importedEvents
    ? (importedHarEntries ?? []).filter((entry) => entry._tabId === tab.tabId || entry._tabId === undefined)
    : (await getHarEntries(recordingId!, tab.tabId)).map((item) => item.entry);
  if (version !== loadVersion) return;
  (currentPlayer as (rrwebPlayer & { $destroy(): void }) | undefined)?.$destroy();
  currentPlayer = undefined;
  target.replaceChildren();
  currentTabId = tab.tabId;
  for (const [tabId, button] of tabButtons) button.classList.toggle('active', tabId === tab.tabId);
  consoleTimeline = pluginEvents<LogData>(events.map((item) => item.event), 'rrweb/console@1');
  harEntries = debuggerHar;
  networkTimeline = buildNetworkTimeline(events.map((item) => item.event), debuggerHar);
  renderTimelinePanels();
  if (!events.length) {
    target.textContent = 'This tab has no recorded events.';
    return;
  }
  const firstTimestamp = events[0].event.timestamp;
  const player = new rrwebPlayer({
    target,
    props: { events: events.map((item) => item.event), autoPlay: false, width: 1000, height: 600 },
  });
  currentPlayer = player;
  const relativeOffset = Math.max(0, absoluteOffset - (firstTimestamp - activeRecording.startedAt));
  player.goto(relativeOffset, resume);
  player.addEventListener('ui-update-current-time', (params) => {
    const detail = params as { payload?: number };
    currentOffset = firstTimestamp - activeRecording.startedAt + (detail.payload ?? 0);
    updatePlaybackDateTime();
    renderTimelinePanels();
    const activity = [...(activeRecording.tabActivity ?? [])]
      .reverse()
      .find((item) => item.timestamp - activeRecording.startedAt <= currentOffset);
    if (currentPlaying && activity && activity.tabId !== currentTabId && !activitySwitching) {
      const activeTab = activeRecording.tabs.find((item) => item.tabId === activity.tabId);
      if (activeTab) {
        activitySwitching = true;
        void play(activeTab, currentOffset, currentPlaying).finally(() => {
          activitySwitching = false;
        });
      }
    }
  });
  player.addEventListener('ui-update-player-state', (params) => {
    const detail = params as { payload?: string };
    currentPlaying = detail.payload === 'playing';
  });
}

function pluginEvents<T>(events: eventWithTime[], plugin: string): PluginEvent<T>[] {
  return events.filter((event): event is PluginEvent<T> =>
    typeof event.data === 'object' && event.data !== null &&
    'plugin' in event.data && event.data.plugin === plugin && 'payload' in event.data,
  );
}

async function importRecording(file: File): Promise<void> {
  try {
    let json: string | undefined;
    let harJson: string | undefined;
    if (file.name.toLowerCase().endsWith('.zip')) {
      const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const entries = Object.entries(files);
      const rrwebEntry = files['recording.rrweb.json']
        ? ['recording.rrweb.json', files['recording.rrweb.json']] as const
        : entries.find(([name]) => /\.rrweb\.json$/i.test(name));
      const harEntry = files['recording.har']
        ? ['recording.har', files['recording.har']] as const
        : entries.find(([name]) => name.toLowerCase().endsWith('.har'));
      if (!rrwebEntry && !harEntry) throw new Error('ZIP does not contain an rrweb JSON or HAR file.');
      if (rrwebEntry) json = strFromU8(rrwebEntry[1]);
      if (harEntry) harJson = strFromU8(harEntry[1]);
    } else if (file.name.toLowerCase().endsWith('.har')) {
      harJson = await file.text();
    } else {
      json = await file.text();
    }

    if (harJson) {
      const parsedHar = JSON.parse(harJson) as { log?: { entries?: HarEntry[] } };
      importedHarEntries = Array.isArray(parsedHar.log?.entries) ? parsedHar.log.entries : [];
    }

    if (!json) {
      if (!importedHarEntries?.length) throw new Error('No recording data found.');
      const startedAt = Math.min(...importedHarEntries.map((entry) => Date.parse(entry.startedDateTime)));
      loadedRecording = {
        id: `import-${Date.now()}`,
        title: file.name.replace(/\.(rrweb\.)?(json|zip|har)$/i, ''),
        startedAt,
        endedAt: Math.max(...importedHarEntries.map((entry) => Date.parse(entry.startedDateTime) + entry.time)),
        active: false,
        tabs: [{ tabId: 1, title: 'Imported HAR', url: '', startedAt, eventCount: 0 }],
        eventCount: 0,
        tabActivity: [{ tabId: 1, timestamp: startedAt }],
      };
      importedEvents = [];
      await loadRecording();
      return;
    }

    const parsed = JSON.parse(json) as {
      recording?: Recording;
      events?: StoredEvent[];
      har?: { log?: { entries?: HarEntry[] } };
      network?: unknown;
    } | eventWithTime[];
    if (Array.isArray(parsed)) {
      if (!parsed.length) throw new Error('The rrweb event list is empty.');
      const tabId = 1;
      const startedAt = Math.min(...parsed.map((event) => event.timestamp));
      loadedRecording = {
        id: `import-${Date.now()}`,
        title: file.name.replace(/\.(rrweb\.)?(json|zip)$/i, ''),
        startedAt,
        endedAt: Math.max(...parsed.map((event) => event.timestamp)),
        active: false,
        tabs: [{
          tabId,
          title: 'Imported recording',
          url: '',
          startedAt,
          eventCount: parsed.length,
        }],
        eventCount: parsed.length,
        tabActivity: [{ tabId, timestamp: startedAt }],
      };
      importedEvents = parsed.map((event) => ({
        recordingId: loadedRecording!.id,
        tabId,
        timestamp: event.timestamp,
        event,
      }));
    } else {
      if (!parsed.recording || !Array.isArray(parsed.events)) {
        throw new Error('Unsupported rrweb JSON format.');
      }
      loadedRecording = parsed.recording;
      importedEvents = parsed.events;
      if (!importedHarEntries && Array.isArray(parsed.har?.log?.entries)) {
        importedHarEntries = parsed.har.log.entries;
      }
    }
    await loadRecording();
  } catch (error) {
    document.querySelector('#player')!.textContent =
      error instanceof Error ? `Could not open recording: ${error.message}` : 'Could not open recording.';
  }
}

function renderTimelinePanels(): void {
  if (!loadedRecording) return;
  const timestamp = loadedRecording.startedAt + currentOffset;
  renderConsole(consoleTimeline, timestamp);
  renderNetwork(networkTimeline, timestamp);
}

function renderConsole(entries: PluginEvent<LogData>[], currentTimestamp: number): void {
  const target = document.querySelector<HTMLElement>('#console-events')!;
  const occurredCount = entries.filter((event) => event.timestamp <= currentTimestamp).length;
  document.querySelector('#console-count')!.textContent = `${occurredCount} / ${entries.length}`;
  target.replaceChildren();
  if (!entries.length) {
    target.textContent = 'No console events recorded.';
    return;
  }
  for (const event of entries) {
    const row = document.createElement('details');
    row.className = `event-row console-${event.data.payload.level}`;
    row.classList.toggle('future-event', event.timestamp > currentTimestamp);
    const summary = document.createElement('summary');
    summary.textContent = `${formatTime(event.timestamp)} ${event.data.payload.level.toUpperCase()} ${event.data.payload.payload.join(' ')}`;
    const body = document.createElement('pre');
    body.textContent = event.data.payload.trace.length
      ? `${event.data.payload.payload.join('\n')}\n\n${event.data.payload.trace.join('\n')}`
      : event.data.payload.payload.join('\n');
    row.append(summary, body);
    target.append(row);
  }
}

function buildNetworkTimeline(
  events: eventWithTime[],
  debuggerHar: HarEntry[] = [],
): typeof networkTimeline {
  const pluginRequests = pluginEvents<NetworkData>(events, 'rrweb/network@1')
    .flatMap((event) => (event.data.payload.requests ?? []).map((request) => ({
      request,
      timestamp: event.timestamp,
      source: 'performance' as const,
    })));
  const debuggerEntries = debuggerHar.map((entry) => ({
    request: {
      name: entry.request.url,
      method: entry.request.method,
      status: entry.response.status || undefined,
      initiatorType: (entry._resourceType ?? 'other').toLowerCase() as NetworkRequest['initiatorType'],
      requestHeaders: Object.fromEntries(entry.request.headers.map((header) => [header.name, header.value])),
      requestBody: entry.request.postData?.text,
      responseHeaders: Object.fromEntries(entry.response.headers.map((header) => [header.name, header.value])),
      responseBody: entry.response.content.encoding === 'base64' && entry.response.content.text
        ? `[base64 encoded]\n${entry.response.content.text}`
        : entry.response.content.text,
      duration: entry.time,
    } as NetworkRequest,
    timestamp: Date.parse(entry.startedDateTime),
    source: 'debugger' as const,
    har: entry,
  }));
  const requests: typeof networkTimeline = [...debuggerEntries];
  for (const pluginEntry of pluginRequests) {
    const duplicate = debuggerEntries.some((debuggerEntry) =>
      debuggerEntry.request.name === pluginEntry.request.name &&
      (debuggerEntry.request.method ?? 'GET') === (pluginEntry.request.method ?? 'GET') &&
      Math.abs(debuggerEntry.timestamp - pluginEntry.timestamp) < 2_000,
    );
    if (!duplicate) requests.push(pluginEntry);
  }
  requests.sort((a, b) => a.timestamp - b.timestamp);
  return requests;
}

function renderNetwork(requests: typeof networkTimeline, currentTimestamp: number): void {
  const target = document.querySelector<HTMLElement>('#network-events')!;
  const occurredCount = requests.filter((entry) => entry.timestamp <= currentTimestamp).length;
  document.querySelector('#network-count')!.textContent = `${occurredCount} / ${requests.length}`;
  target.replaceChildren();
  if (!requests.length) {
    target.textContent = 'No network requests recorded.';
    return;
  }
  for (const { request, timestamp, source, har } of requests) {
    const row = document.createElement('details');
    row.className = 'event-row';
    row.classList.toggle('future-event', timestamp > currentTimestamp);
    const summary = document.createElement('summary');
    const status = request.status === undefined ? '—' : String(request.status);
    summary.textContent = `${formatTime(timestamp)} ${request.method ?? 'GET'} ${status} ${request.name}`;
    const body = document.createElement('pre');
    body.textContent = formatRequest(request, source, har);
    row.append(summary, body);
    target.append(row);
  }
}

function formatRequest(
  request: NetworkRequest,
  source: 'debugger' | 'performance',
  har?: HarEntry,
): string {
  const unavailableNote = source === 'performance'
    ? '\nCapture note: Shown from the rrweb Performance API plugin (no debugger). Headers/bodies are limited or missing.\n'
    : '';
  const timings = har?.timings;
  return [
    `URL: ${request.name}`,
    `Method: ${request.method ?? 'GET'}`,
    `Status: ${request.status ?? '—'}`,
    `Type: ${request.initiatorType ?? '—'}`,
    `Duration: ${request.duration === undefined ? '—' : `${Math.round(request.duration)} ms`}`,
    timings
      ? `Timings: blocked=${fmtMs(timings.blocked)} dns=${fmtMs(timings.dns)} connect=${fmtMs(timings.connect)} ssl=${fmtMs(timings.ssl)} send=${fmtMs(timings.send)} wait=${fmtMs(timings.wait)} receive=${fmtMs(timings.receive)}`
      : undefined,
    unavailableNote,
    '',
    'Request headers:',
    formatValue(request.requestHeaders),
    '',
    'Request body:',
    formatValue(request.requestBody),
    '',
    'Response headers:',
    formatValue(request.responseHeaders),
    '',
    'Response body:',
    formatValue(request.responseBody),
  ].filter((line) => line !== undefined).join('\n');
}

function fmtMs(value: number): string {
  return value < 0 ? '—' : `${Math.round(value)}ms`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return '[not available]';
  if (value === null || value === '') return '[empty]';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

function updatePlaybackDateTime(): void {
  if (!loadedRecording) return;
  document.querySelector('#playback-datetime')!.textContent =
    `Viewing ${formatDateTimeWithMilliseconds(loadedRecording.startedAt + currentOffset)}`;
}

function formatDateTimeWithMilliseconds(timestamp: number): string {
  const date = new Date(timestamp);
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.toLocaleString()}.${milliseconds}`;
}

function exportNetworkHar(): void {
  if (!loadedRecording || !harEntries.length) return;
  const har = wrapHarEntries(harEntries, {
    title: loadedRecording.title,
    startedAt: loadedRecording.startedAt,
  });
  const baseFilename = `${safeFilename(loadedRecording.title)}-${currentTabId ?? 'network'}`;
  const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${baseFilename}.har`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function exportNetworkPcap(): void {
  if (!networkTimeline.length || !loadedRecording) return;
  const encoder = new TextEncoder();
  const packets: Uint8Array[] = [];
  for (const entry of networkTimeline) {
    const payload = encoder.encode(JSON.stringify({
      capturedAt: new Date(entry.timestamp).toISOString(),
      source: entry.source,
      url: entry.request.name,
      method: entry.request.method ?? 'GET',
      status: entry.request.status,
      type: entry.request.initiatorType,
      duration: entry.request.duration,
      requestHeaders: entry.request.requestHeaders,
      requestBody: entry.request.requestBody,
      responseHeaders: entry.request.responseHeaders,
      responseBody: entry.request.responseBody,
    }));
    for (let offset = 0; offset < payload.length; offset += 60_000) {
      packets.push(createPcapPacket(payload.subarray(offset, offset + 60_000), entry.timestamp));
    }
  }
  const globalHeader = new Uint8Array(24);
  const view = new DataView(globalHeader.buffer);
  view.setUint32(0, 0xa1b2c3d4, true);
  view.setUint16(4, 2, true);
  view.setUint16(6, 4, true);
  view.setUint32(16, 65_535, true);
  view.setUint32(20, 1, true);
  const pcap = concatBytes([globalHeader, ...packets]);
  const baseFilename = `${safeFilename(loadedRecording.title)}-${currentTabId ?? 'network'}`;
  const archive = zipSync({ [`${baseFilename}.pcap`]: pcap }, { level: 9 });
  const blob = new Blob([
    archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
  ], { type: 'application/zip' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${baseFilename}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function createPcapPacket(payload: Uint8Array, timestamp: number): Uint8Array {
  const frameLength = 14 + 20 + 8 + payload.length;
  const packet = new Uint8Array(16 + frameLength);
  const view = new DataView(packet.buffer);
  const seconds = Math.floor(timestamp / 1000);
  view.setUint32(0, seconds, true);
  view.setUint32(4, (timestamp - seconds * 1000) * 1000, true);
  view.setUint32(8, frameLength, true);
  view.setUint32(12, frameLength, true);
  const ethernet = 16;
  packet.set([0x02, 0, 0, 0, 0, 2, 0x02, 0, 0, 0, 0, 1, 0x08, 0x00], ethernet);
  const ip = ethernet + 14;
  packet[ip] = 0x45;
  view.setUint16(ip + 2, 20 + 8 + payload.length);
  view.setUint16(ip + 4, Math.floor(timestamp) & 0xffff);
  view.setUint16(ip + 6, 0x4000);
  packet[ip + 8] = 64;
  packet[ip + 9] = 17;
  packet.set([10, 0, 0, 1, 10, 0, 0, 2], ip + 12);
  view.setUint16(ip + 10, ipv4Checksum(packet.subarray(ip, ip + 20)));
  const udp = ip + 20;
  view.setUint16(udp, 40_000);
  view.setUint16(udp + 2, 80);
  view.setUint16(udp + 4, 8 + payload.length);
  packet.set(payload, udp + 8);
  return packet;
}

function ipv4Checksum(header: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < header.length; index += 2) {
    sum += (header[index] << 8) | header[index + 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

function safeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) || 'recording';
}
