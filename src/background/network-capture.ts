import { putHarEntry } from '../storage/db';
import {
  applyHarResponse,
  applyHarTimings,
  createHarEntry,
  mergeHarHeaders,
  setHarRequestBody,
  setHarResponseBody,
  type HarEntry,
  type NetworkResourceTiming,
} from '../shared/har';

const ext = chrome;
const MAX_POST_DATA_SIZE = 10 * 1024 * 1024;
const MAX_RESOURCE_BUFFER_SIZE = 50 * 1024 * 1024;
const MAX_TOTAL_BUFFER_SIZE = 100 * 1024 * 1024;

type PendingRequest = {
  requestId: string;
  cdpRequestId: string;
  tabId: number;
  redirectIndex: number;
  entry: HarEntry;
  requestTime?: number;
  responseTime?: number;
  finishedTime?: number;
  resourceTiming?: NetworkResourceTiming;
  encodedDataLength?: number;
  dataLength?: number;
  failed?: boolean;
};

const pending = new Map<string, PendingRequest>();
const debuggerTargets = new Set<number>();

function key(tabId: number, requestId: string): string {
  return `${tabId}:${requestId}`;
}

function asHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([name, headerValue]) => [
      name,
      String(headerValue),
    ]),
  );
}

function asTiming(value: unknown): NetworkResourceTiming | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const timing = value as Record<string, number>;
  if (typeof timing.requestTime !== 'number') return undefined;
  return {
    requestTime: timing.requestTime,
    proxyStart: timing.proxyStart ?? -1,
    proxyEnd: timing.proxyEnd ?? -1,
    dnsStart: timing.dnsStart ?? -1,
    dnsEnd: timing.dnsEnd ?? -1,
    connectStart: timing.connectStart ?? -1,
    connectEnd: timing.connectEnd ?? -1,
    sslStart: timing.sslStart ?? -1,
    sslEnd: timing.sslEnd ?? -1,
    workerStart: timing.workerStart ?? -1,
    workerReady: timing.workerReady ?? -1,
    sendStart: timing.sendStart ?? -1,
    sendEnd: timing.sendEnd ?? -1,
    receiveHeadersStart: timing.receiveHeadersStart,
    receiveHeadersEnd: timing.receiveHeadersEnd ?? -1,
    pushStart: timing.pushStart ?? 0,
    pushEnd: timing.pushEnd ?? 0,
  };
}

function wallTimeMs(wallTime: unknown, fallback = Date.now()): number {
  return typeof wallTime === 'number' ? Math.round(wallTime * 1000) : fallback;
}

function storageId(cdpRequestId: string, redirectIndex: number): string {
  return redirectIndex === 0 ? cdpRequestId : `${cdpRequestId}:r${redirectIndex}`;
}

function refreshTimings(request: PendingRequest): void {
  applyHarTimings(
    request.entry,
    request.resourceTiming,
    request.requestTime,
    request.responseTime,
    request.finishedTime,
  );
}

async function persist(recordingId: string, request: PendingRequest): Promise<void> {
  refreshTimings(request);
  await putHarEntry({
    recordingId,
    requestId: request.requestId,
    tabId: request.tabId,
    entry: request.entry,
  });
}

async function fetchRequestBody(
  tabId: number,
  cdpRequestId: string,
  request: PendingRequest,
  recordingId: string,
): Promise<void> {
  if (request.entry.request.postData?.text !== undefined) return;
  const method = request.entry.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  try {
    const result = await ext.debugger.sendCommand(
      { tabId },
      'Network.getRequestPostData',
      { requestId: cdpRequestId },
    ) as { postData?: string };
    if (result.postData !== undefined) {
      setHarRequestBody(request.entry, result.postData);
      await persist(recordingId, request);
    }
  } catch {
    // Body unavailable for multipart file uploads, already-evicted buffers, etc.
  }
}

async function fetchResponseBody(
  tabId: number,
  cdpRequestId: string,
  request: PendingRequest,
  recordingId: string,
): Promise<void> {
  if (request.failed) {
    await persist(recordingId, request);
    return;
  }
  try {
    const body = await ext.debugger.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId: cdpRequestId },
    ) as { body?: string; base64Encoded?: boolean };
    setHarResponseBody(
      request.entry,
      body.body,
      body.base64Encoded,
      request.encodedDataLength,
    );
  } catch {
    setHarResponseBody(request.entry, undefined);
  }
  await persist(recordingId, request);
}

function applyRedirectResponse(
  request: PendingRequest,
  redirectResponse: Record<string, any>,
  timestamp: number,
): void {
  applyHarResponse(request.entry, {
    status: redirectResponse.status,
    statusText: redirectResponse.statusText,
    headers: asHeaders(redirectResponse.headers),
    mimeType: redirectResponse.mimeType,
    protocol: redirectResponse.protocol,
    remoteIPAddress: redirectResponse.remoteIPAddress,
    fromCache: Boolean(redirectResponse.fromDiskCache || redirectResponse.fromServiceWorker),
  });
  request.resourceTiming = asTiming(redirectResponse.timing) ?? request.resourceTiming;
  request.responseTime = timestamp;
  request.finishedTime = timestamp;
  if (request.resourceTiming) request.requestTime = request.resourceTiming.requestTime;
}

export async function configureNetworkDebugger(tabId: number): Promise<void> {
  await ext.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxTotalBufferSize: MAX_TOTAL_BUFFER_SIZE,
    maxResourceBufferSize: MAX_RESOURCE_BUFFER_SIZE,
    maxPostDataSize: MAX_POST_DATA_SIZE,
  });
  await ext.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: true });
}

