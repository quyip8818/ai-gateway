import assert from 'node:assert/strict';
import axios from 'axios';
import { expectedTextProviders, normalizeTextContract } from './text-provider-contract.mjs';
import { jimengSubmission, expectedJimengSubmissions } from './jimeng-contract.mjs';
import { appendFileSync } from 'node:fs';
import { crc32 } from '../../../dist/providers/kiro/kiro/event-stream.js';

const originalFetch = globalThis.fetch;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const renderedPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ikAAAAASUVORK5CYII=', 'base64');
export const jimengCaptures = [];
let imageCreditRecord;
let imageCreditLookups = 0;
const recastSource = '11111111-1111-1111-1111-111111111111';
const video = Buffer.from('00000014667479706d70343200000000', 'hex');

export function packet(name, data, messageType) {
  const encode = (key, value) => {
    const label = Buffer.from(key),
      text = Buffer.from(value);
    return Buffer.concat([Buffer.from([label.length]), label, Buffer.from([7, 0, text.length]), text]);
  };
  const header = Buffer.concat([
    encode(':event-type', name),
    ...(messageType ? [encode(':message-type', messageType)] : []),
  ]);
  const payload = Buffer.from(JSON.stringify(data));
  const frame = Buffer.alloc(16 + header.length + payload.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(header.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  header.copy(frame, 12);
  payload.copy(frame, 12 + header.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

if (process.env.GATEWAY_TEST_UPSTREAM === '1') {
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    assert.notEqual(headers.get('authorization')?.slice(7, 10), 'ag_');
    if (url.hostname === 'api.anthropic.com') {
      assert.equal(headers.get('x-api-key'), 'test-claude-token');
      if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-fixture' }] });
      if (url.pathname.endsWith('/count_tokens')) return Response.json({ input_tokens: 3 });
      if (init.body?.includes('fixture cancellation')) {
        let marked = false;
        const cancel = () => {
          if (marked) return;
          marked = true;
          appendFileSync(process.env.GATEWAY_TEST_CANCELLATION, 'cancelled');
        };
        return new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                'abort',
                () => {
                  cancel();
                  controller.error(init.signal.reason);
                },
                { once: true },
              );
              controller.enqueue(new TextEncoder().encode('data: {"type":"message_start"}\n\n'));
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        id: 'msg_fixture',
        content: [{ type: 'text', text: 'fixture' }],
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    }
    if (url.hostname === 'api.openai.com') {
      assert.equal(headers.get('authorization'), 'Bearer test-openai-token');
      if (url.pathname === '/v1/models') return Response.json({ data: [{ id: 'gpt-api-fixture' }] });
      assert.equal(url.pathname, '/v1/responses');
      assert.equal(JSON.parse(init.body).model, 'gpt-api-fixture');
      return Response.json({ id: 'resp_api_fixture', status: 'completed', output: [] });
    }
    if (url.hostname === 'auth.openai.com') {
      assert.equal(url.pathname, '/oauth/token');
      const body = new URLSearchParams(
        headers.get('content-type')?.includes('application/json') ? JSON.parse(init.body) : init.body,
      );
      if (body.get('grant_type') === 'refresh_token') {
        assert.equal(body.get('refresh_token'), 'fixture-refresh');
        appendFileSync(process.env.GATEWAY_TEST_REFRESHES, 'codex\n');
      } else {
        assert.equal(body.get('grant_type'), 'authorization_code');
        assert.equal(body.get('code'), 'test-codex-code');
        assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{43,128}$/);
      }
      const claims = Buffer.from(
        JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } }),
      ).toString('base64url');
      return Response.json({
        access_token: 'fixture.' + claims + '.signature',
        refresh_token: 'fixture-refresh',
        expires_in: 3600,
      });
    }
    if (url.hostname === 'chatgpt.com') {
      assert.match(headers.get('authorization'), /^Bearer (test-codex-token|fixture\.[^.]+\.signature)$/);
      if (url.pathname.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-fixture' }] });
      if (url.pathname.endsWith('/responses')) {
        const body = JSON.parse(init.body);
        assert.equal(body.model, 'gpt-fixture');
        assert.equal(body.stream, true);
        if (body.tools?.length) {
          assert.deepEqual({ origin: url.origin, path: url.pathname, body }, expectedTextProviders().codex);
          const completed = {
            type: 'response.completed',
            response: {
              id: 'resp_tools',
              status: 'completed',
              output: [{ type: 'function_call', name: 'lookup', call_id: 'call_1', arguments: '{"id":7}' }],
              usage: { input_tokens: 4 },
            },
          };
          return new Response('data: ' + JSON.stringify(completed) + '\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"fixture"}\n\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":4}}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
    }
    if (url.hostname === 'prod.us-east-1.auth.desktop.kiro.dev') {
      assert.equal(url.pathname, '/refreshToken');
      assert.equal(JSON.parse(init.body).refreshToken, 'test-kiro-refresh');
      appendFileSync(process.env.GATEWAY_TEST_REFRESHES, 'desktop\n');
      return Response.json({ accessToken: 'test-kiro-token', expiresIn: 3600 });
    }
    if (url.hostname === 'oidc.us-east-1.amazonaws.com') {
      assert.equal(url.pathname, '/token');
      assert.deepEqual(JSON.parse(init.body), {
        grantType: 'refresh_token',
        refreshToken: 'test-oidc-refresh',
        clientId: 'fixture-client',
        clientSecret: 'fixture-secret',
      });
      return Response.json({ accessToken: 'test-oidc-token', expiresIn: 3600 });
    }
    if (url.hostname === 'runtime.us-east-1.kiro.dev') {
      assert.match(headers.get('authorization'), /^Bearer test-(kiro|oidc)-token$/);
      if (headers.get('authorization') === 'Bearer test-oidc-token')
        assert.equal(headers.get('tokentype'), 'SSO_OIDC');
      if (url.pathname === '/List-Available-Models')
        return Response.json({ models: [{ modelId: 'claude-sonnet-4.5' }] });
      assert.equal(url.pathname, '/generateAssistantResponse');
      if (init.body.includes('fixture Kiro tool')) {
        assert.deepEqual(normalizeTextContract(JSON.parse(init.body)), expectedTextProviders().kiro);
        const frames = Buffer.concat([
          packet('toolUseEvent', { toolUseId: 'tool_1', name: 'lookup', input: '{"id":' }),
          packet('toolUseEvent', { toolUseId: 'tool_1', name: 'lookup', input: '7}', stop: true }),
          packet('metadataEvent', { stopReason: 'tool_use' }),
        ]);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(frames.subarray(0, 13));
              controller.enqueue(frames.subarray(13));
              controller.close();
            },
          }),
        );
      }
      if (init.body.includes('fixture Kiro exception'))
        return new Response(packet('validationException', { message: 'fixture' }, 'exception'));
      if (init.body.includes('fixture Kiro truncated'))
        return new Response(packet('assistantResponseEvent', { content: 'unfinished' }));
      return new Response(
        Buffer.concat([
          packet('assistantResponseEvent', { content: 'fixture' }),
          packet('metadataEvent', { stopReason: 'end_turn' }),
        ]),
      );
    }
    throw new Error('Unexpected outbound host: ' + url.hostname);
  };

  axios.defaults.adapter = async (config) => {
    const url = new URL(config.url);
    let data;
    if (url.hostname === 'cdn.fixture.test') data = url.pathname === '/video' ? video : renderedPng;
    else if (url.hostname === 'imagex.bytedanceapi.com') {
      if (url.searchParams.get('Action') === 'ApplyImageUpload') {
        data = {
          Result: {
            UploadAddress: {
              UploadHosts: ['upload.fixture.test'],
              StoreInfos: [{ StoreUri: 'image', Auth: 'fixture' }],
              SessionKey: 'fixture',
            },
          },
        };
      } else data = { Result: { Results: [{ Uri: 'fixture-image-uri' }] } };
    } else if (url.hostname === 'upload.fixture.test') {
      assert.ok(Buffer.from(config.data).equals(png));
      data = { code: 2000 };
    } else {
      assert.equal(url.hostname, 'jimeng.jianying.com');
      assert.match(config.headers.get('Cookie'), /sessionid=test-jimeng-(?:token|replacement)(?:;|$)/);
      let result;
      if (url.pathname === '/passport/account/info/v2/') result = { user_id: 'fixture' };
      else if (url.pathname.endsWith('/get_common_config')) {
        result = config.data?.includes('marketing_viral_recreate')
          ? {
              model_list: [
                {
                  model_req_key: 'dreamina_seedance_45_pro_recast',
                  commercial_config: {
                    resolution_price_configs: [
                      { resolution: '480p', price: { benefit_type: 'fixture', resource_id: 'fixture' } },
                    ],
                  },
                },
              ],
            }
          : {};
      } else if (url.pathname.endsWith('/get_upload_token'))
        result = { access_key_id: 'fixture', secret_access_key: 'fixture', session_token: 'fixture' };
      else if (url.pathname.endsWith('/user_credit'))
        result = { credit: { gift_credit: 100, purchase_credit: 0, vip_credit: 0 } };
      else if (url.pathname.endsWith('/user_credit_history')) {
        assert.deepEqual(JSON.parse(config.data), { cursor: '0', count: 20, history_type: 2, need_with_hold: false });
        process.stdout.write('[fixture jimeng ledger request]\n');
        if (++imageCreditLookups === 3) {
          return { data: {}, status: 503, statusText: 'Unavailable', headers: {}, config };
        }
        result = { records: [
          { submit_id: 'another-task', history_type: 2, status: 'Checked', amount: -99 },
          ...(imageCreditRecord?.status === 'Checked'
            ? [{ ...imageCreditRecord, status: 'Init', amount: 8 }] : []),
          ...(imageCreditRecord ? [imageCreditRecord] : []),
        ], has_more: true };
      } else if (url.pathname.endsWith('/aigc_draft/generate')) {
        const submission = JSON.parse(config.data);
        const id = submission.submit_id;
        const contract = jimengSubmission(config);
        jimengCaptures.push(contract);
        if (!process.env.GATEWAY_CAPTURE_JIMENG) {
          const expected = expectedJimengSubmissions();
          const prompt = Object.keys(expected).find((value) => config.data.includes(value));
          assert.ok(prompt, 'Jimeng fixture has no source baseline for this prompt');
          try {
            assert.deepEqual(contract, expected[prompt]);
          } catch (error) {
            process.stderr.write(`Jimeng source mismatch for ${prompt}: ${error.message}\n`);
            throw error;
          }
        }
        assert.ok(id);
        if (config.data.includes('fixture recast')) {
          const draft = JSON.parse(submission.draft_content);
          assert.equal(draft.component_list[0].abilities.scenario.scene, 'object_swap');
        }
        if (config.data.includes('fixture edit')) assert.match(config.data, /fixture-image-uri/);
        if (config.data.includes('fixture image') || config.data.includes('fixture edit')) {
          imageCreditRecord = {
            submit_id: id, history_type: 2, status: config.data.includes('fixture image') ? 'Checked' : 'Init',
            amount: '-6', sub_histories: [{ actual_credit_amount: 6 }],
          };
        }
        if (!process.env.GATEWAY_CAPTURE_JIMENG && config.data.includes('fixture lost submission')) {
          appendFileSync(process.env.GATEWAY_TEST_SUBMISSIONS, id + '\n');
          throw Object.assign(new Error('fixture upstream received the request'), { code: 'ECONNRESET' });
        }
        result = { aigc_data: { history_record_id: id } };
      } else if (url.pathname.endsWith('/get_history_by_ids')) {
        const q = JSON.parse(config.data);
        const id = (q.history_ids ?? q.submit_ids)[0];
        result = {
          [id]: {
            status: 50,
            item_list: q.image_info
              ? [{ image: { large_images: [{ image_url: 'https://cdn.fixture.test/image' }] } }]
              : [{
                video: {
                  transcoded_video: { origin: { video_url: 'https://cdn.fixture.test/video', width: 704, height: 1252 } },
                  width: 640, height: 1138, duration_ms: 5017,
                },
              }],
          },
        };
        if (id === recastSource) {
          result[id].workspace_id = 1;
          result[id].draft_content = JSON.stringify({
            main_component_id: 'source',
            component_list: [
              {
                id: 'source',
                generate_type: 'scenario_tool_gen_video',
                abilities: {
                  scenario: {
                    scene: 'object_swap',
                    params: { model_req_key: 'dreamina_seedance_45_pro_recast' },
                    material_list: [
                      {
                        material_type: 'video',
                        video_info: {
                          source_from: 'upload',
                          vid: 'fixture',
                          duration: 5000,
                          width: 854,
                          height: 480,
                        },
                      },
                      { material_type: 'image', image_info: { source_from: 'upload', image_uri: 'image' } },
                    ],
                  },
                },
              },
            ],
          });
        }
      } else throw new Error('Unexpected Jimeng endpoint: ' + url.pathname);
      data = { ret: '0', data: result };
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
}
