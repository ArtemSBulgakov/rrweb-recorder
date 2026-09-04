import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'dist/chromium');
const chromePath = '/usr/bin/google-chrome-stable';

const TEST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>HAR capture probe</title></head>
<body>
<h1>HAR capture probe</h1>
<button id="run">Run requests</button>
<pre id="out"></pre>
<script>
async function run() {
  const out = document.querySelector('#out');
  const lines = [];
  const log = (m) => { lines.push(m); out.textContent = lines.join('\\n'); };
  const echo = await fetch('/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-probe': '1' },
    body: JSON.stringify({ hello: 'har', n: 42 }),
  });
  log('POST /api/echo ' + echo.status + ' ' + await echo.text());
  const hello = await fetch('/api/hello');
  log('GET /api/hello ' + hello.status + ' ' + await hello.text());
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = '/pixel.png?' + Date.now();
  });
  log('IMG /pixel.png ok');
}
document.querySelector('#run').onclick = () => void run();
window.__runProbe = run;
</script>
</body></html>`;

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/echo' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
          res.end(JSON.stringify({ ok: true, received: body }));
        });
        return;
      }
      if (url.pathname === '/api/hello') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'hello-from-server' }));
        return;
      }
      if (url.pathname === '/pixel.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PIXEL_PNG);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(TEST_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      resolve({ server, port: address.port });
    });
  });
}

async function waitForExtensionId(browser) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const target = (await browser.targets()).find(
      (item) => item.type() === 'service_worker' && item.url().startsWith('chrome-extension://'),
    );
    if (target) return new URL(target.url()).host;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Extension service worker not found');
}

async function readIdb(page) {
  return page.evaluate(async () => {
    const openDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('rrweb-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const all = (store) => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await openDb();
    try {
      const recordings = await all(db.transaction('recordings').objectStore('recordings'));
      const events = await all(db.transaction('events').objectStore('events'));
      const network = await all(db.transaction('network').objectStore('network'));
      return { recordings, events, network };
    } finally {
      db.close();
    }
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { server, port } = await startServer();
const baseUrl = `http://127.0.0.1:${port}/`;
let browser;
const failures = [];

try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    pipe: true,
    enableExtensions: [extensionPath],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const extensionId = await waitForExtensionId(browser);
  console.log('extensionId', extensionId);
  console.log('probe', baseUrl);

  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  const probeTabId = page.target()._targetId;

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await popup.waitForSelector('#deep-network');
  const deepEnabled = await popup.$eval('#deep-network', (el) => !el.disabled);
  assert(deepEnabled, 'Deep network checkbox should be enabled in Chromium');

  const startResult = await popup.evaluate(async (probeUrl) => {
    const tabs = await chrome.tabs.query({});
    const probe = tabs.find((tab) => tab.url?.startsWith(probeUrl));
    if (!probe?.id) return { ok: false, error: 'probe tab not found', tabs: tabs.map((t) => t.url) };
    await chrome.tabs.update(probe.id, { active: true });
    await chrome.windows.update(probe.windowId, { focused: true });
    try {
      const state = await chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        options: {
          recordConsole: true,
          recordNetwork: true,
          sequentialId: true,
          captureAllNetworkBodies: true,
        },
      });
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }, baseUrl);

  console.log('startResult', JSON.stringify(startResult, null, 2));
  assert(startResult.ok, `Failed to start recording: ${startResult.error}`);
  assert(startResult.state?.active, 'Recording state is not active');
  console.log('recording started');
  void probeTabId;

  // Ensure debugger sees traffic after attach.
  await page.bringToFront();
  await popup.evaluate(async (probeUrl) => {
    const tabs = await chrome.tabs.query({});
    const probe = tabs.find((tab) => tab.url?.startsWith(probeUrl));
    if (probe?.id) {
      await chrome.tabs.update(probe.id, { active: true });
      await chrome.tabs.reload(probe.id, { bypassCache: true });
    }
  }, baseUrl);
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
  await page.waitForSelector('#run');
  await page.evaluate(() => window.__runProbe());
  await page.waitForFunction(
    () => (document.querySelector('#out')?.textContent ?? '').includes('IMG /pixel.png ok'),
    { timeout: 10_000 },
  );
  console.log('probe requests finished');
  await new Promise((r) => setTimeout(r, 1500));

  const stopResult = await popup.evaluate(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      return { ok: true, state };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });
  console.log('stopResult', JSON.stringify(stopResult, null, 2));
  assert(stopResult.ok && !stopResult.state?.active, 'Failed to stop recording');
  console.log('recording stopped');
  await new Promise((r) => setTimeout(r, 500));

  const library = await browser.newPage();
  await library.goto(`chrome-extension://${extensionId}/src/library/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  const data = await readIdb(library);

  console.log(JSON.stringify({
    recordings: data.recordings.length,
    events: data.events.length,
    harEntries: data.network.length,
  }, null, 2));

  assert(data.recordings.length >= 1, 'Expected at least one recording');
  assert(data.events.length > 0, 'Expected rrweb events');
  assert(data.network.length > 0, 'Expected HAR entries from debugger');

  const entries = data.network.map((item) => item.entry);
  const urls = entries.map((entry) => entry.request.url);
  console.log('har urls sample:', urls.slice(0, 20));

  const echo = entries.find((entry) => entry.request.url.includes('/api/echo') && entry.request.method === 'POST');
  const hello = entries.find((entry) => entry.request.url.includes('/api/hello'));
  const pixel = entries.find((entry) => entry.request.url.includes('/pixel.png'));

  assert(echo, 'Missing POST /api/echo in HAR');
  assert(hello, 'Missing GET /api/hello in HAR');
  assert(pixel, 'Missing /pixel.png in HAR');

  assert(echo.request.postData?.text?.includes('"hello":"har"'), `Echo request body missing: ${echo.request.postData?.text}`);
  assert(
    echo.response.content.text?.includes('hello') || echo.response.content.text?.includes('received'),
    `Echo response body missing: ${echo.response.content.text}`,
  );
  assert(echo.response.status === 200, `Echo status ${echo.response.status}`);
  assert(Array.isArray(echo.request.headers) && echo.request.headers.length > 0, 'Echo request headers empty');
  assert(Array.isArray(echo.response.headers) && echo.response.headers.length > 0, 'Echo response headers empty');
  assert(typeof echo.time === 'number' && echo.time >= 0, `Bad echo timing: ${echo.time}`);
  assert(echo.timings && typeof echo.timings.wait === 'number', 'Echo timings missing');

  assert(hello.response.content.text?.includes('hello-from-server'), `Hello body: ${hello.response.content.text}`);
  assert(hello.response.status === 200, `Hello status ${hello.response.status}`);

  const networkPluginEvents = data.events.filter((item) =>
    item.event?.data?.plugin === 'rrweb/network@1',
  );
  assert(networkPluginEvents.length > 0, 'Expected rrweb network plugin events without relying on HAR');

  assert(entries.every((entry) => entry.startedDateTime && entry.request?.url && entry.timings), 'HAR entries incomplete');
  console.log('OK: debugger HAR has bodies/headers/timings; rrweb still has network plugin events');
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  console.error(failures.join('\n'));
}
