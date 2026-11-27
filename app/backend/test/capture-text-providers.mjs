// Run from the repository root with reviewed openai-oauth and kiro-api source paths.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { testTool, normalizeTextContract } from './text-provider-contract.mjs';

const codexPath = resolve(process.argv[2], 'packages/core/src/runtime.ts');
const kiroPath = resolve(process.argv[3], 'src/kiro/payload.ts');
const output = resolve('dist/text-provider-capture.mjs');
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `export {createOpenAIOAuthTransport} from ${JSON.stringify(codexPath)};
    export {buildPayload} from ${JSON.stringify(kiroPath)};`,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
});
globalThis.Bun = { env: {} };
try {
  const { createOpenAIOAuthTransport, buildPayload } = await import(pathToFileURL(output).href);
  let codex;
  const client = createOpenAIOAuthTransport({
    auth: { accessToken: 'fixture', accountId: 'fixture' },
    responsesState: false,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-fixture' }] });
      codex = { origin: url.origin, path: url.pathname, body: JSON.parse(init.body) };
      return new Response(
        'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  await client.request('/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-fixture',
      input: 'hello',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    }),
  });
  const kiro = buildPayload(
    testTool('claude-sonnet-4.5'),
    'claude-sonnet-4.5',
    undefined,
    '606f8278-ac44-4cb4-9fbb-f9f1c60e071b',
  );
  process.stdout.write(JSON.stringify(normalizeTextContract({ codex, kiro }), null, 2) + '\n');
} finally {
  await unlink(output);
}
