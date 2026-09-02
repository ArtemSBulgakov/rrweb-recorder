# rrweb Recorder

Local browser session recording and replay powered by
[rrweb](https://github.com/rrweb-io/rrweb).

Features:

- Chromium and Firefox browser extensions;
- Playwright integration through a standalone injectable bundle;
- multi-tab recording;
- DOM snapshots, clicks, input, scrolling, mutations, and console events;
- network capture;
- `.rrweb.zip` import and export;
- timeline inspection and PCAP export.

All data is stored locally in the browser. Input values are masked.

## Installation

```bash
pnpm install
```

## Browser extension

### Build

```bash
# Chromium and Firefox
pnpm build

# Chromium only
pnpm build:chromium

# Firefox only
pnpm build:firefox
```

Output:

```text
dist/chromium/
dist/firefox/
```

### Chromium

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `dist/chromium`.
5. Open an HTTP(S) page.
6. Open the extension popup and click **Play**.

Tabs opened by a recorded page are added to the session automatically.
Click **Stop** to finish the session.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `dist/firefox/manifest.json`.
4. Start recording from the extension popup.

### Recording options

- **Console** — capture `log`, `info`, `warn`, `error`, and `debug`.
- **Network** — capture rrweb network events.
- **Deep network capture** — Chromium-only DevTools Protocol capture,
  including request and response bodies.
- **Sequential IDs** — add sequential event identifiers.

Deep network capture attaches a debugger to the tab and disables the browser
cache.

### Replay and export

Click **Library** in the extension popup.

Each recording provides:

- **Play** — replay the session;
- **Rename** — rename the recording;
- **Export ZIP** — export a `.rrweb.zip` archive;
- **Delete** — delete the recording.

The player displays the DOM replay, console events, and network timeline.
Exported archives contain JSON with this structure:

```json
{
  "recording": {},
  "events": [],
  "network": []
}
```

The player also accepts a plain JSON array of rrweb events.

## Playwright

### Build the bundle

```bash
pnpm build:playwright
```

This creates:

```text
dist/playwright/recorder.js
```

The bundle starts `rrweb.record()` in the page and stores events in:

```js
window.__rrwebPlaywrightEvents
```

Stop the recorder with:

```js
window.__rrwebPlaywrightStop?.();
```

### TypeScript

This complete example captures the rrweb timeline and network requests in a
format that can be opened directly through **Open rrweb JSON / ZIP**:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  chromium,
  type Page,
  type Request,
  type Response,
} from 'playwright';

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

function redactHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      SENSITIVE_HEADERS.has(name.toLowerCase()) ? '[REDACTED]' : value,
    ]),
  );
}

const recorderSource = await readFile('dist/playwright/recorder.js', 'utf8');
const recordingId = randomUUID();
const startedAt = Date.now();
const events: Array<Record<string, unknown>> = [];
const network: Array<Record<string, unknown>> = [];
const requestEntries = new Map<Request, Record<string, unknown>>();
const responseTasks = new Set<Promise<void>>();
let eventOffset = 0;

async function injectRecorder(page: Page) {
  await page.evaluate(
    (source) => {
      (0, eval)(source);
    },
    recorderSource,
  );
  eventOffset = 0;
}

async function drainEvents(page: Page) {
  const batch = await page.evaluate(
    (offset) => (window.__rrwebPlaywrightEvents ?? []).slice(offset),
    eventOffset,
  );
  eventOffset += batch.length;

  for (const event of batch) {
    events.push({
      recordingId,
      tabId: 1,
      timestamp: event.timestamp,
      event,
    });
  }
}

const browser = await chromium.launch();
const context = await browser.newContext();

context.on('request', (request) => {
  const entry: Record<string, unknown> = {
    requestId: randomUUID(),
    tabId: 1,
    timestamp: Date.now(),
    url: request.url(),
    method: request.method(),
    type: request.resourceType(),
    requestHeaders: redactHeaders(request.headers()),
    requestBody: request.postData(),
  };
  requestEntries.set(request, entry);
  network.push(entry);
});

