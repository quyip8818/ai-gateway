import type { RuntimeSetting } from '../../../../../shared/contracts/settings.ts';
import { AppError, type Provider } from '../../domain.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';

type Choice = Pick<RuntimeSetting, 'value' | 'source'>;

export interface SettingDefinition extends Pick<RuntimeSetting, 'id' | 'title' | 'provider' | 'environment_variable' | 'options'> {
  defaultValue: string;
  environmentValue?: string;
  getStatus?(): Promise<RuntimeSetting['status']>;
}

export function createSettings(
  store: Pick<Store, 'readSettingOverride' | 'writeSettingOverride'>,
  definitions: readonly SettingDefinition[],
) {
  function effective(definition: SettingDefinition, override: string | null | undefined): Choice {
    if (typeof override === 'string' && definition.options.some((option) => option.value === override)) {
      return { value: override, source: 'console' };
    }
    if (definition.environmentValue !== undefined) return { value: definition.environmentValue, source: 'env' };
    return { value: definition.defaultValue, source: 'default' };
  }

  function find(id: string) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new AppError(404, 'setting_not_found');
    return definition;
  }

  async function read(definition: SettingDefinition) {
    return effective(definition, await store.readSettingOverride(definition.id));
  }

  async function list(provider: Provider): Promise<RuntimeSetting[]> {
    return Promise.all(definitions.filter((definition) => definition.provider === provider).map(async (definition) => ({
      id: definition.id,
      title: definition.title,
      provider: definition.provider,
      environment_variable: definition.environment_variable,
      options: definition.options,
      ...await read(definition),
      status: await definition.getStatus?.(),
    })));
  }

  async function update(provider: Provider, id: string, value: unknown) {
    const definition = find(id);
    if (definition.provider !== provider) throw new AppError(404, 'setting_not_found');
    if (value !== null && (typeof value !== 'string' || !definition.options.some((option) => option.value === value))) {
      throw new AppError(400, 'invalid_setting_value');
    }
    await store.writeSettingOverride(id, value);
    return list(provider);
  }

  return { list, update, resolve: (id: string) => read(find(id)) };
}

export type Settings = ReturnType<typeof createSettings>;
