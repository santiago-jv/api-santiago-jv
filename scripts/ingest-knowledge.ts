import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import {
  EMBEDDING_PORT,
  type EmbeddingPort,
  KNOWLEDGE_INGESTION_PORT,
  type KnowledgeIngestionPort,
} from '../src/domain/knowledge/knowledge.ports.js';
import type {
  KnowledgeChunkWithEmbedding,
  KnowledgeDocumentDraft,
} from '../src/domain/knowledge/knowledge.types.js';
import { parseKnowledgeMarkdownDocument } from '../src/domain/knowledge/markdown-chunker.js';
import { PostgresPoolProvider } from '../src/infrastructure/database/postgres-pool.provider.js';

const BATCH_SIZE = 20;

function loadPrivateMarkdownFiles(rootDir: string): Array<{ sourcePath: string; raw: string }> {
  const knowledgeDir = path.join(rootDir, '.private', 'knowledge');
  if (fs.existsSync(knowledgeDir)) {
    const files = fs
      .readdirSync(knowledgeDir)
      .filter((name) => name.endsWith('.md'))
      .sort();
    if (files.length > 0) {
      return files.map((fileName) => ({
        sourcePath: `knowledge/${fileName}`,
        raw: fs.readFileSync(path.join(knowledgeDir, fileName), 'utf8'),
      }));
    }
  }

  const singleFile = path.join(rootDir, '.private', 'knowledge-base.md');
  if (fs.existsSync(singleFile)) {
    return [
      {
        sourcePath: 'knowledge-base.md',
        raw: fs.readFileSync(singleFile, 'utf8'),
      },
    ];
  }

  return [];
}

async function embedInBatches(
  embeddingPort: EmbeddingPort,
  texts: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const slice = texts.slice(i, i + BATCH_SIZE);
    const batch = await embeddingPort.embedDocuments(slice);
    vectors.push(...batch);
  }
  return vectors;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const force = args.has('--force');
  const dryRun = args.has('--dry-run');
  const prune = !args.has('--no-prune');

  const rootDir = path.resolve(import.meta.dirname, '..');
  const files = loadPrivateMarkdownFiles(rootDir);

  if (files.length === 0) {
    console.error('No markdown files found in .private/knowledge/ or .private/knowledge-base.md.');
    process.exit(1);
  }

  const drafts: KnowledgeDocumentDraft[] = files.map((file) =>
    parseKnowledgeMarkdownDocument(file.sourcePath, file.raw),
  );

  if (dryRun) {
    console.log(`[ingest:dry-run] Parsed ${drafts.length} documents:`);
    for (const doc of drafts) {
      const totalTokens = doc.chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
      console.log(
        `  - ${doc.id} (${doc.category}) · ${doc.chunks.length} chunks · ~${totalTokens} tokens`,
      );
      for (const chunk of doc.chunks) {
        console.log(
          `      [${chunk.id}] ${chunk.sectionTitle} (tags=${chunk.tags.slice(0, 6).join(', ')})`,
        );
      }
    }
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const poolProvider = app.get(PostgresPoolProvider);
    if (!poolProvider.isConfigured()) {
      console.error('Missing DATABASE_URL or POSTGRES_URL. Configure .env before ingesting.');
      process.exitCode = 1;
      return;
    }

    const ingestionPort = app.get<KnowledgeIngestionPort>(KNOWLEDGE_INGESTION_PORT);
    const embeddingPort = app.get<EmbeddingPort>(EMBEDDING_PORT);

    await ingestionPort.ensureSchema();

    const activeIds: string[] = [];
    let upsertedCount = 0;
    let skippedCount = 0;
    let totalChunks = 0;

    for (const doc of drafts) {
      activeIds.push(doc.id);
      if (!force) {
        const stored = await ingestionPort.getStoredDocumentHash(doc.id);
        if (stored && stored.contentHash === doc.contentHash && stored.chunkCount === doc.chunks.length) {
          skippedCount += 1;
          totalChunks += stored.chunkCount;
          console.log(`  [skip]   ${doc.id} (${stored.chunkCount} chunks unchanged)`);
          continue;
        }
      }

      const embeddings = await embedInBatches(
        embeddingPort,
        doc.chunks.map((c) => c.embeddedText),
      );

      if (embeddings.length !== doc.chunks.length) {
        throw new Error(
          `Embedding count mismatch for ${doc.id}: expected ${doc.chunks.length}, got ${embeddings.length}`,
        );
      }

      const chunksWithEmbeddings: KnowledgeChunkWithEmbedding[] = doc.chunks.map((chunk, idx) => ({
        ...chunk,
        embedding: embeddings[idx],
      }));

      const { chunks: _ignored, ...docHeader } = doc;
      const result = await ingestionPort.upsertDocumentWithChunks(docHeader, chunksWithEmbeddings, {
        force,
      });

      upsertedCount += 1;
      totalChunks += result.chunkCount;
      console.log(
        `  [upsert] ${doc.id} · ${result.chunkCount} chunks · model=${embeddingPort.modelId} (${embeddingPort.dimensions}d)`,
      );
    }

    let pruned: string[] = [];
    if (prune) {
      pruned = await ingestionPort.deleteStaleDocuments(activeIds);
      if (pruned.length > 0) {
        console.log(`  [prune]  removed stale documents: ${pruned.join(', ')}`);
      }
    }

    console.log(
      `[ingest] Complete · docs=${drafts.length} (upserted=${upsertedCount}, skipped=${skippedCount}, pruned=${pruned.length}) · totalChunks=${totalChunks}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[ingest] Failed:', err);
  process.exit(1);
});
