import { putHarEntry } from '../storage/db';
import type { CaptureIssue } from '../shared/types';
import {
  applyHarResponse,
  applyHarTimings,
  createHarEntry,
  headersFromRawText,
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
const ROOT_SESSION_ID = 'root';

type PendingRequest = {
  recordingId: string;
  requestId: string;
  cdpRequestId: string;
  tabId: number;
  sessionId: string;
  targetType: string;
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
const debuggerAttachTasks = new Map<number, Promise<boolean>>();
const targetTypes = new Map<string, string>();
const activeBodyTasks = new Set<Promise<void>>();
const bodyTaskRequests = new Map<Promise<void>, { recordingId: string; request: PendingRequest }>();
const abandonedBodyRequests = new WeakSet<PendingRequest>();
const requestExtraInfoEvents = new Map<string, Record<string, any>[]>();
const requestExtraInfoTargets = new Map<string, PendingRequest[]>();
const responseExtraInfoEvents = new Map<string, Record<string, any>[]>();
const responseExtraInfoTargets = new Map<string, PendingRequest[]>();

type Debuggee = { tabId: number; sessionId?: string };

export function networkRequestKey(
  tabId: number,
  sessionId: string | undefined,
  requestId: string,
): string {
  return `${tabId}:${sessionId ?? ROOT_SESSION_ID}:${requestId}`;
}

function sessionStorageId(sessionId?: string): string {
  return sessionId ?? ROOT_SESSION_ID;
}

function targetKey(tabId: number, sessionId?: string): string {
  return `${tabId}:${sessionStorageId(sessionId)}`;
}

function debuggee(tabId: number, sessionId?: string): Debuggee {
  return sessionId ? { tabId, sessionId } : { tabId };
}

function asHeaders(value: unknown): Array<{ name: string; value: string }> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return Object.entries(value as Record<string, unknown>).flatMap(([name, headerValue]) => {
    const values = String(headerValue).split('\n');
    if (name.toLowerCase() === 'set-cookie') {
      return values.map((value) => ({ name, value }));
    }
    return [{ name, value: values.join('\n') }];
  });
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
    sessionId: request.sessionId,
    entry: request.entry,
  });
}

async function fetchRequestBody(
  tabId: number,
  sessionId: string | undefined,
  cdpRequestId: string,
  request: PendingRequest,
  recordingId: string,
): Promise<void> {
  if (request.entry.request.postData?.text !== undefined) return;
  const method = request.entry.request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return;
  try {
    const result = await ext.debugger.sendCommand(
      debuggee(tabId, sessionId),
      'Network.getRequestPostData',
      { requestId: cdpRequestId },
    ) as { postData?: string };
    if (abandonedBodyRequests.has(request)) return;
    if (result.postData !== undefined) {
      setHarRequestBody(request.entry, result.postData);
      await persist(recordingId, request);
    }
  } catch (error) {
    if (abandonedBodyRequests.has(request)) return;
    request.entry._captureError = error instanceof Error ? error.message : String(error);
    await persist(recordingId, request);
  }
}

async function fetchResponseBody(
  tabId: number,
  sessionId: string | undefined,
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
      debuggee(tabId, sessionId),
      'Network.getResponseBody',
      { requestId: cdpRequestId },
    ) as { body?: string; base64Encoded?: boolean };
    if (abandonedBodyRequests.has(request)) return;
    setHarResponseBody(
      request.entry,
      body.body,
      body.base64Encoded,
      request.encodedDataLength,
    );
  } catch (error) {
    if (abandonedBodyRequests.has(request)) return;
    setHarResponseBody(request.entry, undefined);
    request.entry._captureError = error instanceof Error ? error.message : String(error);
  }
  await persist(recordingId, request);
}

function trackBodyTask(
  task: Promise<void>,
  recordingId: string,
  request: PendingRequest,
): void {
  activeBodyTasks.add(task);
  bodyTaskRequests.set(task, { recordingId, request });
  void task.finally(() => {
    activeBodyTasks.delete(task);
    bodyTaskRequests.delete(task);
  });
}

