import type { Store } from '../../infrastructure/postgres/store.ts';

export function createCatalog(store: Pick<Store, 'models' | 'listModels'>) {
  return {
    listAdmin: store.listModels,
    async listPublic(key: { id: string; scopes: string[] }) {
      const models = await store.models(key);
      return {
        object: 'list',
        data: models.map(({ id, operation, capabilities, provider }) => ({
          id, object: 'model', operation, capabilities, owned_by: provider === 'jimeng' ? 'bytedance' : provider,
        })),
      };
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
