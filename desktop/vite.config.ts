import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  root: path.resolve(here, 'renderer'),
  base: './',
  plugins: [
    {
      name: 'bruin-prod-csp',
      transformIndexHtml(html) {
        return command === 'build'
          ? html.replace(
              "connect-src 'self' http://localhost:5173 ws://localhost:5173",
              "connect-src 'self'",
            )
          : html;
      },
    },
  ],
  build: { outDir: path.resolve(here, 'build/renderer'), emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