function applyRequestExtraInfo(request: PendingRequest, params: Record<string, any>): void {
  request.entry.request.headers = mergeHarHeaders(
    request.entry.request.headers,
    headersFromRawText(params.headersText) ?? asHeaders(params.headers),
  );
}

function applyResponseExtraInfo(request: PendingRequest, params: Record<string, any>): void {
  request.entry.response.headers = mergeHarHeaders(
    request.entry.response.headers,
    headersFromRawText(params.headersText) ?? asHeaders(params.headers),
  );
  if (request.entry.response.status === 0 && typeof params.statusCode === 'number') {
    request.entry.response.status = params.statusCode;
  }
  const redirectURL = request.entry.response.headers.find(
    (header) => header.name.toLowerCase() === 'location',
  )?.value;
  if (redirectURL) request.entry.response.redirectURL = redirectURL;
}

function enqueue<T>(queue: Map<string, T[]>, key: string, value: T): void {
  const values = queue.get(key) ?? [];
  values.push(value);
  queue.set(key, values);
}

async function applyQueuedExtraInfo(
  entryKey: string,
  targets: Map<string, PendingRequest[]>,
  events: Map<string, Record<string, any>[]>,
  apply: (request: PendingRequest, params: Record<string, any>) => void,
): Promise<void> {
  const pendingTargets = targets.get(entryKey);
  const pendingEvents = events.get(entryKey);
  while (pendingTargets?.length && pendingEvents?.length) {
    const request = pendingTargets.shift()!;
    apply(request, pendingEvents.shift()!);
    await persist(request.recordingId, request);
  }
  if (!pendingTargets?.length) targets.delete(entryKey);
  if (!pendingEvents?.length) events.delete(entryKey);
}

export async function drainNetworkCapture(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeBodyTasks.size) {
    const tasks = [...activeBodyTasks];
    const remainingMs = Math.max(0, deadline - Date.now());
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      Promise.allSettled(tasks).then(() => 'drained' as const),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve();
        }, remainingMs);
      }).then(() => 'timeout' as const),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (result === 'timeout') {
      const unfinished = tasks
        .map((task) => ({ task, tracked: bodyTaskRequests.get(task) }))
        .filter((item): item is { task: Promise<void>; tracked: NonNullable<typeof item.tracked> } =>
          item.tracked !== undefined);
      await Promise.all(unfinished.map(async ({ task, tracked: { recordingId, request } }) => {
        abandonedBodyRequests.add(request);
        activeBodyTasks.delete(task);
        bodyTaskRequests.delete(task);
        request.entry.response._error = 'capture stopped before completion';
        request.entry._captureError = 'capture stopped before completion';
        await persist(recordingId, request);
      }));
      break;
    }
  }

  await Promise.all([...pending.values()].map(async (request) => {
    request.entry.response._error = 'capture stopped before completion';
    request.entry._captureError = 'capture stopped before completion';
    await persist(request.recordingId, request);
  }));
  pending.clear();
  requestExtraInfoEvents.clear();
  requestExtraInfoTargets.clear();
  responseExtraInfoEvents.clear();
  responseExtraInfoTargets.clear();
}

export function pendingNetworkRequestCount(): number {
  return pending.size + activeBodyTasks.size;
}

export function pendingNetworkCaptureIssues(): CaptureIssue[] {
  return [...pending.values()].map((request) => ({
    capturedAt: Date.now(),
    code: 'pending-request',
    message: `${request.entry.request.method} ${request.entry.request.url} is still pending.`,
    tabId: request.tabId,
    sessionId: request.sessionId,
    targetType: request.targetType,
  }));
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

export async function configureNetworkDebugger(
  tabId: number,
  sessionId?: string,
): Promise<void> {
  const source = debuggee(tabId, sessionId);
  await ext.debugger.sendCommand(source, 'Network.enable', {
    maxTotalBufferSize: MAX_TOTAL_BUFFER_SIZE,
    maxResourceBufferSize: MAX_RESOURCE_BUFFER_SIZE,
    maxPostDataSize: MAX_POST_DATA_SIZE,
  });
  await ext.debugger.sendCommand(source, 'Network.setCacheDisabled', { cacheDisabled: true });
  await ext.debugger.sendCommand(source, 'Network.setBypassServiceWorker', { bypass: true });
}

async function attachNetworkDebuggerUnlocked(tabId: number): Promise<boolean> {
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
    targetTypes.set(targetKey(tabId), 'page');
    await ext.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await configureNetworkDebugger(tabId);
    return true;
  } catch {
    await ext.debugger.detach({ tabId }).catch(() => undefined);
    debuggerTargets.delete(tabId);
    targetTypes.delete(targetKey(tabId));
    return false;
  }
}

