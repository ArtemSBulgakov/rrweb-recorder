import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';

function escapeNonAscii(source: string): string {
  return [...source].map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) return character;
    if (codePoint <= 0xffff) return `\\u${codePoint.toString(16).padStart(4, '0')}`;
    const value = codePoint - 0x10000;
    const high = 0xd800 + (value >> 10);
    const low = 0xdc00 + (value & 0x3ff);
    return `\\u${high.toString(16)}\\u${low.toString(16)}`;
  }).join('');
}

const entries = {
  background: resolve('src/background/index.ts'),
  content: resolve('src/content/index.ts'),
  recorder: resolve('src/injected/recorder.ts'),
  popup: resolve('src/popup/index.html'),
  library: resolve('src/library/index.html'),
  player: resolve('src/player/index.html'),
};

export default defineConfig(({ mode }) => {
  if (mode === 'playwright') {
    return {
      build: {
        outDir: 'dist/playwright',
        emptyOutDir: true,
        lib: {
          entry: resolve('src/playwright/index.ts'),
          formats: ['iife'],
          name: 'RrwebPlaywrightRecorder',
          fileName: () => 'recorder.js',
        },
        rollupOptions: {
          output: { inlineDynamicImports: true },
        },
      },
      plugins: [{
        name: 'ascii-playwright-recorder',
        async closeBundle() {
          const recorderPath = resolve('dist/playwright/recorder.js');
          await writeFile(recorderPath, escapeNonAscii(await readFile(recorderPath, 'utf8')), 'ascii');
        },
      }],
    };
  }
  const browser = mode === 'firefox' ? 'firefox' : 'chromium';
  return {
    build: {
      outDir: `dist/${browser}`,
      emptyOutDir: true,
      rollupOptions: {
        input: entries,
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
    plugins: [{
      name: 'copy-extension-static',
      async closeBundle() {
        const out = resolve(`dist/${browser}`);
        await mkdir(out, { recursive: true });
        const recorderPath = resolve(out, 'assets/recorder.js');
        await writeFile(recorderPath, escapeNonAscii(await readFile(recorderPath, 'utf8')), 'ascii');
        await cp(resolve(`manifests/${browser}.json`), resolve(out, 'manifest.json'));
        await cp(resolve('public'), out, { recursive: true });
      },
    }],
  };
});
