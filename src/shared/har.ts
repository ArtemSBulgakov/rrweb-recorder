export type NetworkResourceTiming = {
  requestTime: number;
  proxyStart: number;
  proxyEnd: number;
  dnsStart: number;
  dnsEnd: number;
  connectStart: number;
  connectEnd: number;
  sslStart: number;
  sslEnd: number;
  workerStart: number;
  workerReady: number;
  sendStart: number;
  sendEnd: number;
  receiveHeadersStart?: number;
  receiveHeadersEnd: number;
  pushStart: number;
  pushEnd: number;
};

export type NetworkTimings = {
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
  send: number;
  wait: number;
  receive: number;
};

export type HarHeader = { name: string; value: string };
export type HarPostData = { mimeType: string; text: string; params?: unknown[] };
export type HarContent = {
  size: number;
  compression?: number;
  mimeType: string;
  text?: string;
  encoding?: string;
};

export type HarEntry = {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: unknown[];
    headers: HarHeader[];
    queryString: HarHeader[];
    headersSize: number;
    bodySize: number;
    postData?: HarPostData;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: unknown[];
    headers: HarHeader[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    _transferSize?: number;
    _error?: string;
  };
  cache: Record<string, never>;
  timings: NetworkTimings;
  serverIPAddress?: string;
  _resourceType?: string;
  _fromCache?: boolean;
  _requestId?: string;
  _tabId?: number;
};

export type HarLog = {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages: Array<{
      startedDateTime: string;
      id: string;
      title: string;
      pageTimings: { onContentLoad: number; onLoad: number };
    }>;
    entries: HarEntry[];
  };
};

export type StoredHarEntry = {
  recordingId: string;
  requestId: string;
  tabId: number;
  entry: HarEntry;
};

function firstNonNegative(values: number[]): number {
  for (const value of values) {
    if (value >= 0) return value;
  }
  return -1;
}

export function timingsFromResourceTiming(
  timing: NetworkResourceTiming | undefined,
  requestTime?: number,
  responseTime?: number,
  finishedTime?: number,
): NetworkTimings {
  const round = (value: number): number => (value < 0 ? -1 : Math.round(value * 1000) / 1000);

  if (!timing) {
    const wait = requestTime !== undefined && responseTime !== undefined
      ? Math.max(0, (responseTime - requestTime) * 1000)
      : -1;
    const receive = responseTime !== undefined && finishedTime !== undefined
      ? Math.max(0, (finishedTime - responseTime) * 1000)
      : -1;
    return {
      blocked: -1,
      dns: -1,
      connect: -1,
      ssl: -1,
      send: 0,
      wait: round(wait),
      receive: round(receive),
    };
  }

  const delta = (start: number, end: number): number =>
    start >= 0 && end >= 0 ? Math.max(0, end - start) : -1;

  const blocked = firstNonNegative([timing.dnsStart, timing.connectStart, timing.sendStart]);
  const receiveHeadersEnd = timing.receiveHeadersEnd >= 0
    ? timing.receiveHeadersEnd
    : timing.receiveHeadersStart ?? -1;
  const wait = timing.sendEnd >= 0 && receiveHeadersEnd >= 0
    ? Math.max(0, receiveHeadersEnd - timing.sendEnd)
    : -1;
  const receive = responseTime !== undefined && finishedTime !== undefined
    ? Math.max(0, (finishedTime - responseTime) * 1000)
    : 0;

  return {
    blocked: round(blocked),
    dns: round(delta(timing.dnsStart, timing.dnsEnd)),
    connect: round(delta(timing.connectStart, timing.connectEnd)),
    ssl: round(delta(timing.sslStart, timing.sslEnd)),
    send: round(delta(timing.sendStart, timing.sendEnd)),
    wait: round(wait),
    receive: round(receive),
  };
}

export function durationFromTimings(timings: NetworkTimings): number {
  return (['blocked', 'dns', 'connect', 'send', 'wait', 'receive'] as const)
    .map((key) => timings[key])
    .filter((value) => value >= 0)
    .reduce((sum, value) => sum + value, 0);
}

