import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { attachDatabasePool } from '@vercel/functions';
import { Pool, type PoolConfig } from 'pg';

function resolveDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL_POOLED ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    ''
  ).trim();
}

function shouldUseSsl(connectionString: string): boolean {
  if (/sslmode=disable/i.test(connectionString)) {
    return false;
  }
  if (/sslmode=(?:require|verify-ca|verify-full|no-verify)/i.test(connectionString)) {
    return true;
  }
  try {
    const url = new URL(connectionString);
    const host = url.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== 'postgres';
  } catch {
    return false;
  }
}

function normalizeSslMode(connectionString: string, rejectUnauthorized: boolean): string {
  if (!rejectUnauthorized) {
    return connectionString;
  }
  try {
    const parsed = new URL(connectionString);
    const mode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca') {
      parsed.searchParams.set('sslmode', 'verify-full');
      return parsed.toString();
    }
  } catch {
    // Preserve raw connection strings that do not parse as standard URLs
  }
  return connectionString;
}

export function createPostgresPool(connectionString = resolveDatabaseUrl()): Pool | null {
  if (!connectionString) {
    return null;
  }

  const useSsl = shouldUseSsl(connectionString);
  const rejectUnauthorized = process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false';
  const normalizedUrl = useSsl
    ? normalizeSslMode(connectionString, rejectUnauthorized)
    : connectionString;

  const config: PoolConfig = {
    connectionString: normalizedUrl,
    max: Number.parseInt(process.env.PG_POOL_MAX || '5', 10) || 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    ...(useSsl ? { ssl: { rejectUnauthorized } } : {}),
  };

  const pool = new Pool(config);
  attachDatabasePool(pool);
  return pool;
}

@Injectable()
export class PostgresPoolProvider implements OnModuleDestroy {
  private readonly logger = new Logger(PostgresPoolProvider.name);
  private pool: Pool | null = null;
  private initialized = false;

  isConfigured(): boolean {
    return resolveDatabaseUrl().length > 0;
  }

  getPool(): Pool | null {
    if (!this.initialized) {
      this.initialized = true;
      this.pool = createPostgresPool();
      if (this.pool) {
        this.pool.on('error', (err) => {
          this.logger.error(`Unexpected PostgreSQL pool error: ${err.message}`);
        });
      }
    }
    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Failed to close PostgreSQL pool cleanly: ${message}`);
      });
      this.pool = null;
    }
  }
}
