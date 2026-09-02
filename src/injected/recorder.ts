import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { getRecordNetworkPlugin } from '@rrweb/rrweb-plugin-network-record';
import { getRecordSequentialIdPlugin } from '@rrweb/rrweb-plugin-sequential-id-record';
import type { RecorderCommand, RecorderConfig } from '../shared/types';
import type { NetworkInitiatorType } from '@rrweb/types';

const networkInitiatorTypes: NetworkInitiatorType[] = [
  'navigation', 'fetch', 'xmlhttprequest', 'beacon', 'ping',
  'script', 'css', 'link', 'early-hint',
  'image', 'img', 'icon', 'input',
  'audio', 'video', 'track',
  'frame', 'iframe', 'embed', 'object', 'body',
];

type PageRecorderState = {
  initialized: boolean;
  stop?: () => void;
  activeRecordingId?: string;
};

const stateKey = '__rrwebExtensionRecorder';
const pageWindow = window as Window & { [stateKey]?: PageRecorderState };
const pageState = pageWindow[stateKey] ??= { initialized: false };

function redactHeaders(headers: unknown, names: string[]): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const redacted = new Set(names.map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key, redacted.has(key.toLowerCase()) ? '[REDACTED]' : value,
  ]));
}

function start(message: Extract<RecorderCommand, { type: 'RRWEB_START' }>): void {
  if (pageState.activeRecordingId === message.recordingId) return;
  pageState.stop?.();
  pageState.activeRecordingId = message.recordingId;
  const config: RecorderConfig = message.config;
  pageState.stop = record({
    emit(event) {
      window.postMessage({
        type: 'RRWEB_EVENT',
        recordingId: message.recordingId,
        tabId: message.tabId,
        event,
      } satisfies RecorderCommand, '*');
    },
    recordCanvas: false,
    collectFonts: true,
    maskAllInputs: true,
    maskTextSelector: '[data-rrweb-mask]',
    blockSelector: '[data-rrweb-block]',
    plugins: [
      ...(config.sequentialId ? [getRecordSequentialIdPlugin()] : []),
      ...(config.recordConsole ? [getRecordConsolePlugin({
        level: ['log', 'info', 'warn', 'error', 'debug'],
        lengthThreshold: 2_000,
        stringifyOptions: { stringLengthLimit: 4_096, numOfKeysLimit: 100, depthOfLimit: 4 },
      })] : []),
      ...(config.recordNetwork ? [getRecordNetworkPlugin({
        initiatorTypes: networkInitiatorTypes,
        recordHeaders: true,
        recordBody: { request: true, response: true },
        recordInitialRequests: true,
        transformRequestFn(request) {
          request.requestHeaders = redactHeaders(request.requestHeaders, config.redactHeaders) as typeof request.requestHeaders;
          request.responseHeaders = redactHeaders(request.responseHeaders, config.redactHeaders) as typeof request.responseHeaders;
          return request;
        },
      })] : []),
    ],
  }) ?? undefined;
}

if (!pageState.initialized) {
  pageState.initialized = true;
  window.addEventListener('message', (event: MessageEvent<RecorderCommand>) => {
    if (event.source !== window) return;
    if (event.data?.type === 'RRWEB_START') start(event.data);
    if (event.data?.type === 'RRWEB_STOP' && event.data.recordingId === pageState.activeRecordingId) {
      pageState.stop?.();
      pageState.stop = undefined;
      pageState.activeRecordingId = undefined;
    }
  });
}

window.postMessage({ type: 'RRWEB_RECORDER_READY' } satisfies RecorderCommand, '*');