export function headersFromRecord(headers?: Record<string, string>): HarHeader[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

export function headersToRecord(headers: HarHeader[]): Record<string, string> {
  return Object.fromEntries(headers.map((header) => [header.name, header.value]));
}

export function headerValue(headers: HarHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value;
}

export function mergeHarHeaders(existing: HarHeader[], extra?: Record<string, string>): HarHeader[] {
  if (!extra) return existing;
  const merged = headersToRecord(existing);
  for (const [name, value] of Object.entries(extra)) merged[name] = value;
  return headersFromRecord(merged);
}

export function queryStringFromUrl(url: string): HarHeader[] {
  try {
    const parsed = new URL(url);
    return [...parsed.searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

export function bodyByteLength(text?: string, base64 = false): number {
  if (!text) return 0;
  if (base64) {
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
  }
  return new TextEncoder().encode(text).length;
}

export function createHarEntry(input: {
  requestId: string;
  tabId: number;
  wallTimeMs: number;
  url: string;
  method: string;
  type: string;
  headers?: Record<string, string>;
  postData?: string;
}): HarEntry {
  const headers = headersFromRecord(input.headers);
  const bodySize = bodyByteLength(input.postData);
  const postMime = headerValue(headers, 'content-type') || 'application/octet-stream';
  return {
    startedDateTime: new Date(input.wallTimeMs).toISOString(),
    time: 0,
    request: {
      method: input.method || 'GET',
      url: input.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers,
      queryString: queryStringFromUrl(input.url),
      headersSize: -1,
      bodySize,
      ...(input.postData !== undefined
        ? { postData: { mimeType: postMime, text: input.postData } }
        : {}),
    },
    response: {
      status: 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'application/octet-stream' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: -1, receive: -1 },
    _resourceType: input.type,
    _requestId: input.requestId,
    _tabId: input.tabId,
  };
}

export function applyHarTimings(
  entry: HarEntry,
  timing: NetworkResourceTiming | undefined,
  requestTime?: number,
  responseTime?: number,
  finishedTime?: number,
): void {
  entry.timings = timingsFromResourceTiming(timing, requestTime, responseTime, finishedTime);
  entry.time = durationFromTimings(entry.timings);
}

export function setHarRequestBody(entry: HarEntry, text: string): void {
  const mimeType = headerValue(entry.request.headers, 'content-type') || 'application/octet-stream';
  entry.request.postData = { mimeType, text };
  entry.request.bodySize = bodyByteLength(text);
}

export function setHarResponseBody(
  entry: HarEntry,
  body: string | undefined,
  base64Encoded?: boolean,
  encodedDataLength?: number,
): void {
  if (body === undefined) {
    delete entry.response.content.text;
    delete entry.response.content.encoding;
    return;
  }
  const size = bodyByteLength(body, base64Encoded);
  entry.response.content.text = body;
  entry.response.content.size = size;
  if (base64Encoded) entry.response.content.encoding = 'base64';
  else delete entry.response.content.encoding;
  entry.response.bodySize = size;
  if (encodedDataLength !== undefined) {
    entry.response._transferSize = encodedDataLength;
    entry.response.content.compression = Math.max(0, size - encodedDataLength);
  }
}

export function applyHarResponse(
  entry: HarEntry,
  response: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    mimeType?: string;
    protocol?: string;
    remoteIPAddress?: string;
    fromCache?: boolean;
  },
): void {
  if (response.status !== undefined) entry.response.status = response.status;
  if (response.statusText !== undefined) entry.response.statusText = response.statusText;
  if (response.headers) {
    entry.response.headers = mergeHarHeaders(entry.response.headers, response.headers);
  }
  if (response.mimeType) entry.response.content.mimeType = response.mimeType;
  else {
    entry.response.content.mimeType =
      headerValue(entry.response.headers, 'content-type') || entry.response.content.mimeType;
  }
  if (response.protocol) {
    entry.request.httpVersion = response.protocol;
    entry.response.httpVersion = response.protocol;
  }
  if (response.remoteIPAddress) entry.serverIPAddress = response.remoteIPAddress;
  if (response.fromCache !== undefined) entry._fromCache = response.fromCache;
  entry.response.redirectURL = headerValue(entry.response.headers, 'location') || '';
}

export function wrapHarEntries(
  entries: HarEntry[],
  options: {
    title?: string;
    startedAt?: number;
    creatorName?: string;
    creatorVersion?: string;
  } = {},
): HarLog {
  const sorted = [...entries].sort(
    (a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime),
  );
  const startedAt = options.startedAt
    ?? (sorted[0] ? Date.parse(sorted[0].startedDateTime) : Date.now());
  return {
    log: {
      version: '1.2',
      creator: {
        name: options.creatorName ?? 'rrweb-recorder',
        version: options.creatorVersion ?? '0.1.0',
      },
      pages: [{
        startedDateTime: new Date(startedAt).toISOString(),
        id: 'page_1',
        title: options.title ?? 'Recording',
        pageTimings: { onContentLoad: -1, onLoad: -1 },
      }],
      entries: sorted,
    },
  };
}
