# rrweb Recorder

Локальная запись и воспроизведение браузерных сессий на базе
[rrweb](https://github.com/rrweb-io/rrweb).

Поддерживаются:

- Chromium и Firefox как браузерное расширение;
- Playwright через отдельный инъекционный bundle;
- несколько вкладок;
- DOM, клики, ввод, прокрутка, изменения страницы и console events;
- сетевые запросы;
- экспорт и импорт `.rrweb.zip`;
- просмотр timeline и экспорт сетевого трафика в PCAP.

Все данные хранятся локально в браузере. Значения полей ввода маскируются.

## Установка

```bash
pnpm install
```

## Браузерное расширение

### Сборка

```bash
# Chromium и Firefox
pnpm build

# Только Chromium
pnpm build:chromium

# Только Firefox
pnpm build:firefox
```

Результат:

```text
dist/chromium/
dist/firefox/
```

### Chromium

1. Откройте `chrome://extensions`.
2. Включите **Developer mode**.
3. Нажмите **Load unpacked**.
4. Выберите каталог `dist/chromium`.
5. Откройте HTTP(S)-страницу.
6. Нажмите на иконку расширения и затем **Play**.

Открытые текущей страницей вкладки автоматически добавляются в запись.
Кнопка **Stop** завершает сессию.

### Firefox

1. Откройте `about:debugging#/runtime/this-firefox`.
2. Нажмите **Load Temporary Add-on**.
3. Выберите `dist/firefox/manifest.json`.
4. Запустите запись через popup расширения.

### Параметры записи

- **Console** — сохранять `log`, `info`, `warn`, `error`, `debug`.
- **Network** — сохранять сетевые события rrweb.
- **Deep network capture** — Chromium-only захват через DevTools Protocol,
  включая request/response bodies.
- **Sequential IDs** — добавлять последовательные идентификаторы событий.

Deep network capture подключает debugger к вкладке и отключает browser cache.

### Просмотр и экспорт

Нажмите **Library** в popup расширения.

Для каждой записи доступны:

- **Play** — воспроизведение;
- **Rename** — переименование;
- **Export ZIP** — экспорт в `.rrweb.zip`;
- **Delete** — удаление.

Player показывает DOM replay, console events и network timeline. Экспортированный
ZIP содержит JSON следующего вида:

```json
{
  "recording": {},
  "events": [],
  "network": []
}
```

Player также принимает обычный JSON-массив rrweb events.

## Playwright

### Сборка bundle

```bash
pnpm build:playwright
```

Создаётся файл:

```text
dist/playwright/recorder.js
```

Bundle запускает `rrweb.record()` в странице и складывает события в:

```js
window.__rrwebPlaywrightEvents
```

Остановить recorder можно так:

```js
window.__rrwebPlaywrightStop?.();
```

### TypeScript

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const recorderSource = await readFile(
  'dist/playwright/recorder.js',
  'utf8',
);

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://example.com');
await page.evaluate((source) => {
  (0, eval)(source);
}, recorderSource);

await page.mouse.move(200, 200);
await page.mouse.wheel(0, 500);

const events = await page.evaluate(() => {
  window.__rrwebPlaywrightStop?.();
  return window.__rrwebPlaywrightEvents ?? [];
});

await writeFile('recording.rrweb.json', JSON.stringify(events));
await browser.close();
```

### Python

```python
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright


async def main() -> None:
    source = Path("dist/playwright/recorder.js").read_text()

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto("https://example.com")
        await page.evaluate(
            "(source) => { (0, eval)(source); }",
            source,
        )

        await page.mouse.move(200, 200)
        await page.mouse.wheel(0, 500)

        events = await page.evaluate(
            """() => {
                window.__rrwebPlaywrightStop?.();
                return window.__rrwebPlaywrightEvents ?? [];
            }"""
        )

        Path("recording.rrweb.json").write_text(json.dumps(events))
        await browser.close()


asyncio.run(main())
```

### Навигация и несколько страниц

События находятся в JavaScript-контексте текущего документа. Перед навигацией,
перезагрузкой или закрытием страницы их нужно забрать через `page.evaluate()`.
После навигации bundle нужно инъецировать заново.

Для длительных сессий рекомендуется периодически забирать новые события:

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

Для каждой новой `Page` храните отдельные `events`, `offset` и `tabId`.
Отслеживать popup-вкладки можно через событие контекста:

```ts
context.on('page', async (page) => {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate((source) => {
    (0, eval)(source);
  }, recorderSource);
});
```

### Network capture с Playwright

Playwright bundle записывает DOM и console events. Полный сетевой поток следует
собирать средствами Playwright:

```ts
const network = [];

context.on('request', (request) => {
  network.push({
    timestamp: Date.now(),
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    requestHeaders: request.headers(),
    requestBody: request.postData(),
  });
});

context.on('response', async (response) => {
  const entry = [...network].reverse().find(
    (item) => item.url === response.url() && item.status === undefined,
  );
  if (!entry) return;

  entry.status = response.status();
  entry.responseHeaders = await response.allHeaders();
  entry.responseBody = await response.text().catch(() => undefined);
});
```

Перед сохранением удаляйте или маскируйте чувствительные заголовки:

- `authorization`;
- `cookie`;
- `set-cookie`;
- `proxy-authorization`.

Каждый request должен завершиться response либо явно сохранённой ошибкой
`requestfailed`. Перед закрытием контекста дождитесь завершения активных
response body tasks.

### Проверка записи

Наличие только `Meta`, `FullSnapshot` и `ViewportResize` events недостаточно.
Рабочая пользовательская запись должна содержать incremental events (`type: 3`)
с mouse interaction, input, scroll или DOM mutations.

Минимальная проверка:

```ts
const incremental = events.filter((event) => event.type === 3);

if (events.length < 10 || incremental.length < 4) {
  throw new Error('rrweb recording does not contain enough activity');
}
```

## Тесты

```bash
pnpm test
```

Watch mode:

```bash
pnpm test:watch
```

## Упаковка расширений

```bash
pnpm package
```
