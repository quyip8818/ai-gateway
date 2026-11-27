import type { Browser, BrowserContext, Page } from "playwright-core";
import logger from "./logger.ts";


/**
 * 浏览器传输层
 *
 * 即梦对 Seedance 2.0 pro / fast 等部分链路启用了风控中间件（starling），
 * 要求请求携带浏览器端 SDK 生成的 msToken 与 a_bogus 签名，纯服务端请求
 * 会被拒绝（HTTP 200 + ret=4013）。本模块把请求交给真实浏览器页面执行，
 * 由即梦页面自身的 SDK 完成签名，并把浏览器环境下的设备 cookie 一并带上。
 *
 * 该能力依赖 playwright-core 与本机 Chrome/Edge，默认 auto：只在遇到风控拦截时
 * 才启用，未触发风控的请求不受影响。可通过环境变量调整：
 *   JIMENG_BROWSER_TRANSPORT=off      # 关闭
 *   JIMENG_BROWSER_TRANSPORT=auto     # 仅在上游风控拦截时改用浏览器重试（默认）
 *   JIMENG_BROWSER_TRANSPORT=always   # 所有请求都走浏览器
 */
/**
 * 浏览器传输请求参数
 */
export interface BrowserRequestOptions {
  session: string;
  signal?: AbortSignal;
  /** 请求方法 */
  method: string;
  /** 完整请求地址 */
  url: string;
  /** 查询参数 */
  params: Record<string, any>;
  /** 请求头（Cookie 由浏览器自行携带，无需传入） */
  headers: Record<string, any>;
  /** 请求体 */
  data?: any;
  /** 账号 cookie（name/value 对） */
  cookiePairs: Array<[string, string]>;
  timeout?: number;
  retry?: boolean;
}

/**
 * 浏览器传输响应（结构对齐 AxiosResponse）
 */
export interface BrowserResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  config: any;
}

/** 页面初始化后等待应用脚本装载的时间 */
const APP_READY_DELAY = 6000;
/** 视口尺寸 */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * 页面内执行的请求函数（会被序列化后注入浏览器，不能引用外部作用域）
 */
