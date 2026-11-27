import type { SettingDefinition } from '../../modules/settings/service.ts';
import {
  isBrowserTransportMode, jimengBrowserOptions, jimengBrowserSettingId, type BrowserTransportMode,
} from '../../../../../shared/contracts/jimeng-settings.ts';
import browserTransport from './lib/browser-transport.ts';

export const defaultBrowserTransportMode: BrowserTransportMode = 'auto';

function environmentMode(env: NodeJS.ProcessEnv) {
  const value = env.JIMENG_BROWSER_TRANSPORT?.trim().toLowerCase();
  return isBrowserTransportMode(value) ? value : undefined;
}

export const startupBrowserTransportMode = environmentMode(process.env) ?? defaultBrowserTransportMode;

export function jimengBrowserSetting(env: NodeJS.ProcessEnv): SettingDefinition {
  return {
    id: jimengBrowserSettingId,
    title: '浏览器传输',
    provider: 'jimeng',
    environment_variable: 'JIMENG_BROWSER_TRANSPORT',
    options: jimengBrowserOptions,
    defaultValue: defaultBrowserTransportMode,
    environmentValue: environmentMode(env),
    async getStatus() {
      const { dependencyAvailable, browserRunning } = await browserTransport.status();
      return [
        { label: '浏览器依赖', value: dependencyAvailable ? '已安装' : '未安装' },
        { label: '浏览器', value: browserRunning ? '运行中' : '未运行' },
      ];
    },
  };
}