export async function attachNetworkDebugger(tabId: number): Promise<boolean> {
  const existing = debuggerAttachTasks.get(tabId);
  if (existing) return existing;
  const task = attachNetworkDebuggerUnlocked(tabId);
  debuggerAttachTasks.set(tabId, task);
  try {
    return await task;
  } finally {
    if (debuggerAttachTasks.get(tabId) === task) debuggerAttachTasks.delete(tabId);
  }
}

export async function settleNetworkDebuggerAttachments(): Promise<void> {
  while (debuggerAttachTasks.size) {
    await Promise.allSettled([...debuggerAttachTasks.values()]);
  }
}

async function finalizeMatchingRequests(
  matches: (request: PendingRequest) => boolean,
): Promise<void> {
  const requests = [...pending.entries()].filter(([, request]) => matches(request));
  await Promise.all(requests.map(async ([entryKey, request]) => {
    request.entry.response._error = 'capture stopped before completion';
    request.entry._captureError = 'capture stopped before completion';
    await persist(request.recordingId, request);
    pending.delete(entryKey);
    clearExtraInfoQueues(entryKey);
  }));
  const bodyTasks = [...bodyTaskRequests.entries()].filter(([, { request }]) => matches(request));
  await Promise.all(bodyTasks.map(async ([task, { recordingId, request }]) => {
    abandonedBodyRequests.add(request);
    activeBodyTasks.delete(task);
    bodyTaskRequests.delete(task);
    request.entry.response._error = 'capture stopped before completion';
    request.entry._captureError = 'capture stopped before completion';
    await persist(recordingId, request);
  }));
}

function clearExtraInfoQueues(entryKey: string): void {
  requestExtraInfoEvents.delete(entryKey);
  requestExtraInfoTargets.delete(entryKey);
  responseExtraInfoEvents.delete(entryKey);
  responseExtraInfoTargets.delete(entryKey);
}

function clearExtraInfoQueuesForTab(tabId: number, sessionId?: string): void {
  const prefix = sessionId === undefined
    ? `${tabId}:`
    : `${tabId}:${sessionStorageId(sessionId)}:`;
  for (const key of new Set([
    ...requestExtraInfoEvents.keys(),
    ...requestExtraInfoTargets.keys(),
    ...responseExtraInfoEvents.keys(),
    ...responseExtraInfoTargets.keys(),
  ])) {
    if (key.startsWith(prefix)) clearExtraInfoQueues(key);
  }
}

export async function detachNetworkDebugger(tabId: number): Promise<void> {
  if (!ext.debugger?.detach || !debuggerTargets.has(tabId)) return;
  await finalizeMatchingRequests((request) => request.tabId === tabId);
  clearExtraInfoQueuesForTab(tabId);
  for (const key of targetTypes.keys()) {
    if (key.startsWith(`${tabId}:`)) targetTypes.delete(key);
  }
  await ext.debugger.detach({ tabId }).catch(() => undefined);
  debuggerTargets.delete(tabId);
}

export function networkDebuggerTabIds(): number[] {
  return [...debuggerTargets];
}

export async function markNetworkDebuggerDetached(tabId: number): Promise<void> {
  debuggerTargets.delete(tabId);
  await finalizeMatchingRequests((request) => request.tabId === tabId);
  clearExtraInfoQueuesForTab(tabId);
  for (const key of targetTypes.keys()) {
    if (key.startsWith(`${tabId}:`)) targetTypes.delete(key);
  }
}