context.on('response', (response: Response) => {
  const task = (async () => {
    const entry = requestEntries.get(response.request());
    if (!entry) return;

    entry.status = response.status();
    entry.responseHeaders = redactHeaders(await response.allHeaders());

    const body = await response.body().catch(() => undefined);
    if (body) {
      const contentType = String(
        (entry.responseHeaders as Record<string, string>)['content-type'] ?? '',
      );
      if (
        contentType.startsWith('text/') ||
        contentType.includes('json') ||
        contentType.includes('javascript') ||
        contentType.includes('xml')
      ) {
        entry.responseBody = body.toString('utf8');
      } else {
        entry.responseBodyBytes = body.length;
      }
    }
  })();

  responseTasks.add(task);
  void task.finally(() => responseTasks.delete(task));
});

context.on('requestfailed', (request) => {
  const entry = requestEntries.get(request);
  if (entry) entry.failure = request.failure()?.errorText ?? 'request failed';
});

const page = await context.newPage();
await page.goto('https://example.com');
await injectRecorder(page);

await page.mouse.move(200, 200, { steps: 10 });
await page.mouse.wheel(0, 500);
await page.waitForTimeout(500);
await drainEvents(page);

// Drain the current document before every navigation.
await drainEvents(page);
await page.goto('https://example.org');
await injectRecorder(page);

await page.mouse.move(400, 300, { steps: 10 });
await page.mouse.wheel(0, 700);
await page.waitForTimeout(500);
await drainEvents(page);

await page.evaluate(() => window.__rrwebPlaywrightStop?.());
await drainEvents(page);
await Promise.allSettled(responseTasks);

const endedAt = Date.now();
const payload = {
  recording: {
    id: recordingId,
    title: 'Playwright example',
    startedAt,
    endedAt,
    active: false,
    eventCount: events.length,
    tabs: [{
      tabId: 1,
      title: await page.title(),
      url: page.url(),
      startedAt,
      endedAt,
      eventCount: events.length,
    }],
    tabActivity: [{ tabId: 1, timestamp: startedAt }],
  },
  events,
  network,
};

await writeFile(
  'recording.rrweb.json',
  JSON.stringify(payload, null, 2),
);

await context.close();
await browser.close();
```

### Python

Complete async Playwright equivalent:

```python
import asyncio
import base64
import json
import time
import uuid
from pathlib import Path

from playwright.async_api import Page, Request, Response, async_playwright

SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def redact_headers(headers: dict[str, str]) -> dict[str, str]:
    return {
        name: "[REDACTED]" if name.lower() in SENSITIVE_HEADERS else value
        for name, value in headers.items()
    }


