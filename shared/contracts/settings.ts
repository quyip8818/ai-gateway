import type { Provider } from './providers.ts';

export type SettingSource = 'console' | 'env' | 'default';

export interface RuntimeSetting {
  id: string;
  title: string;
  provider?: Provider;
  environment_variable?: string;
  options: readonly { value: string; label: string }[];
  value: string;
  source: SettingSource;
  status?: readonly { label: string; value: string }[];
}

export interface AdminSettings {
  service: {
    host: string;
    port: number;
    public_origin: string | null;
    media_directory: string;
  };
  runtime: RuntimeSetting[];
}
