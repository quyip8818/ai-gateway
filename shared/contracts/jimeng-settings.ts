export const jimengBrowserSettingId = 'jimeng.browser_transport';

export const jimengBrowserOptions = [
  { value: 'off', label: '关闭' },
  { value: 'auto', label: '自动' },
  { value: 'always', label: '始终使用浏览器' },
] as const;

export type BrowserTransportMode = typeof jimengBrowserOptions[number]['value'];

export function isBrowserTransportMode(value: unknown): value is BrowserTransportMode {
  return jimengBrowserOptions.some((option) => option.value === value);
}