async def main() -> None:
    source = Path("dist/playwright/recorder.js").read_text()
    recording_id = str(uuid.uuid4())
    started_at = now_ms()
    events: list[dict] = []
    network: list[dict] = []
    request_entries: dict[Request, dict] = {}
    response_tasks: set[asyncio.Task] = set()
    event_offset = 0

    async def inject_recorder(page: Page) -> None:
        nonlocal event_offset
        await page.evaluate(
            "(source) => { (0, eval)(source); }",
            source,
        )
        event_offset = 0

    async def drain_events(page: Page) -> None:
        nonlocal event_offset
        batch = await page.evaluate(
            """(offset) =>
                (window.__rrwebPlaywrightEvents ?? []).slice(offset)""",
            event_offset,
        )
        event_offset += len(batch)
        events.extend(
            {
                "recordingId": recording_id,
                "tabId": 1,
                "timestamp": event["timestamp"],
                "event": event,
            }
            for event in batch
        )

    def on_request(request: Request) -> None:
        body = request.post_data_buffer
        request_body = None
        request_body_encoded = False

        if body is not None:
            try:
                request_body = body.decode()
            except UnicodeDecodeError:
                request_body = base64.b64encode(body).decode()
                request_body_encoded = True

        entry = {
            "requestId": str(uuid.uuid4()),
            "tabId": 1,
            "timestamp": now_ms(),
            "url": request.url,
            "method": request.method,
            "type": request.resource_type,
            "requestHeaders": redact_headers(request.headers),
            "requestBody": request_body,
            "requestBodyEncoded": request_body_encoded,
        }
        request_entries[request] = entry
        network.append(entry)

    async def capture_response(response: Response) -> None:
        entry = request_entries.get(response.request)
        if entry is None:
            return

        entry["status"] = response.status
        entry["responseHeaders"] = redact_headers(
            await response.all_headers()
        )

        try:
            body = await response.body()
        except Exception as error:
            entry["responseBodyError"] = type(error).__name__
            return

        content_type = entry["responseHeaders"].get("content-type", "")
        if (
            content_type.startswith("text/")
            or "json" in content_type
            or "javascript" in content_type
            or "xml" in content_type
        ):
            entry["responseBody"] = body.decode(errors="replace")
        else:
            entry["responseBodyBytes"] = len(body)

    def on_response(response: Response) -> None:
        task = asyncio.create_task(capture_response(response))
        response_tasks.add(task)
        task.add_done_callback(response_tasks.discard)

    def on_request_failed(request: Request) -> None:
        entry = request_entries.get(request)
        if entry is not None:
            entry["failure"] = request.failure or "request failed"

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context()

        context.on("request", on_request)
        context.on("response", on_response)
        context.on("requestfailed", on_request_failed)

        page = await context.new_page()

        await page.goto("https://example.com")
        await inject_recorder(page)

        await page.mouse.move(200, 200, steps=10)
        await page.mouse.wheel(0, 500)
        await page.wait_for_timeout(500)
        await drain_events(page)

        # Drain events from the current document before navigation.
        await drain_events(page)
        await page.goto("https://example.org")
        await inject_recorder(page)

        await page.mouse.move(400, 300, steps=10)
        await page.mouse.wheel(0, 700)
        await page.wait_for_timeout(500)
        await drain_events(page)

        await page.evaluate("window.__rrwebPlaywrightStop?.()")
        await drain_events(page)

        if response_tasks:
            await asyncio.gather(
                *response_tasks,
                return_exceptions=True,
            )

        ended_at = now_ms()
        payload = {
            "recording": {
                "id": recording_id,
                "title": "Playwright example",
                "startedAt": started_at,
                "endedAt": ended_at,
                "active": False,
                "eventCount": len(events),
                "tabs": [{
                    "tabId": 1,
                    "title": await page.title(),
                    "url": page.url,
                    "startedAt": started_at,
                    "endedAt": ended_at,
                    "eventCount": len(events),
                }],
                "tabActivity": [{
                    "tabId": 1,
                    "timestamp": started_at,
                }],
            },
            "events": events,
            "network": network,
        }

        Path("recording.rrweb.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2)
        )

        await context.close()
        await browser.close()


asyncio.run(main())
```

### Navigation and multiple pages

Events live in the JavaScript context of the current document. Drain them with
`page.evaluate()` before navigation, reload, or page close. Inject the bundle
again after navigation.

For long-running sessions, periodically drain new events:

```ts
let offset = 0;
const events = [];

async function drain(page) {
  const batch = await page.evaluate(
    (from) => (window.__rrwebPlaywrightEvents ?? []).slice(from),
    offset,
  );
  offset += batch.length;
  events.push(...batch);
}
```

Keep separate `events`, `offset`, and `tabId` state for every `Page`. Track
popup tabs through the browser context:

```ts
context.on('page', async (page) => {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate((source) => {
    (0, eval)(source);
  }, recorderSource);
});
```

### Network capture with Playwright

The Playwright bundle captures DOM and console events. The complete examples
above separately capture `request`, `response`, `requestfailed`, headers, and
response bodies through Playwright and store them in the `network` field.

Remove or redact sensitive headers before saving:

- `authorization`;
- `cookie`;
- `set-cookie`;
- `proxy-authorization`.

Every request should end with either a response or an explicitly recorded
`requestfailed` error. Wait for active response body tasks before closing the
browser context.

### Validate a recording

`Meta`, `FullSnapshot`, and `ViewportResize` events alone are not sufficient.
A usable session should contain incremental events (`type: 3`) for mouse
interaction, input, scrolling, or DOM mutations.

Minimal validation:

```ts
const incremental = events.filter((event) => event.type === 3);

if (events.length < 10 || incremental.length < 4) {
  throw new Error('rrweb recording does not contain enough activity');
}
```

## Tests

```bash
pnpm test
```

Watch mode:

```bash
pnpm test:watch
```

## Package the extensions

```bash
pnpm package
```
