import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import {
  EMBEDDING_PORT,
  type EmbeddingPort,
  KNOWLEDGE_INGESTION_PORT,
  type KnowledgeIngestionPort,
} from '../../src/domain/knowledge/knowledge.ports.js';
import { parseKnowledgeMarkdownDocument } from '../../src/domain/knowledge/markdown-chunker.js';
import { KnowledgeRepositoryService } from '../../src/domain/knowledge-repository.service.js';
import { PostgresPoolProvider } from '../../src/infrastructure/database/postgres-pool.provider.js';

function makeDeterministicVector(seedValues: number[]): number[] {
  const vec = new Array<number>(768).fill(0);
  seedValues.forEach((v, i) => {
    vec[i] = v;
  });
  const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

describe('PostgreSQL + pgvector Hybrid RAG Integration', () => {
  it('runs schema DDL, incremental upsert, HNSW semantic + FTS RRF search, and health checks', async () => {
    const fakeDeterministicEmbeddings: EmbeddingPort = {
      modelId: 'deterministic-test-768',
      dimensions: 768,
      async embedQuery(text: string) {
        const lower = text.toLowerCase();
        if (lower.includes('pagos') || lower.includes('billetera') || lower.includes('stripe')) {
          return makeDeterministicVector([0.9, 0.2, 0.05]);
        }
        if (lower.includes('observabilidad') || lower.includes('datadog')) {
          return makeDeterministicVector([0.05, 0.9, 0.2]);
        }
        return makeDeterministicVector([0.2, 0.2, 0.9]);
      },
      async embedDocuments(texts: string[]) {
        return texts.map((t) => {
          const lower = t.toLowerCase();
          if (lower.includes('stripe') || lower.includes('nequi')) {
            return makeDeterministicVector([0.92, 0.18, 0.04]);
          }
          if (lower.includes('datadog') || lower.includes('clevertap')) {
            return makeDeterministicVector([0.04, 0.92, 0.18]);
          }
          return makeDeterministicVector([0.15, 0.15, 0.95]);
        });
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMBEDDING_PORT)
      .useValue(fakeDeterministicEmbeddings)
      .compile();

    await moduleRef.init();

    const poolProvider = moduleRef.get(PostgresPoolProvider);
    assert.equal(poolProvider.isConfigured(), true, 'DATABASE_URL must be configured for integration test');

    const ingestion = moduleRef.get<KnowledgeIngestionPort>(KNOWLEDGE_INGESTION_PORT);
    const repo = moduleRef.get(KnowledgeRepositoryService);

    await ingestion.ensureSchema();

    const sampleDoc = parseKnowledgeMarkdownDocument(
      'integration-sample.md',
      `<!-- category: integrations; tags: Stripe, Nequi, Datadog -->
# Integration Test Profile

## Payment Gateways & Wallets
Built Stripe Payment Intents and Nequi digital wallet push/QR integrations with Redis distributed locks.

## Production Observability
Configured Datadog APM distributed tracing, SLA alerts, and CleverTap event funnels.`,
    );

    const vectors = await fakeDeterministicEmbeddings.embedDocuments(
      sampleDoc.chunks.map((c) => c.embeddedText),
    );
    const { chunks: _chunks, ...docHeader } = sampleDoc;

    const firstUpsert = await ingestion.upsertDocumentWithChunks(
      docHeader,
      sampleDoc.chunks.map((c, idx) => ({ ...c, embedding: vectors[idx] })),
      { force: true },
    );
    assert.equal(firstUpsert.action, 'upserted');
    assert.equal(firstUpsert.chunkCount, 2);

    const secondUpsert = await ingestion.upsertDocumentWithChunks(
      docHeader,
      sampleDoc.chunks.map((c, idx) => ({ ...c, embedding: vectors[idx] })),
    );
    assert.equal(secondUpsert.action, 'skipped-unchanged');

    // Cross-lingual semantic + lexical query ("billetera" + "Stripe")
    const paymentHits = await repo.searchKnowledge({
      query: 'experiencia en pagos y billetera digital con Stripe',
      keywords: ['Nequi'],
      limit: 2,
    });
    assert.equal(paymentHits.mode, 'hybrid');
    assert.ok(paymentHits.hits.length >= 1);
    assert.equal(paymentHits.hits[0].sectionTitle, 'Payment Gateways & Wallets');
    assert.equal(paymentHits.hits[0].matchedVia, 'hybrid');

    // Observability query
    const obsHits = await repo.searchKnowledge({
      query: 'observabilidad en produccion',
      keywords: ['Datadog'],
      limit: 2,
    });
    assert.ok(obsHits.hits.length >= 1);
    assert.equal(obsHits.hits[0].sectionTitle, 'Production Observability');

    const health = await repo.getHealthStatus();
    assert.equal(health.backend, 'postgres-pgvector');
    assert.equal(health.connected, true);
    assert.ok(health.chunkCount >= 2);

    // Clean up test document so only real ingested knowledge stays in DB
    const pool = poolProvider.getPool();
    await pool?.query('DELETE FROM knowledge_documents WHERE id = $1', [sampleDoc.id]);

    await moduleRef.close();
  });
});
