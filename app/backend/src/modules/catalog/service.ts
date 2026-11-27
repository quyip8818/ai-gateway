import type { Store } from '../../infrastructure/postgres/store.ts';

export function createCatalog(store: Pick<Store, 'models' | 'listModels'>) {
  return {
    listAdmin: store.listModels,
    async listPublic(key: { id: string; scopes: string[] }) {
      const models = await store.models(key);
      return {
        object: 'list',
        data: models.map((model) => ({ object: 'model', ...model, owned_by: model.id.split('/')[0] })),
      };
    },
  };
}

export type Catalog = ReturnType<typeof createCatalog>;
