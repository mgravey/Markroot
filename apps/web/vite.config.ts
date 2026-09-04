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

export default defineConfig({
  plugins: [pandocWasmAsAsset, react()],
  base: './',
  assetsInclude: ['**/*.wasm'],
  build: { target: 'es2022', assetsInlineLimit: 0 },
  worker: { format: 'es' },
});
