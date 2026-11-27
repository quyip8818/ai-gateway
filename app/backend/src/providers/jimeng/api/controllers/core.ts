import { setTimeout as wait } from "node:timers/promises";
import { createHash } from "node:crypto";
import { jimengSignal, jimengTransportMode } from "../../context.ts";
import _ from "lodash";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import browserTransport from "@/lib/browser-transport.ts";
import { startupBrowserTransportMode } from "../../settings.ts";
import { ACCOUNT_INFO_PATH, decodeImageXResult, decodeJimengResponse } from "./response.ts";

// 默认的AgentID
const DEFAULT_ASSISTANT_ID = 513695;
// 版本号
const VERSION_CODE = "5.8.0";
// 平台代码
const PLATFORM_CODE = "7";
// WebID
const WEB_ID = Math.random() * 1e18 + 7e18;
// 用户ID
const USER_ID = util.uuid(false);
// 伪装headers
const FAKE_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-language": "zh-CN,zh;q=0.9",
  "Cache-control": "no-cache",
  Appid: `${DEFAULT_ASSISTANT_ID}`,
  Appvr: VERSION_CODE,
  Origin: "https://jimeng.jianying.com",
  Pragma: "no-cache",
  Priority: "u=1, i",
  Referer: "https://jimeng.jianying.com",
  Pf: PLATFORM_CODE,
  "Sec-Ch-Ua":
    '"Google Chrome";v="142", "Chromium";v="142", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
};

export function generateCookie(refreshToken: string) {
  return [
    `_tea_web_id=${WEB_ID}`,
    `is_staff_user=false`,
    `store-region=cn-gd`,
    `store-region-src=uid`,
    `sid_guard=${refreshToken}%7C${util.unixTimestamp()}%7C5184000%7CMon%2C+03-Feb-2025+08%3A17%3A09+GMT`,
    `uid_tt=${USER_ID}`,
    `uid_tt_ss=${USER_ID}`,
    `sid_tt=${refreshToken}`,
    `sessionid=${refreshToken}`,
    `sessionid_ss=${refreshToken}`,
    `sid_tt=${refreshToken}`
  ].join("; ");
}

/**
 * 获取积分信息
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function getCredit(refreshToken: string, signal?: AbortSignal) {
  const {
    credit: { gift_credit, purchase_credit, vip_credit }
  } = await request("POST", "/commerce/v1/benefits/user_credit", refreshToken, {
    data: {},
    signal,
    headers: {
      Referer: "https://jimeng.jianying.com/ai-tool/image/generate",
    }
  });
  logger.info(`\n积分信息: \n赠送积分: ${gift_credit}, 购买积分: ${purchase_credit}, VIP积分: ${vip_credit}`);
  return {
    giftCredit: gift_credit,
    purchaseCredit: purchase_credit,
    vipCredit: vip_credit,
    totalCredit: gift_credit + purchase_credit + vip_credit
  }
}

/**
 * 接收今日积分
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
export async function receiveCredit(refreshToken: string) {
  logger.info("正在收取今日积分...")
  const { cur_total_credits, receive_quota } = await request("POST", "/commerce/v1/benefits/credit_receive", refreshToken, {
    data: {
      time_zone: "Asia/Shanghai"
    },
    headers: {
      Referer: "https://jimeng.jianying.com/ai-tool/image/generate"
    }
  });
  logger.info(`\n今日${receive_quota}积分收取成功\n剩余积分: ${cur_total_credits}`);
  return cur_total_credits;
}

/**
 * 将cookie字符串拆分为键值对
 *
 * @param cookie cookie字符串
 */
function parseCookiePairs(cookie: string): Array<[string, string]> {
  return cookie
    .split("; ")
    .filter(Boolean)
    .map((item) => {
      const index = item.indexOf("=");
      if (index < 0) return [item, ""] as [string, string];
      return [item.slice(0, index), item.slice(index + 1)] as [string, string];
    });
}

/**
 * 生成风控缓存键
 *
 * 风控按模型链路判定，而图片与视频共用 /mweb/v1/aigc_draft/generate 这一个路径，
 * 因此缓存键必须带上请求体里的 root_model，避免视频触发的风控把图片请求也带进浏览器。
 *
 * @param uri 请求路径
 * @param data 请求体
 */
function getRiskControlKey(uri: string, data: any) {
  let rootModel = "";
  try {
    const payload = typeof data === "string" ? JSON.parse(data) : data;
    rootModel = payload?.extend?.root_model || "";
  } catch {
    // 请求体解析失败时退化为按路径缓存
  }
  return rootModel ? `${uri}#${rootModel}` : uri;
}

