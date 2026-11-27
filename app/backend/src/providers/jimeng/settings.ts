import type { SettingDefinition } from '../../modules/settings/service.ts';
import browserTransport, {
  BROWSER_TRANSPORT_MODES,
  DEFAULT_BROWSER_TRANSPORT_MODE,
  normalizeBrowserTransportMode,
} from './lib/browser-transport.ts';

const labels = { off: '关闭', auto: '自动', always: '始终使用浏览器' };

export function jimengBrowserSetting(env: NodeJS.ProcessEnv): SettingDefinition {
  return {
    id: 'jimeng.browser_transport',
    title: '浏览器传输',
    provider: 'jimeng',
    environment_variable: 'JIMENG_BROWSER_TRANSPORT',
    options: BROWSER_TRANSPORT_MODES.map((value) => ({ value, label: labels[value] })),
    defaultValue: DEFAULT_BROWSER_TRANSPORT_MODE,
    environmentValue: normalizeBrowserTransportMode(env.JIMENG_BROWSER_TRANSPORT),
    apply(value) {
      browserTransport.setMode(value as typeof BROWSER_TRANSPORT_MODES[number]);
    },
    async getStatus() {
      const { dependencyAvailable, browserRunning } = await browserTransport.status();
      return [
        { label: '浏览器依赖', value: dependencyAvailable ? '已安装' : '未安装' },
        { label: '浏览器', value: browserRunning ? '运行中' : '未运行' },
      ];
    },
  };
}
