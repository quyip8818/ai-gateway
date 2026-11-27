import type { AdminSettings, RuntimeSetting } from '../../../../../shared/contracts/settings.ts';
import { AppError } from '../../domain.ts';
import type { Store } from '../../infrastructure/postgres/store.ts';

type Choice = Pick<RuntimeSetting, 'value' | 'source'>;

export interface SettingDefinition extends Pick<RuntimeSetting, 'id' | 'title' | 'provider' | 'environment_variable' | 'options'> {
  defaultValue: string;
  environmentValue?: string;
  apply(value: string): void;
  getStatus?(): Promise<RuntimeSetting['status']>;
}

export async function createSettings(
  store: Pick<Store, 'readSettingOverrides' | 'writeSettingOverride'>,
  service: AdminSettings['service'],
  definitions: readonly SettingDefinition[],
) {
  const stored = new Map((await store.readSettingOverrides()).map(({ id, value }) => [id, value]));
  const active = new Map<string, Choice>();

  function effective(definition: SettingDefinition, override: string | null | undefined): Choice {
    if (typeof override === 'string' && definition.options.some((option) => option.value === override)) {
      return { value: override, source: 'console' };
    }
    if (definition.environmentValue !== undefined) return { value: definition.environmentValue, source: 'env' };
    return { value: definition.defaultValue, source: 'default' };
  }

  function apply(definition: SettingDefinition, override: string | null | undefined) {
    const choice = effective(definition, override);
    definition.apply(choice.value);
    active.set(definition.id, choice);
  }

  for (const definition of definitions) apply(definition, stored.get(definition.id));

  async function snapshot(): Promise<AdminSettings> {
    const runtime = await Promise.all(definitions.map(async (definition) => ({
      id: definition.id,
      title: definition.title,
      provider: definition.provider,
      environment_variable: definition.environment_variable,
      options: definition.options,
      ...active.get(definition.id)!,
      status: await definition.getStatus?.(),
    })));
    return { service, runtime };
  }

  // Keep writes and their in-process effects ordered in the same way.
  let pending: Promise<unknown> = Promise.resolve();
  function update(id: string, value: unknown) {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new AppError(404, 'setting_not_found');
    if (value !== null && (typeof value !== 'string' || !definition.options.some((option) => option.value === value))) {
      throw new AppError(400, 'invalid_setting_value');
    }
    const work = pending.then(async () => {
      await store.writeSettingOverride(id, value);
      apply(definition, value);
      return snapshot();
    });
    pending = work.catch(() => undefined);
    return work;
  }

  return { list: () => pending.then(snapshot), update };
}

export type Settings = Awaited<ReturnType<typeof createSettings>>;
