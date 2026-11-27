import type pg from 'pg';

export function createSettingsRepository(db: pg.Pool) {
  return {
    readSettingOverride: async (id: string) => (await db.query<{ value: string }>(
      'SELECT value FROM runtime_settings WHERE id=$1', [id],
    )).rows[0]?.value,
    writeSettingOverride: (id: string, value: string | null) => value === null
      ? db.query('DELETE FROM runtime_settings WHERE id=$1', [id])
      : db.query(
          'INSERT INTO runtime_settings(id,value) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          [id, value],
        ),
  };
}
