import type { eventWithTime } from '@rrweb/types';

export type BrowserTab = {
  tabId: number;
  title: string;
  url: string;
  startedAt: number;
  endedAt?: number;
  eventCount: number;
  lastEventAt?: number;
};

export type Recording = {
  id: string;
  title: string;
  startedAt: number;
  endedAt?: number;
  active: boolean;
  tabs: BrowserTab[];
  eventCount: number;
  tabActivity: TabActivity[];
};

export type TabActivity = { tabId: number; timestamp: number };

export type StoredEvent = {
  id?: number;
  recordingId: string;
  tabId: number;
  timestamp: number;
  event: eventWithTime;
};

export type RecorderCommand =
  | { type: 'RRWEB_START'; recordingId: string; tabId: number; config: RecorderConfig }
  | { type: 'RRWEB_STOP'; recordingId: string }
  | { type: 'RRWEB_RECORDER_READY' }
  | { type: 'RRWEB_EVENT'; recordingId: string; tabId: number; event: eventWithTime };

export type RecorderConfig = {
  redactHeaders: string[];
  recordConsole: boolean;
  recordNetwork: boolean;
  sequentialId: boolean;
  captureAllNetworkBodies: boolean;
};

export type RecordingOptions = Pick<
  RecorderConfig,
  'recordConsole' | 'recordNetwork' | 'sequentialId' | 'captureAllNetworkBodies'
>;

export type ExtensionMessage =
  | { type: 'START_RECORDING'; options: RecordingOptions }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_ACTIVE_RECORDING' }
  | { type: 'OPEN_LIBRARY' }
  | { type: 'ACTIVATE_TAB'; tabId: number }
  | { type: 'RELOAD_RECORDED_TABS' }
  | { type: 'CONTENT_BRIDGE_READY' }
  | { type: 'CONTENT_READY'; url: string; title: string }
  | { type: 'RECORDED_EVENT'; recordingId: string; tabId: number; event: eventWithTime };

export type RuntimeState = {
  activeRecordingId?: string;
  active: boolean;
  trackedTabIds: number[];
  options: RecordingOptions;
};

export type { HarEntry, HarLog, StoredHarEntry } from './har';