export async function attachNetworkDebugger(tabId: number): Promise<boolean> {
  if (!ext.debugger?.attach) return false;
  if (debuggerTargets.has(tabId)) {
    try {
      await configureNetworkDebugger(tabId);
      return true;
    } catch {
      debuggerTargets.delete(tabId);
    }
  }
  try {
    await ext.debugger.attach({ tabId }, '1.3');
    debuggerTargets.add(tabId);
    await configureNetworkDebugger(tabId);
    return true;
  } catch {
    debuggerTargets.delete(tabId);
    return false;
  }
}

export async function detachNetworkDebugger(tabId: number): Promise<void> {
  if (!ext.debugger?.detach || !debuggerTargets.delete(tabId)) return;
  for (const [entryKey] of pending) {
    if (entryKey.startsWith(`${tabId}:`)) pending.delete(entryKey);
  }
  await ext.debugger.detach({ tabId }).catch(() => undefined);
}

export function networkDebuggerTabIds(): number[] {
  return [...debuggerTargets];
}

export function markNetworkDebuggerDetached(tabId: number): void {
  debuggerTargets.delete(tabId);
  for (const [entryKey] of pending) {
    if (entryKey.startsWith(`${tabId}:`)) pending.delete(entryKey);
  }
}

export async function handleNetworkDebuggerEvent(
  tabId: number,
  recordingId: string,
  method: string,
  params: Record<string, any>,
): Promise<void> {
  const cdpRequestId = params.requestId as string | undefined;
  if (!cdpRequestId) return;
  const entryKey = key(tabId, cdpRequestId);

  if (method === 'Network.requestWillBeSent') {
    const existing = pending.get(entryKey);
    if (existing && params.redirectResponse) {
      applyRedirectResponse(existing, params.redirectResponse, params.timestamp);
      await persist(recordingId, existing);
      pending.delete(entryKey);
    }

    const redirectIndex = existing && params.redirectResponse
      ? existing.redirectIndex + 1
      : 0;
    const request = params.request as Record<string, any>;
    const requestId = storageId(cdpRequestId, redirectIndex);
    const captured: PendingRequest = {
      requestId,
      cdpRequestId,
      tabId,
      redirectIndex,
      entry: createHarEntry({
        requestId,
        tabId,
        wallTimeMs: wallTimeMs(params.wallTime),
        url: request.url,
        method: request.method,
        type: params.type ?? 'Other',
        headers: asHeaders(request.headers),
        postData: typeof request.postData === 'string' ? request.postData : undefined,
      }),
      requestTime: typeof params.timestamp === 'number' ? params.timestamp : undefined,
    };
    pending.set(entryKey, captured);
    await persist(recordingId, captured);
    void fetchRequestBody(tabId, cdpRequestId, captured, recordingId);
    return;
  }

  if (method === 'Network.requestWillBeSentExtraInfo') {
    const request = pending.get(entryKey);
    if (!request) return;
    request.entry.request.headers = mergeHarHeaders(
      request.entry.request.headers,
      asHeaders(params.headers),
    );
    await persist(recordingId, request);
    return;
  }

  const request = pending.get(entryKey);
  if (!request) return;

  if (method === 'Network.responseReceived') {
    const response = params.response as Record<string, any>;
    applyHarResponse(request.entry, {
      status: response.status,
      statusText: response.statusText,
      headers: asHeaders(response.headers),
      mimeType: response.mimeType,
      protocol: response.protocol,
      remoteIPAddress: response.remoteIPAddress,
      fromCache: Boolean(response.fromDiskCache || response.fromServiceWorker),
    });
    request.entry._resourceType = params.type ?? request.entry._resourceType;
    request.resourceTiming = asTiming(response.timing) ?? request.resourceTiming;
    request.responseTime = typeof params.timestamp === 'number' ? params.timestamp : request.responseTime;
    if (request.resourceTiming) request.requestTime = request.resourceTiming.requestTime;
    await persist(recordingId, request);
    return;
  }

  if (method === 'Network.responseReceivedExtraInfo') {
    request.entry.response.headers = mergeHarHeaders(
      request.entry.response.headers,
      asHeaders(params.headers),
    );
    if (typeof params.statusCode === 'number') request.entry.response.status = params.statusCode;
    request.entry.response.redirectURL =
      request.entry.response.headers.find((header) => header.name.toLowerCase() === 'location')?.value
      || '';
    await persist(recordingId, request);
    return;
  }

  if (method === 'Network.dataReceived') {
    request.dataLength = (request.dataLength ?? 0) + (params.dataLength ?? 0);
    request.encodedDataLength = (request.encodedDataLength ?? 0) + (params.encodedDataLength ?? 0);
    return;
  }

  if (method === 'Network.requestServedFromCache') {
    request.entry._fromCache = true;
    await persist(recordingId, request);
    return;
  }

  if (method === 'Network.loadingFinished') {
    request.finishedTime = typeof params.timestamp === 'number' ? params.timestamp : request.finishedTime;
    if (typeof params.encodedDataLength === 'number') {
      request.encodedDataLength = params.encodedDataLength;
      request.entry.response._transferSize = params.encodedDataLength;
    }
    pending.delete(entryKey);
    await fetchResponseBody(tabId, cdpRequestId, request, recordingId);
    return;
  }

  if (method === 'Network.loadingFailed') {
    request.failed = true;
    request.entry.response._error = params.errorText;
    request.entry.response.bodySize = -1;
    request.finishedTime = typeof params.timestamp === 'number' ? params.timestamp : request.finishedTime;
    request.entry._resourceType = params.type ?? request.entry._resourceType;
    pending.delete(entryKey);
    await persist(recordingId, request);
  }
}
