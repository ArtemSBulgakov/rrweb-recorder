import type { Recording } from './types';
import type { HarEntry, StoredHarEntry } from './har';

const BODY_RESOURCE_TYPES = new Set([
  'Document',
  'Script',
  'Stylesheet',
  'Font',
  'Image',
  'Fetch',
  'XHR',
]);

export type CaptureDiagnostic = {
  code: string;
  message: string;
  url?: string;
  method?: string;
  resourceType?: string;
  tabId?: number;
  sessionId?: string;
  requestId?: string;
  targetType?: string;
};

export type CaptureDiagnostics = {
  complete: boolean;
  generatedAt: number;
  recordingId: string;
  entryCount: number;
  errors: CaptureDiagnostic[];
};

function diagnostic(
  entry: HarEntry,
  code: string,
  message: string,
): CaptureDiagnostic {
  return {
    code,
    message,
    url: entry.request.url,
    method: entry.request.method,
    resourceType: entry._resourceType,
    tabId: entry._tabId,
    sessionId: entry._sessionId,
    requestId: entry._requestId,
    targetType: entry._targetType,
  };
}

function expectsBody(entry: HarEntry): boolean {
  if (entry.request.method.toUpperCase() === 'HEAD') return false;
  if ([101, 204, 205, 304].includes(entry.response.status)) return false;
  if (entry.response.status >= 300 && entry.response.status < 400) return false;
  return BODY_RESOURCE_TYPES.has(entry._resourceType ?? '')
    || entry.request.url.includes('/assets/config/config.json');
}

export function buildCaptureDiagnostics(
  recording: Recording,
  storedEntries: StoredHarEntry[],
): CaptureDiagnostics {
  const entries = storedEntries.map((stored) => stored.entry);
  const errors: CaptureDiagnostic[] = (recording.captureIssues ?? []).map((issue) => ({
    code: issue.code,
    message: issue.message,
    tabId: issue.tabId,
    sessionId: issue.sessionId,
    targetType: issue.targetType,
  }));

  const mainTabId = recording.tabs[0]?.tabId;
  const documents = entries.filter((entry) =>
    entry._tabId === mainTabId && entry._sessionId === 'root'
    && entry._resourceType === 'Document',
  );
  const mainDocument = [...documents].reverse().find((entry) =>
    entry.response.status >= 200 && entry.response.status < 400
    && entry.response.content.text !== undefined,
  ) ?? [...documents].reverse().find((entry) =>
    entry.response.status >= 200 && entry.response.status < 400,
  ) ?? documents.at(-1);
  if (!mainDocument) {
    errors.push({
      code: 'missing-main-document',
      message: 'The main Document request was not captured.',
      tabId: mainTabId,
    });
  } else if (mainDocument.response.content.text === undefined) {
    errors.push(diagnostic(
      mainDocument,
      'missing-main-document-body',
      'The main Document response body is missing.',
    ));
  }

  const expectsRuntimeConfig = entries.some((entry) =>
    entry.request.url.includes('/assets/config/')
    || entry.request.url.includes('visa.almaviva-russia.ru'),
  );
  if (expectsRuntimeConfig) {
    const runtimeConfig = entries.find((entry) =>
      entry.request.url.includes('/assets/config/config.json'),
    );
    if (!runtimeConfig) {
      errors.push({
        code: 'missing-runtime-config',
        message: '/assets/config/config.json was not captured.',
      });
    }
  }

  for (const entry of entries) {
    if (entry.response._error || entry._captureError) {
      errors.push(diagnostic(
        entry,
        'failed-request',
        entry.response._error ?? entry._captureError ?? 'Request capture failed.',
      ));
      continue;
    }
    if (expectsBody(entry) && entry.response.content.text === undefined) {
      errors.push(diagnostic(entry, 'missing-response-body', 'Expected response body is missing.'));
    }
    if (entry._sessionId !== 'root' && entry._targetType === 'unknown') {
      errors.push(diagnostic(entry, 'unsupported-target', 'Child target type is unknown.'));
    }
  }

  return {
    complete: errors.length === 0,
    generatedAt: Date.now(),
    recordingId: recording.id,
    entryCount: entries.length,
    errors,
  };
}

export function buildStandManifest(recording: Recording) {
  return {
    version: 1,
    startUrl: recording.tabs[0]?.url ?? '',
    capturedAt: recording.startedAt,
    har: '../recording.har',
    storageState: './storage-state.json',
  };
}
