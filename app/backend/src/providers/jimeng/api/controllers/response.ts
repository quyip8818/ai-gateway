import type { AxiosResponse } from 'axios';
import APIException from '../../lib/exceptions/APIException.ts';
import EX from '../consts/exceptions.ts';

// Jimeng redirects the slashless path. Use the canonical URL for account checks.
export const ACCOUNT_INFO_PATH = '/passport/account/info/v2/';

function passportAccount(account: any) {
  if (account?.message === 'error') return undefined;
  for (const profile of [account, account?.user_info, account?.user, account?.account]) {
    for (const id of [profile?.user_id, profile?.user_id_str]) {
      const value = typeof id === 'string' ? id.trim() : typeof id === 'number' && id > 0 && Number.isFinite(id) ? String(id) : '';
      if (value && value !== '0') return { user_id: value };
    }
  }
}

export function decodeJimengResponse(response: AxiosResponse, path: string) {
  const body = response.data;
  const { ret: rawCode, errmsg, data } = body ?? {};
  const ret =
    typeof rawCode === 'number' || (typeof rawCode === 'string' && rawCode.trim()) ? Number(rawCode) : NaN;

  if (ret === 5000 || ret === 1006) {
    throw new APIException(EX.API_IMAGE_GENERATION_INSUFFICIENT_POINTS, `[积分不足]: ${errmsg} (错误码: ${ret})`, response.status);
  }
  if (ret === 4013 || ret === 1019) {
    throw new APIException(EX.API_RISK_CONTROL_REJECTED, `[风控拦截]: ${errmsg} (错误码: ${ret})`, response.status);
  }
  if (Number.isFinite(ret) && ret !== 0) {
    throw new APIException(EX.API_REQUEST_FAILED, `[请求失败]: ${errmsg} (错误码: ${ret})`, response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new APIException(EX.API_REQUEST_FAILED, `即梦上游返回 HTTP ${response.status}`, response.status);
  }
  if (path === ACCOUNT_INFO_PATH) {
    if (body?.message === 'error') return undefined;
    return passportAccount(ret === 0 ? data : data ?? body);
  }
  if (ret === 0) return data;
  return body;
}

export function decodeImageXResult(response: AxiosResponse) {
  const body = response.data;
  if (response.status < 200 || response.status >= 300 || body?.ResponseMetadata?.Error || !body?.Result) {
    throw new APIException(EX.API_REQUEST_FAILED, 'ImageX 上传接口未返回有效结果');
  }
  return body.Result;
}