const inPageRequest = async (payload: {
  url: string;
  method: string;
  params: Record<string, any>;
  headers: Record<string, any>;
  data: any;
  timeout: number;
}) => {
  const target = new URL(payload.url);
  for (const [key, value] of Object.entries(payload.params || {})) {
    if (value === undefined || value === null) continue;
    target.searchParams.set(key, String(value));
  }
  const hasBody = payload.method !== "GET" && payload.method !== "HEAD";
  const body = !hasBody
    ? undefined
    : typeof payload.data === "string"
      ? payload.data
      : JSON.stringify(payload.data ?? {});
  // 浏览器禁止脚本设置 Cookie/Origin/Referer 等头，过滤掉由浏览器自行补齐
  const blocked = ["cookie", "origin", "referer", "host", "content-length", "accept-encoding", "connection"];
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.headers || {})) {
    if (blocked.includes(key.toLowerCase())) continue;
    if (value === undefined || value === null) continue;
    headers[key] = String(value);
  }
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type"))
    headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), payload.timeout);
  try {
    // 页面自身的 fetch 包装器会按需补上 msToken / a_bogus 等签名参数
    const response = await fetch(target.toString(), {
      method: payload.method,
      headers,
      body,
      credentials: "include",
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, statusText: response.statusText, text };
  } catch (error: any) {
    return { status: 0, statusText: "", text: "", error: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
};

class BrowserTransport {

  private dependencyAvailable?: Promise<boolean>;
  /** 是否无头模式 */
  private readonly headless: boolean;
  /** 浏览器通道 */
  private readonly channel?: string;
  /** 浏览器可执行文件路径 */
  private readonly executablePath?: string;
  /** 用于装载签名的页面地址 */
  private readonly pageUrl: string;
  /** 请求超时（毫秒） */
  private readonly requestTimeout: number;
  /** 导航超时（毫秒） */
  private readonly navigationTimeout: number;
  /** 空闲关闭时间（毫秒） */
  private readonly idleTimeout: number;
  /** 伪装 UA，避免页面识别出 Headless 环境 */
  private readonly userAgent: string;
  /** 额外的浏览器启动参数 */
  private readonly launchArgs: string[];

  /** 浏览器实例 */
  private browser: Browser | null = null;
  /** 浏览器上下文 */
  private context: BrowserContext | null = null;
  private session: string | undefined;
  /** 页面实例 */
  private page: Page | null = null;
  private appliedCookies = new Map<string, string>();
  /** 空闲关闭定时器 */
  private idleTimer: NodeJS.Timeout | null = null;
  /** 已知需要浏览器签名的请求标识 */
  private readonly browserRequiredKeys = new Set<string>();
  /** 请求串行队列 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    const env = process.env;
    this.headless = String(env.JIMENG_BROWSER_HEADLESS || "true").toLowerCase() !== "false";
    this.channel = env.JIMENG_BROWSER_CHANNEL || undefined;
    this.executablePath = env.JIMENG_BROWSER_EXECUTABLE || undefined;
    this.pageUrl = env.JIMENG_BROWSER_PAGE_URL || "https://jimeng.jianying.com/ai-tool/video/generate";
    this.requestTimeout = Number(env.JIMENG_BROWSER_REQUEST_TIMEOUT || 60000);
    this.navigationTimeout = Number(env.JIMENG_BROWSER_NAVIGATION_TIMEOUT || 90000);
    this.idleTimeout = Number(env.JIMENG_BROWSER_IDLE_TIMEOUT || 300000);
    this.userAgent =
      env.JIMENG_BROWSER_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
    this.launchArgs = String(env.JIMENG_BROWSER_ARGS || "")
      .split(",")
      .map(item => item.trim())
      .filter(Boolean);
  }

  async status() {
    this.dependencyAvailable ??= import("playwright-core").then(() => true, () => false);
    return {
      dependencyAvailable: await this.dependencyAvailable,
      browserRunning: Boolean(this.page && !this.page.isClosed()),
    };
  }

  isRequired(session: string, key: string) {
    return this.browserRequiredKeys.has(session + ':' + key);
  }

  markRequired(session: string, key: string) {
    this.browserRequiredKeys.add(session + ':' + key);
  }

  /**
   * 通过浏览器发送请求
   *
   * @param options 请求参数
   */
  async request(options: BrowserRequestOptions): Promise<BrowserResponse> {
    // 串行管理浏览器上下文，切换账号时关闭上一账号的页面。
    const task = this.queue.then(async () => {
      options.signal?.throwIfAborted();
      this.clearIdleTimer();
      try {
        return await this.execute(options);
      } finally {
        if (this.page) this.touch();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  /** 关闭浏览器 */
  async close() {
    this.clearIdleTimer();
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.session = undefined;
    this.page = null;
    this.appliedCookies.clear();
    if (!browser) return;
    try {
      await browser.close();
      logger.info("浏览器传输层已关闭");
    } catch (error: any) {
      logger.warn(`关闭浏览器失败: ${error?.message || error}`);
    }
  }

  /**
   * 执行请求
   */
  private async execute(options: BrowserRequestOptions): Promise<BrowserResponse> {
    const page = await this.ensurePage(options.session);
    options.signal?.throwIfAborted();
    await this.applyCookies(page.context(), options.cookiePairs);

    logger.info(`[浏览器传输] ${options.method.toUpperCase()} ${options.url}`);
    const payload = {
      url: options.url,
      method: options.method.toUpperCase(),
      params: options.params || {},
      headers: options.headers || {},
      data: options.data ?? null,
      timeout: options.timeout ?? this.requestTimeout,
    };
    options.signal?.throwIfAborted();
    let result = await page.evaluate(inPageRequest, payload);

    // 浏览器或页面异常时重启一次
    if (result.status === 0 && result.error && options.retry !== false) {
      options.signal?.throwIfAborted();
      logger.warn(`[浏览器传输] 请求失败，重建浏览器后重试: ${result.error}`);
      await this.close();
      const retryPage = await this.ensurePage(options.session);
      await this.applyCookies(retryPage.context(), options.cookiePairs);
      options.signal?.throwIfAborted();
      result = await retryPage.evaluate(inPageRequest, payload);
    }

    if (result.status === 0)
      throw new Error(`[浏览器传输] 请求失败: ${result.error || "未知错误"}`);

    let data: any = result.text;
    try {
      data = JSON.parse(result.text);
    } catch {
      // 非 JSON 响应保持原文
    }
    return {
      status: result.status,
      statusText: result.statusText,
      headers: {},
      data,
      config: {},
    };
  }

  /**
   * 确保页面可用
   */
  private async ensurePage(session: string) {
    if (this.session === session && this.page && !this.page.isClosed()) return this.page;
    try {
      if (this.browser && !this.browser.isConnected()) await this.close();
      await this.context?.close();
      this.appliedCookies.clear();
      this.browser ??= await this.launch();
      await this.openPage(this.browser);
      this.session = session;
    } catch (error) {
      await this.close();
      throw error;
    }
    if (!this.page) throw new Error("[浏览器传输] 浏览器页面不可用");
    return this.page;
  }

  /**
   * 启动浏览器
   */
  private async launch() {
    let playwright: typeof import("playwright-core");
    try {
      playwright = await import("playwright-core");
    } catch {
      throw new Error("[浏览器传输] 缺少依赖 playwright-core，请先执行 npm i playwright-core");
    }

    const launchOptions: Parameters<typeof playwright.chromium.launch>[0] = {
      headless: this.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        ...this.launchArgs,
      ],
    };
    if (this.executablePath) launchOptions.executablePath = this.executablePath;
    else if (this.channel) launchOptions.channel = this.channel;

    logger.info(`浏览器传输层启动中（headless=${this.headless}, channel=${this.channel || "自动"}）...`);
    try {
      return await playwright.chromium.launch(launchOptions);
    } catch (error: any) {
      if (this.channel || this.executablePath) throw error;
      // 未指定通道时，依次尝试本机 Chrome / Edge
      logger.warn(`默认通道启动失败（${error?.message || error}），尝试使用本机 Edge`);
      return playwright.chromium.launch({ ...launchOptions, channel: "msedge" });
    }
  }

  private async openPage(browser: Browser) {
    this.context = await browser.newContext({
      userAgent: this.userAgent,
      viewport: VIEWPORT,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
    });
    this.page = await this.context.newPage();

    await this.page.goto(this.pageUrl, { waitUntil: "domcontentloaded", timeout: this.navigationTimeout });
    await this.page.waitForTimeout(APP_READY_DELAY);

    const ready = await this.page
      .evaluate(() => ({
        href: location.href,
        hasBdms: typeof (window as any).bdms !== "undefined",
      }))
      .catch(() => ({ href: "", hasBdms: false }));
    if (!ready.hasBdms)
      logger.warn("[浏览器传输] 页面未检测到签名 SDK，若请求仍被风控拦截请检查页面地址或登录状态");
    logger.info(`浏览器传输层就绪: ${ready.href}`);
  }

  /**
   * 同步账号 cookie 到浏览器上下文
   *
   * @param cookiePairs cookie 键值对
   */
  private async applyCookies(context: BrowserContext, cookiePairs: Array<[string, string]>) {
    const next = new Map(cookiePairs);
    if (next.size === this.appliedCookies.size
      && [...next].every(([name, value]) => this.appliedCookies.get(name) === value)) return;

    const scope = { domain: ".jianying.com", path: "/" };
    for (const name of this.appliedCookies.keys()) {
      if (!next.has(name)) await context.clearCookies({ name, ...scope });
    }
    if (next.size) {
      await context.addCookies([...next].map(([name, value]) => ({ name, value, ...scope })));
    }
    this.appliedCookies = next;
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private touch() {
    this.clearIdleTimer();
    if (!this.idleTimeout) return;
    this.idleTimer = setTimeout(() => {
      logger.info(`浏览器传输层空闲超过 ${Math.round(this.idleTimeout / 1000)} 秒，自动关闭`);
      this.queue = this.queue.then(() => this.close());
    }, this.idleTimeout);
    this.idleTimer.unref?.();
  }

}

export default new BrowserTransport();
