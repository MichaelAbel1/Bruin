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
  build: {
    outDir: path.resolve(here, 'build/renderer'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'markdown',
              test: /[\\/]node_modules[\\/](react-markdown|remark-|rehype-|mdast-|micromark|unist-|unified|hast-|vfile|property-information|comma-separated-tokens|space-separated-tokens|html-url-attributes|devlop|decode-named-character-reference|character-entities)/,
            },
            {
              name: 'icons',
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
}));
