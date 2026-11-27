import type pg from 'pg';
import type { MediaPage, MediaQuery } from '../../../../../shared/contracts/media.ts';

interface NewAsset {
  id: string;
  owner: string;
  mime: string;
  bytes: number;
  model: string;
  videoId?: string;
}

export function insertAsset(db: pg.Pool | pg.PoolClient, asset: NewAsset) {
  return db.query(
    'INSERT INTO media_assets(id,owner_id,mime,bytes,model,video_id) VALUES($1,$2,$3,$4,$5,$6)',
    [asset.id, asset.owner, asset.mime, asset.bytes, asset.model, asset.videoId ?? null],
  );
}

export function createMediaRepository(db: pg.Pool) {
  async function pageAssets({ type, provider, page, limit }: MediaQuery): Promise<MediaPage> {
    const {
      rows: [{ total: count, items }],
    } = await db.query<{ total: string; items: MediaPage['items'] }>(
      `WITH filtered AS NOT MATERIALIZED (
        SELECT id,mime,bytes,model,created_at,
          split_part(mime,'/',1) AS type, split_part(model,'/',1) AS provider
        FROM media_assets
        WHERE ($1::text IS NULL OR mime LIKE $1 || '/%')
          AND ($2::text IS NULL OR split_part(model,'/',1)=$2)
      ), selection AS (
        SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4
      )
      SELECT (SELECT count(*) FROM filtered) AS total,
        coalesce(json_agg(selection ORDER BY created_at DESC,id DESC),'[]'::json) AS items
      FROM selection`,
      [type ?? null, provider ?? null, limit, (page - 1) * limit],
    );
    const total = Number(count);
    return { items, page, total, total_pages: Math.max(1, Math.ceil(total / limit)) };
  }

  return {
    pageAssets,
    addAsset: (asset: NewAsset) => insertAsset(db, asset),
    findAsset: async (id: string, owner: string | null) => (await db.query<{ id: string; mime: string; bytes: string }>(
      'SELECT id,mime,bytes FROM media_assets WHERE id=$1 AND ($2::uuid IS NULL OR owner_id=$2)',
      [id, owner],
    )).rows[0],
  };
}
