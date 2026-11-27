// Run from native/ with the reviewed jimeng-api source path as the only argument.
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const source = resolve(process.argv[2], 'src');
const output = resolve('dist/jimeng-capture.mjs');
const controllers = resolve(source, 'api/controllers');
await build({
  stdin: {
    contents: ['images', 'models', 'videos', 'video-scenario', 'video-recast', 'video-size', 'image-size']
      .map(
        (file) =>
          `export * as ${file.replaceAll('-', '_')} from ${JSON.stringify(controllers + '/' + file + '.ts')};`,
      )
      .join('\n'),
    resolveDir: source,
  },
  outfile: output,
  bundle: true,
  external: ['axios'],
  platform: 'node',
  format: 'esm',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  alias: { '@': source },
  plugins: [
    {
      name: 'isolated-jimeng-capture',
      setup(build) {
        build.onLoad({ filter: /video-recast\.ts$/ }, async (args) => ({
          contents: (await readFile(args.path, 'utf8')) + '\nexport { prepareVideoRecast };\n',
          loader: 'ts',
        }));
        build.onResolve({ filter: /(?:database|logger|browser-transport|account-pool)\.ts$/ }, (args) => ({
          path: args.path.split('/').at(-1),
          namespace: 'capture',
        }));
        build.onLoad({ filter: /.*/, namespace: 'capture' }, (args) => {
          const contents = {
            'database.ts': `export const getSetting=()=>null,setSetting=()=>{},getVideoTask=()=>{},
            getVideoTaskBinding=()=>{},failVideoSubmission=()=>{},observeVideoTaskProgress=()=>{},
            reserveVideoTask=()=>{},updateVideoSubmission=()=>{},touchApiKey=()=>{}; export default {}`,
            'account-pool.ts': 'export const getEnabledAccountSessionId=()=>{}; export default {}',
            'logger.ts': 'export default new Proxy({}, {get:()=>()=>{}})',
            'browser-transport.ts': 'export default {enabled:false}',
          }[args.path];
          return { contents };
        });
      },
    },
  ],
});
process.env.GATEWAY_TEST_UPSTREAM = '1';
process.env.GATEWAY_CAPTURE_JIMENG = '1';
const { jimengCaptures } = await import('./upstream-fixture.mjs');
const jimeng = await import(pathToFileURL(output).href);
const cookie = 'test-jimeng-token';

try {
  const capture = {};
  const captureCall = async (prompt, run) => {
    await run();
    capture[prompt] = jimengCaptures.at(-1);
  };
  await captureCall('fixture image', () =>
    jimeng.images.generateImagesWithRetry(
      'jimeng-image-5.0-lite',
      'fixture image',
      { n: 1, size: jimeng.image_size.openAIImageSize('1536x1024') },
      cookie,
    ),
  );
  await captureCall('fixture edit', () =>
    jimeng.images.generateImagesWithRetry(
      'jimeng-image-5.0-lite',
      'fixture edit',
      { n: 1, filePaths: ['data:image/png;base64,iVBORw0KGgo='] },
      cookie,
    ),
  );
  const video = await jimeng.models.resolveVideoModelConfig('jimeng-video-seedance-2.0', cookie);
  const dimensions = jimeng.video_size.videoSizeSpec('720x1280');
  await captureCall('fixture lost submission', () =>
    jimeng.videos.submitVideoGeneration(
      video,
      'fixture lost submission',
      { ...dimensions, duration: 5 },
      cookie,
      '11111111-1111-4111-8111-111111111111',
    ),
  );
  const recast = await jimeng.video_recast.prepareVideoRecast(
    cookie,
    '11111111-1111-1111-1111-111111111111',
    'fixture recast',
    {
      upstreamModel: 'dreamina_seedance_45_pro_recast',
      configScene: 'marketing_viral_recreate',
      mode: 'object_swap',
      resolution: '480p',
      sourceDurationMs: 5000,
      commerceAmount: 10,
      generateType: 110,
    },
  );
  await captureCall('fixture recast', () =>
    jimeng.video_scenario.submitScenarioVideo(cookie, '11111111-1111-4111-8111-111111111111', recast),
  );
  process.stdout.write(JSON.stringify(capture, null, 2) + '\n');
} finally {
  await unlink(output);
}
