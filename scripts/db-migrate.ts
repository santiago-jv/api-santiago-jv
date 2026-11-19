import { createPostgresPool } from '../src/infrastructure/database/postgres-pool.provider.js';
import {
  buildRagMigrationSql,
  DEFAULT_EMBEDDING_DIMENSIONS,
} from '../src/infrastructure/database/rag-schema.js';

for (const envFile of ['.env', '.env.production']) {
  try {
    process.loadEnvFile?.(envFile);
  } catch {
    // Ignore missing env file
  }
}

async function main() {
  const pool = createPostgresPool();
  if (!pool) {
    console.error('Missing DATABASE_URL or POSTGRES_URL in environment or .env.');
    process.exit(1);
  }

  const dimensions =
    Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10) ||
    DEFAULT_EMBEDDING_DIMENSIONS;

  try {
    const sql = buildRagMigrationSql(dimensions);
    await pool.query(sql);

    const { rows } = await pool.query<{
      vector_version: string | null;
      docs: string;
      chunks: string;
    }>(`
      SELECT
        (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
        (SELECT count(*)::text FROM knowledge_documents) AS docs,
        (SELECT count(*)::text FROM knowledge_chunks) AS chunks
    `);

    const status = rows[0];
    console.log(
      `[db:migrate] PostgreSQL + pgvector (${status?.vector_version || 'unknown'}) ready · dims=${dimensions} · docs=${status?.docs || '0'} · chunks=${status?.chunks || '0'}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[db:migrate] Failed:', err);
  process.exit(1);
});
