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
  captureIssues?: CaptureIssue[];
};

export type TabActivity = { tabId: number; timestamp: number };

export type CaptureIssue = {
  capturedAt: number;
  code: string;
  message: string;
  tabId?: number;
  sessionId?: string;
  targetType?: string;
};

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
  | { type: 'CAPTURE_BROWSER_STORAGE' }
  | { type: 'RRWEB_RECORDER_READY' }
  | { type: 'RRWEB_EVENT'; recordingId: string; tabId: number; event: eventWithTime };

export type RecorderConfig = {
  recordConsole: boolean;
  recordNetwork: boolean;
  sequentialId: boolean;
  captureAllNetworkBodies: boolean;
};

export type RecordingOptions = Pick<
  RecorderConfig,
  'recordConsole' | 'recordNetwork' | 'sequentialId' | 'captureAllNetworkBodies'
> & { cookieDomains: string[] };

export type ExtensionMessage =
  | { type: 'SAVE_COOKIE_DOMAINS'; domains: string[] }
  | { type: 'START_RECORDING'; options: RecordingOptions }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_STATE' }
  | { type: 'GET_ACTIVE_RECORDING' }
  | { type: 'OPEN_LIBRARY' }
  | { type: 'ACTIVATE_TAB'; tabId: number }
  | { type: 'CONTENT_BRIDGE_READY' }
  | ({ type: 'CONTENT_READY'; url: string; title: string } & CapturedOriginStorage)
  | ({ type: 'BROWSER_STORAGE_STATE' } & CapturedOriginStorage)
  | { type: 'CAPTURE_BROWSER_STORAGE' }
  | { type: 'RECORDED_EVENT'; recordingId: string; tabId: number; event: eventWithTime };

export type RuntimeState = {
  activeRecordingId?: string;
  active: boolean;
  trackedTabIds: number[];
  options: RecordingOptions;
};

export type CDPCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  priority: 'Low' | 'Medium' | 'High';
  sameParty: boolean;
  sourceScheme: 'Unset' | 'NonSecure' | 'Secure';
  sourcePort: number;
  partitionKey?: {
    topLevelSite: string;
    hasCrossSiteAncestor: boolean;
  };
  partitionKeyOpaque?: boolean;
};

export type CapturedFrameStorage = {
  tabId?: number;
  frameId?: number;
  origin: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
};

export type CapturedOriginStorage = {
  origin: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  frames?: CapturedFrameStorage[];
};

export type CapturedBrowserState = {
  recordingId: string;
  capturedAt: number;
  cookies: CDPCookie[];
  origins: Record<
    string,
    {
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
      frames?: CapturedFrameStorage[];
    }
  >;
};

export type { HarEntry, HarLog, StoredHarEntry } from './har';
