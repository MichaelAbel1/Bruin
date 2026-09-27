import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(here, 'renderer'),
  base: './',
  build: { outDir: path.resolve(here, 'build/renderer'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