/**
 * 请求jimeng
 *
 * @param method 请求方法
 * @param uri 请求路径
 * @param params 请求参数
 * @param headers 请求头
 */
export async function request(
  method: string,
  uri: string,
  refreshToken: string,
  options: AxiosRequestConfig = {},
  policy: { retry?: boolean; logPayload?: boolean; model?: string; browserFallback?: boolean } = {}
) {
  const signal = jimengSignal(options.signal as AbortSignal | undefined);
  signal?.throwIfAborted();
  const deviceTime = util.unixTimestamp();
  const sign = util.md5(
    `9e2c|${uri.slice(-7)}|${PLATFORM_CODE}|${VERSION_CODE}|${deviceTime}||11ac`
  );

  const fullUrl = `https://jimeng.jianying.com${uri}`;
  const requestParams = {
    aid: DEFAULT_ASSISTANT_ID,
    device_platform: "web",
    region: "CN",
    webId: WEB_ID,
    ...options.params,
  };

  const cookie = generateCookie(refreshToken);
  const headers = {
    ...FAKE_HEADERS,
    Cookie: cookie,
    "Device-Time": deviceTime,
    Sign: sign,
    "Sign-Ver": "1",
    ...options.headers,
  };

  logger.info(`发送请求: ${method.toUpperCase()} ${fullUrl}`);
  const logPayload = policy.logPayload !== false;
  if (logPayload) {
    logger.info(`请求参数: ${JSON.stringify(requestParams)}`);
    logger.info(`请求数据: ${JSON.stringify(options.data || {})}`);
  }

  const mode = jimengTransportMode() ?? startupBrowserTransportMode;
  const canUseBrowser = mode !== "off";
  const riskControlKey = policy.model ? `${uri}#${policy.model}` : getRiskControlKey(uri, options.data);
  const session = canUseBrowser ? createHash("sha256").update(refreshToken).digest("hex") : "";
  const useBrowser = canUseBrowser && (mode === "always" || browserTransport.isRequired(session, riskControlKey));
  const browserRequest = {
    method, url: fullUrl, params: requestParams, headers, data: options.data,
    session, signal, cookiePairs: parseCookiePairs(cookie),
    timeout: options.timeout || undefined,
    retry: policy.retry,
  };
  const readResult = (response: AxiosResponse) => {
    if (policy.retry === false && (response.status >= 500 || response.status === 408)) {
      throw new Error(`上游 HTTP ${response.status}，请求结果尚未确认`);
    }
    return decodeJimengResponse(response, uri);
  };

  // 添加重试逻辑
  let retries = 0;
  const maxRetries = policy.retry === false ? 0 : 3;
  let lastError = null;

  while (retries <= maxRetries) {
    try {
      if (retries > 0) {
        logger.info(`第 ${retries} 次重试请求: ${method.toUpperCase()} ${fullUrl}`);
        // 重试前等待一段时间
        await wait(1000 * retries, undefined, { signal });
      }

      const response = useBrowser
        ? await browserTransport.request(browserRequest)
        : await axios.request({
            method,
            url: fullUrl,
            params: requestParams,
            headers: headers,
            timeout: 45000, // 增加超时时间到45秒
            validateStatus: () => true, // 允许任何状态码
            ..._.omit(options, "params", "headers"),
            signal,
            maxRedirects: 0,
          });

      // 记录响应状态和头信息
      logger.info(`响应状态: ${response.status} ${response.statusText}`);

      // 记录响应数据摘要
      if (logPayload) {
        const data = JSON.stringify(response.data) ?? '';
        logger.info(`响应数据摘要: ${data.substring(0, 500)}${data.length > 500 ? "..." : ""}`);
      }

      // 检查HTTP状态码
      if (response.status >= 400) {
        logger.warn(`HTTP错误: ${response.status} ${response.statusText}`);
        if (retries < maxRetries) {
          retries++;
          continue;
        }
      }

      try {
        return readResult(response);
      } catch (error) {
        // 上游风控拒绝：该接口需要浏览器端签名，改用浏览器传输重试一次
        const riskControl =
          error instanceof APIException && error.compare(EX.API_RISK_CONTROL_REJECTED);
        if (!riskControl || !canUseBrowser || useBrowser || mode !== "auto" || policy.browserFallback === false)
          throw error;
        logger.warn(
          `模型链路 ${riskControlKey} 被上游风控拦截，改用浏览器传输重试；也可设置 JIMENG_BROWSER_TRANSPORT=always 直接走浏览器`
        );
        try {
          const browserResponse = await browserTransport.request(browserRequest);
          logger.info(`响应状态: ${browserResponse.status} ${browserResponse.statusText}`);
          if (logPayload) {
            const data = JSON.stringify(browserResponse.data) ?? '';
            logger.info(`响应数据摘要: ${data.substring(0, 500)}${data.length > 500 ? "..." : ""}`);
          }
          // 传输确实可用才记住该模型链路，避免把不可用的浏览器传输固化下来
          const result = readResult(browserResponse);
          browserTransport.markRequired(session, riskControlKey);
          return result;
        } catch (browserError) {
          // 浏览器传输抛出业务错误时透传；基础设施错误（缺依赖、浏览器启动失败等）保留原始风控错误
          if (browserError instanceof APIException || policy.retry === false) throw browserError;
          logger.error(`浏览器传输不可用，保留原始风控错误: ${browserError.message}`);
          throw error;
        }
      }
    }
    catch (error) {
      signal?.throwIfAborted();
      lastError = error;
      logger.error(`请求失败 (尝试 ${retries + 1}/${maxRetries + 1}): ${error.message}`);

      // 如果是网络错误或超时，尝试重试
      if ((error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
        error.message.includes('timeout') || error.message.includes('network')) &&
        retries < maxRetries) {
        retries++;
        continue;
      }

      // 其他错误直接抛出
      break;
    }
  }

  // 所有重试都失败了，抛出最后一个错误
  logger.error(`请求失败，已重试 ${retries} 次: ${lastError.message}`);
  if (lastError.response) {
    logger.error(`响应状态: ${lastError.response.status}`);
    if (logPayload) logger.error(`响应数据: ${JSON.stringify(lastError.response.data)}`);
  }
  throw lastError;
}

