import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const pandocWasmAsAsset = {
  name: 'pandoc-wasm-as-asset',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.includes('/pandoc-wasm/') || !id.endsWith('/src/index.browser.js')) return undefined;
    return code.replace('import("./pandoc.wasm")', 'import("./pandoc.wasm?url")');
  },
};

export default defineConfig(({ command }) => {
  const timestamp = new Date().toISOString();
  let commit = process.env.GITHUB_SHA?.trim().slice(0, 7);
  if (!commit) {
    try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { /* Source archives can be built without Git metadata. */ }
  }
  const build = { date: command === 'serve' ? 'dev' : timestamp.slice(0, 10), timestamp, ...(commit ? { commit } : {}) };
  return {
    define: { __MARKROOT_BUILD__: JSON.stringify(build) },
    plugins: [pandocWasmAsAsset, react(), {
      name: 'markroot-build-meta',
      transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'markroot-build', content: [build.date, build.timestamp, commit].filter(Boolean).join(' · ') }, injectTo: 'head' as const }],
    }],
    base: './',
    assetsInclude: ['**/*.wasm'],
    build: { target: 'es2022', assetsInlineLimit: 0 },
    worker: { format: 'es' },
  };
});