export async function handleTargetDebuggerEvent(
  tabId: number,
  recordingId: string,
  method: string,
  params: Record<string, any>,
): Promise<void> {
  if (method === 'Target.attachedToTarget') {
    const sessionId = params.sessionId as string | undefined;
    if (!sessionId) return;
    const targetType = String(params.targetInfo?.type ?? 'unknown');
    targetTypes.set(targetKey(tabId, sessionId), targetType);
    try {
      await configureNetworkDebugger(tabId, sessionId);
      await ext.debugger.sendCommand(debuggee(tabId, sessionId), 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    } finally {
      await ext.debugger.sendCommand(
        debuggee(tabId, sessionId),
        'Runtime.runIfWaitingForDebugger',
      ).catch(() => undefined);
    }
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    const sessionId = params.sessionId as string | undefined;
    if (sessionId) {
      await finalizeMatchingRequests((request) =>
        request.recordingId === recordingId
        && request.tabId === tabId
        && request.sessionId === sessionId);
      clearExtraInfoQueuesForTab(tabId, sessionId);
      targetTypes.delete(targetKey(tabId, sessionId));
    }
  }
}

export async function handleNetworkDebuggerEvent(
  tabId: number,
  sessionId: string | undefined,
  recordingId: string,
  method: string,
  params: Record<string, any>,
): Promise<void> {
  const cdpRequestId = params.requestId as string | undefined;
  if (!cdpRequestId) return;
  const entryKey = networkRequestKey(tabId, sessionId, cdpRequestId);

  if (method === 'Network.requestWillBeSent') {
    const existing = pending.get(entryKey);
    if (existing && params.redirectResponse) {
      applyRedirectResponse(existing, params.redirectResponse, params.timestamp);
      existing.entry.response.redirectURL = String(params.request?.url ?? '');
      pending.delete(entryKey);
      if (params.redirectHasExtraInfo) {
        enqueue(responseExtraInfoTargets, entryKey, existing);
        await applyQueuedExtraInfo(
          entryKey,
          responseExtraInfoTargets,
          responseExtraInfoEvents,
          applyResponseExtraInfo,
        );
      }
      await persist(recordingId, existing);
    }

    const redirectIndex = existing && params.redirectResponse
      ? existing.redirectIndex + 1
      : 0;
    const request = params.request as Record<string, any>;
    const requestId = storageId(cdpRequestId, redirectIndex);
    const captured: PendingRequest = {
      recordingId,
      requestId,
      cdpRequestId,
      tabId,
      sessionId: sessionStorageId(sessionId),
      targetType: targetTypes.get(targetKey(tabId, sessionId)) ?? (sessionId ? 'unknown' : 'page'),
      redirectIndex,
      entry: createHarEntry({
        requestId,
        tabId,
        sessionId: sessionStorageId(sessionId),
        targetType: targetTypes.get(targetKey(tabId, sessionId)) ?? (sessionId ? 'unknown' : 'page'),
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
    enqueue(requestExtraInfoTargets, entryKey, captured);
    await applyQueuedExtraInfo(
      entryKey,
      requestExtraInfoTargets,
      requestExtraInfoEvents,
      applyRequestExtraInfo,
    );
    await persist(recordingId, captured);
    const requestBodyTask = fetchRequestBody(
      tabId,
      sessionId,
      cdpRequestId,
      captured,
      recordingId,
    );
    trackBodyTask(requestBodyTask, recordingId, captured);
    return;
  }

  if (method === 'Network.requestWillBeSentExtraInfo') {
    enqueue(requestExtraInfoEvents, entryKey, params);
    await applyQueuedExtraInfo(
      entryKey,
      requestExtraInfoTargets,
      requestExtraInfoEvents,
      applyRequestExtraInfo,
    );
    return;
  }

  if (method === 'Network.responseReceivedExtraInfo') {
    enqueue(responseExtraInfoEvents, entryKey, params);
    await applyQueuedExtraInfo(
      entryKey,
      responseExtraInfoTargets,
      responseExtraInfoEvents,
      applyResponseExtraInfo,
    );
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
    if (params.hasExtraInfo) {
      enqueue(responseExtraInfoTargets, entryKey, request);
      await applyQueuedExtraInfo(
        entryKey,
        responseExtraInfoTargets,
        responseExtraInfoEvents,
        applyResponseExtraInfo,
      );
    }
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
    const task = fetchResponseBody(tabId, sessionId, cdpRequestId, request, recordingId);
    trackBodyTask(task, recordingId, request);
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
