import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const backend = 'app/backend/src';
await Promise.all([
  build({
    entryPoints: [
      `${backend}/server.ts`,
      `${backend}/providers/registry.ts`,
      `${backend}/providers/kiro/kiro/event-stream.ts`,
    ],
    outdir: 'dist',
    outbase: backend,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    alias: { '@': resolve(backend, 'providers/jimeng') },
    loader: { '.sql': 'text' },
    sourcemap: true,
  }),
  build({
    entryPoints: ['app/frontend/src/main.tsx'],
    outfile: 'dist/frontend/console.js',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
  mkdir('dist/frontend', { recursive: true }).then(() =>
    copyFile('app/frontend/index.html', 'dist/frontend/index.html'),
  ),
]);
