import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'dist/chromium');
const chromePath = '/usr/bin/google-chrome-stable';
const SITE = 'https://example.com/';
const API = 'https://jsonplaceholder.typicode.com';

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
      return {
        recordings: await all(db.transaction('recordings').objectStore('recordings')),
        events: await all(db.transaction('events').objectStore('events')),
        network: await all(db.transaction('network').objectStore('network')),
      };
    } finally {
      db.close();
    }
  });
}

function summarizeEntry(entry) {
  const reqBody = entry.request.postData?.text;
  const resBody = entry.response.content?.text;
  return {
    method: entry.request.method,
    url: entry.request.url,
    status: entry.response.status,
    timeMs: Math.round(entry.time),
    timings: entry.timings,
    reqHeaders: entry.request.headers?.length ?? 0,
    resHeaders: entry.response.headers?.length ?? 0,
    reqBodyBytes: reqBody ? reqBody.length : 0,
    resBodyBytes: resBody ? resBody.length : 0,
    resBodyPreview: resBody ? resBody.slice(0, 120).replace(/\s+/g, ' ') : null,
    encoding: entry.response.content?.encoding,
    type: entry._resourceType,
  };
}

let browser;
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

  const page = await browser.newPage();
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log('opened', SITE);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/src/popup/index.html`, {
    waitUntil: 'domcontentloaded',
  });

  const startResult = await popup.evaluate(async (probeUrl) => {
    const tabs = await chrome.tabs.query({});
    const probe = tabs.find((tab) => tab.url?.startsWith(probeUrl));
    if (!probe?.id) return { ok: false, error: 'site tab not found', tabs: tabs.map((t) => t.url) };
    await chrome.tabs.update(probe.id, { active: true });
    await chrome.windows.update(probe.windowId, { focused: true });
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
  }, SITE);
  console.log('start', startResult.state?.activeRecordingId);
  assert(startResult.ok && startResult.state?.active, `start failed: ${JSON.stringify(startResult)}`);

  await page.bringToFront();
  await popup.evaluate(async (probeUrl) => {
    const tabs = await chrome.tabs.query({});
    const probe = tabs.find((tab) => tab.url?.startsWith(probeUrl));
    if (probe?.id) await chrome.tabs.reload(probe.id, { bypassCache: true });
  }, SITE);
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30_000 });
  console.log('reloaded under debugger');

  const probe = await page.evaluate(async (api) => {
    const getRes = await fetch(`${api}/posts/1`);
    const getText = await getRes.text();
    const postRes = await fetch(`${api}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-rrweb-probe': 'site-check' },
      body: JSON.stringify({ title: 'rrweb-har-check', body: 'from-real-site', userId: 7 }),
    });
    const postText = await postRes.text();
    return {
      getStatus: getRes.status,
      getText,
      postStatus: postRes.status,
      postText,
      title: document.title,
      htmlLength: document.documentElement.outerHTML.length,
    };
  }, API);
  console.log('page probe', {
    getStatus: probe.getStatus,
    postStatus: probe.postStatus,
    title: probe.title,
    getPreview: probe.getText.slice(0, 80),
    postPreview: probe.postText.slice(0, 80),
  });
  assert(probe.getStatus === 200, `GET status ${probe.getStatus}`);
  assert(probe.postStatus === 201 || probe.postStatus === 200, `POST status ${probe.postStatus}`);

  // Give CDP time to flush getResponseBody / getRequestPostData.
  await new Promise((r) => setTimeout(r, 2500));

  const stopResult = await popup.evaluate(async () => {
    const state = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    return state;
  });
  assert(!stopResult.active, 'still active after stop');
  await new Promise((r) => setTimeout(r, 800));

  const library = await browser.newPage();
  await library.goto(`chrome-extension://${extensionId}/src/library/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  const data = await readIdb(library);
  const entries = data.network.map((item) => item.entry);
  const summaries = entries.map(summarizeEntry);

  console.log(JSON.stringify({
    recordings: data.recordings.length,
    events: data.events.length,
    harEntries: entries.length,
    rrwebNetworkPluginEvents: data.events.filter((e) => e.event?.data?.plugin === 'rrweb/network@1').length,
  }, null, 2));
  console.log('HAR summary:');
  for (const row of summaries) console.log(JSON.stringify(row));

  assert(data.recordings.length >= 1, 'no recording');
  assert(data.events.length > 0, 'no rrweb events');
  assert(entries.length >= 3, `too few HAR entries: ${entries.length}`);

  const doc = entries.find((e) => e.request.url.startsWith(SITE) && e.request.method === 'GET' && (e._resourceType === 'Document' || e.response.content?.mimeType?.includes('html')));
  const getPost = entries.find((e) => e.request.url.includes('/posts/1') && e.request.method === 'GET');
  const createPost = entries.find((e) => e.request.url.replace(/\/$/, '').endsWith('/posts') && e.request.method === 'POST');

  assert(doc, 'missing example.com document in HAR');
  assert(getPost, 'missing GET /posts/1 in HAR');
  assert(createPost, 'missing POST /posts in HAR');

  assert((doc.response.content?.text?.length ?? 0) > 50, `document body missing/short: ${doc.response.content?.text?.length}`);
  assert(doc.response.content.text.toLowerCase().includes('example'), `document body unexpected: ${doc.response.content.text.slice(0, 200)}`);
  assert((doc.request.headers?.length ?? 0) > 0, 'document request headers empty');
  assert((doc.response.headers?.length ?? 0) > 0, 'document response headers empty');
  assert(typeof doc.time === 'number' && doc.time >= 0, `document time bad: ${doc.time}`);
  assert(doc.timings && typeof doc.timings.receive === 'number', 'document timings missing');

  assert(getPost.response.content?.text?.includes('"userId"'), `GET body missing: ${getPost.response.content?.text?.slice(0, 200)}`);
  assert(getPost.response.status === 200, `GET har status ${getPost.response.status}`);
  assert((getPost.response.headers?.length ?? 0) > 0, 'GET response headers empty');
  assert(getPost.timings && getPost.time >= 0, 'GET timings missing');

  assert(createPost.request.postData?.text?.includes('rrweb-har-check'), `POST req body missing: ${createPost.request.postData?.text}`);
  assert(createPost.request.postData.text.includes('from-real-site'), 'POST req body incomplete');
  assert(
    createPost.request.headers.some((h) => h.name.toLowerCase() === 'content-type' && h.value.includes('application/json')),
    'POST content-type header missing',
  );
  assert(
    createPost.request.headers.some((h) => h.name.toLowerCase() === 'x-rrweb-probe' && h.value === 'site-check')
      || createPost.request.headers.some((h) => h.name.toLowerCase() === 'X-Rrweb-Probe'.toLowerCase()),
    `custom request header missing: ${JSON.stringify(createPost.request.headers)}`,
  );
  assert(createPost.response.content?.text?.includes('rrweb-har-check') || createPost.response.content?.text?.includes('"id"'), `POST response body missing: ${createPost.response.content?.text}`);
  assert(createPost.response.status === 201 || createPost.response.status === 200, `POST har status ${createPost.response.status}`);
  assert(createPost.timings && createPost.time >= 0, 'POST timings missing');

  const withBodies = entries.filter((e) => (e.response.content?.text?.length ?? 0) > 0).length;
  const withTimings = entries.filter((e) => e.timings && typeof e.time === 'number').length;
  console.log(JSON.stringify({ withBodies, withTimings, total: entries.length }, null, 2));
  assert(withBodies >= 3, `expected >=3 bodies, got ${withBodies}`);
  assert(withTimings === entries.length, 'not all entries have timings');

  console.log('OK: real-site HAR capture stores document/API request+response bodies, headers, timings');
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
