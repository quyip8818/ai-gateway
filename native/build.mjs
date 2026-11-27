import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: ['src/server.ts', 'src/providers/index.ts', 'src/providers/kiro/kiro/event-stream.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  alias: { '@': resolve('src/providers/jimeng') },
  loader: { '.sql': 'text' },
  sourcemap: true,
});

await build({
  entryPoints: ['src/console.tsx'],
  outfile: 'console.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