export async function uploadFile(
  refreshToken: string,
  reference: string,
): Promise<{ image_uri: string; uri: string }> {
  const signal = jimengSignal();
  signal?.throwIfAborted();
  // The HTTP boundary resolves remote references and validates the image before upload.
  const match = /^data:image\/(?:jpeg|png|webp);base64,/.exec(reference);
  if (!match) throw new APIException(EX.API_REQUEST_PARAMS_INVALID, "Expected a validated image data URL");
  const fileData = Buffer.from(reference.slice(match[0].length), "base64");

  const uploadAuth = await request(
    'POST',
    '/mweb/v1/get_upload_token?aid=513695&da_version=3.2.2&aigc_features=app_lip_sync',
    refreshToken,
    { data: { scene: 2 } }
  );
  if (!uploadAuth?.access_key_id) {
    throw new APIException(EX.API_REQUEST_FAILED, '即梦未返回图片上传凭证');
  }

  logger.info('获取上传令牌成功');

  // 计算文件CRC32 - 注意：需要转换为无符号整数再转十六进制
  // crc-32 包返回有符号整数，需要 >>> 0 转换为无符号
  const crc32Value = util.crc32(fileData);
  const imageCrc32 = (crc32Value >>> 0).toString(16);
  logger.info(`文件CRC32: ${imageCrc32}`);

  // 准备获取上传凭证的请求参数
  const getUploadImageProofRequestParams = {
    Action: 'ApplyImageUpload',
    FileSize: fileData.length,
    ServiceId: 'tb4s082cfz',
    Version: '2018-08-01',
    s: util.generateRandomString({ length: 11, charset: 'alphanumeric' }),
  };

  // 生成AWS签名请求头
  const requestHeadersInfo = await generateAWSAuthorizationHeader(
    uploadAuth.access_key_id,
    uploadAuth.secret_access_key,
    uploadAuth.session_token,
    'cn-north-1',
    'imagex',
    'GET',
    getUploadImageProofRequestParams,
  );

  // 获取图片上传凭证
  const uploadImgRes = await axios.get(
    'https://imagex.bytedanceapi.com/?' + new URLSearchParams(getUploadImageProofRequestParams as any).toString(),
    { headers: requestHeadersInfo, timeout: 30000, signal, maxRedirects: 0 }
  );

  const { UploadAddress } = decodeImageXResult(uploadImgRes);
  const host = UploadAddress?.UploadHosts?.[0];
  const store = UploadAddress?.StoreInfos?.[0];
  if (!host || !store?.StoreUri || !store.Auth || !UploadAddress?.SessionKey) {
    throw new APIException(EX.API_REQUEST_FAILED, 'ImageX 未返回完整的上传地址和凭证');
  }
  const uploadImgUrl = `https://${host}/upload/v1/${store.StoreUri}`;

  logger.info(`上传图片到: ${uploadImgUrl}`);

  // 上传图片
  const imageUploadRes = await axios.post(
    uploadImgUrl,
    fileData,
    {
      headers: {
        Authorization: store.Auth,
        'Content-Crc32': imageCrc32,
        'Content-Type': 'application/octet-stream',
      },
      timeout: 60000, signal, maxRedirects: 0,
    }
  );

  if (imageUploadRes.data.code !== 2000) {
    throw new APIException(EX.API_REQUEST_FAILED, imageUploadRes.data.message || '上传文件失败');
  }

  logger.info('图片上传成功，提交上传');

  // 提交上传
  const commitImgParams = {
    Action: 'CommitImageUpload',
    FileSize: fileData.length,
    ServiceId: 'tb4s082cfz',
    Version: '2018-08-01',
  };

  const commitImgContent = {
    SessionKey: UploadAddress.SessionKey,
  };

  const commitImgHead = await generateAWSAuthorizationHeader(
    uploadAuth.access_key_id,
    uploadAuth.secret_access_key,
    uploadAuth.session_token,
    'cn-north-1',
    'imagex',
    'POST',
    commitImgParams,
    commitImgContent,
  );

  const commitImg = await axios.post(
    'https://imagex.bytedanceapi.com/?' + new URLSearchParams(commitImgParams as any).toString(),
    commitImgContent,
    {
      headers: {
        ...commitImgHead,
        'Content-Type': 'application/json',
      },
      timeout: 30000, signal, maxRedirects: 0,
    }
  );

  const imageUri = decodeImageXResult(commitImg).Results?.[0]?.Uri;
  if (typeof imageUri !== 'string' || !imageUri) {
    throw new APIException(EX.API_REQUEST_FAILED, 'ImageX 未返回已上传的文件 URI');
  }
  logger.info(`文件上传成功，URI: ${imageUri}`);

  return {
    image_uri: imageUri,
    uri: imageUri,
  };
}

