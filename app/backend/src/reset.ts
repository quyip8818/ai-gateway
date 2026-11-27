import pg from 'pg';
import { resetSchema } from './infrastructure/postgres/schema.ts';
import { withTransaction } from './infrastructure/postgres/transaction.ts';

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required. See .env.example.');

const db = new pg.Pool({ connectionString });
try {
  await withTransaction(db, resetSchema);
  console.log('Gateway database reset complete.');
} finally {
  await db.end();
}
