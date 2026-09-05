import { record } from 'rrweb';
import { getRecordConsolePlugin } from '@rrweb/rrweb-plugin-console-record';
import { getRecordSequentialIdPlugin } from '@rrweb/rrweb-plugin-sequential-id-record';
import type { eventWithTime } from '@rrweb/types';

declare global {
  interface Window {
    __rrwebPlaywrightStop?: () => void;
    __rrwebPlaywrightEvents?: eventWithTime[];
  }
}

function startRecorder(): void {
  if (window.__rrwebPlaywrightStop) return;
  window.__rrwebPlaywrightEvents ??= [];
  window.__rrwebPlaywrightStop = record({
    emit(event) {
      window.__rrwebPlaywrightEvents?.push(event);
    },
    recordCanvas: true,
    collectFonts: true,
    maskAllInputs: false,
    sampling: {
      mousemove: 50,
      mouseInteraction: true,
      scroll: 100,
      input: 'last',
    },
    plugins: [
      getRecordSequentialIdPlugin(),
      getRecordConsolePlugin({
        level: ['log', 'info', 'warn', 'error', 'debug'],
        lengthThreshold: 2_000,
        stringifyOptions: {
          stringLengthLimit: 4_096,
          numOfKeysLimit: 100,
          depthOfLimit: 4,
        },
      }),
    ],
  }) ?? undefined;
}

startRecorder();