/**
 * 生成AWS授权请求头
 */
async function generateAWSAuthorizationHeader(
  accessKeyID: string,
  secretAccessKey: string,
  sessionToken: string,
  region: string,
  service: string,
  requestMethod: string,
  requestParams: any,
  requestBody: any = {},
): Promise<Record<string, string>> {
  const crypto = await import('crypto');

  // 获取当前ISO时间
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const amzDay = amzDate.substring(0, 8);

  // 构建请求头
  const requestHeaders: Record<string, string> = {
    'X-Amz-Date': amzDate,
    'X-Amz-Security-Token': sessionToken,
  };

  if (Object.keys(requestBody).length > 0) {
    requestHeaders['X-Amz-Content-Sha256'] = crypto
      .createHash('sha256')
      .update(JSON.stringify(requestBody))
      .digest('hex');
  }

  // 生成签名
  const credentialString = `${amzDay}/${region}/${service}/aws4_request`;

  const signedHeaders = Object.keys(requestHeaders)
    .map(k => k.toLowerCase())
    .sort()
    .join(';');

  const canonicalHeaders = Object.keys(requestHeaders)
    .sort()
    .map(k => `${k.toLowerCase()}:${requestHeaders[k]}`)
    .join('\n') + '\n';

  const bodyHash = Object.keys(requestBody).length > 0
    ? crypto.createHash('sha256').update(JSON.stringify(requestBody)).digest('hex')
    : crypto.createHash('sha256').update('').digest('hex');

  const canonicalRequest = [
    requestMethod.toUpperCase(),
    '/',
    new URLSearchParams(requestParams).toString(),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialString,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  // 生成签名密钥
  const kDate = crypto.createHmac('sha256', 'AWS4' + secretAccessKey).update(amzDay).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const signingKey = crypto.createHmac('sha256', kService).update('aws4_request').digest();

  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyID}/${credentialString}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...requestHeaders,
    'Authorization': authorization,
  };
}

/**
 * 获取Token存活状态
 */
export async function getTokenLiveStatus(refreshToken: string) {
  const account = await request(
    "POST",
    ACCOUNT_INFO_PATH,
    refreshToken,
    {
      params: {
        account_sdk_source: "web",
      },
    }
  );
  return Boolean(account?.user_id);
}
