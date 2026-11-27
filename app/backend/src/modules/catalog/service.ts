import type { Store } from '../../infrastructure/postgres/store.ts';

function presentModel(model: { id: string; operation: string; capabilities: Record<string, unknown> }) {
  const { name, description, ...capabilities } = model.capabilities;
  return { id: model.id, name, description, operation: model.operation, capabilities };
}

export function createCatalog(store: Pick<Store, 'models' | 'listModels'>) {
  return {
    async listAdmin() {
      return (await store.listModels()).map(presentModel);
    },
    async listPublic(key: { id: string; scopes: string[] }) {
      return {
        object: 'list',
        data: (await store.models(key)).map((model) => ({
          ...presentModel(model),
          object: 'model',
          owned_by: model.provider === 'jimeng' ? 'bytedance' : model.provider,
        })),
      };
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
