import assert from 'node:assert/strict';
import test from 'node:test';
import { readJimengSessionId } from '../src/providers/jimeng/credential.ts';
import {
  ACCOUNT_INFO_PATH,
  decodeImageXResult,
  decodeJimengResponse,
} from '../src/providers/jimeng/api/controllers/response.ts';

test('normalizes the Passport account response at the transport boundary', () => {
  const account = { user_id: 'fixture' };
  for (const data of [
    account,
    { ret: 0, data: account },
    { message: 'success', data: account },
    { message: 'success', data: { user_info: { user_id_str: 'fixture' } } },
  ]) {
    assert.deepEqual(decodeJimengResponse({ status: 200, data }, ACCOUNT_INFO_PATH), account);
  }
  const data = { message: 'error', data: account };
  assert.equal(decodeJimengResponse({ status: 200, data }, ACCOUNT_INFO_PATH), undefined);
});

test('extracts the session from direct values and copied Cookie headers', () => {
  for (const input of ['fixture', 'Cookie: SessionID = fixture; a=b', 'a=b\nsessionid_ss=fixture']) {
    assert.equal(readJimengSessionId(input), 'fixture');
  }
  assert.equal(readJimengSessionId('opaque%2Fvalue'), 'opaque%2Fvalue');
  assert.equal(readJimengSessionId('sessionid=opaque%2Fvalue'), 'opaque%2Fvalue');
  assert.equal(readJimengSessionId('sid_guard=fixture%7C123'), 'fixture');
  assert.equal(readJimengSessionId('a=b'), undefined);
  assert.equal(readJimengSessionId('sessionid=x%3By'), undefined);
});

test('keeps data fields outside Passport and rejects unsuccessful HTTP responses', () => {
  const path = '/mweb/v1/get_common_config';
  const data = { data: { model_list: [] } };
  assert.equal(decodeJimengResponse({ status: 200, data }, path), data);
  assert.throws(() => decodeJimengResponse({ status: 503, data }, path), { httpStatusCode: 503 });
  assert.throws(
    () => decodeJimengResponse({ status: 401, data: { user_id: 'fixture' } }, ACCOUNT_INFO_PATH),
    { httpStatusCode: 401 },
  );
});

test('reads ImageX Result and rejects errors sent with a successful HTTP status', () => {
  const result = { Results: [{ Uri: 'fixture-image-uri' }] };
  assert.equal(decodeImageXResult({ status: 200, data: { Result: result } }), result);
  assert.throws(
    () => decodeImageXResult({ status: 200, data: { ResponseMetadata: { Error: { Code: 'fixture-error' } } } }),
    /ImageX 上传接口未返回有效结果/,
  );
});
