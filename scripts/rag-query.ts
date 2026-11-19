import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { KnowledgeRepositoryService } from '../src/domain/knowledge-repository.service.js';

async function main() {
  const query = process.argv.slice(2).join(' ').trim();
  if (!query) {
    console.error('Usage: npm run rag:search -- "your search query"');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const repo = app.get(KnowledgeRepositoryService);
    const health = await repo.getHealthStatus();
    console.log(`[rag:search] backend=${health.backend} docs=${health.documentCount} chunks=${health.chunkCount}`);

    const startedAt = Date.now();
    const result = await repo.searchKnowledge({ query, limit: 5 });
    const elapsedMs = Date.now() - startedAt;

    console.log(`[rag:search] mode=${result.mode} hits=${result.hits.length} latency=${elapsedMs}ms\n`);
    for (const [idx, hit] of result.hits.entries()) {
      console.log(
        `${idx + 1}. [${hit.id}] ${hit.contextualHeader}\n` +
          `   via=${hit.matchedVia} | rrf=${hit.rrfScore} | sim=${hit.semanticSimilarity} | lex=${hit.lexicalScore}\n` +
          `   ${hit.content.replace(/\n+/g, ' ').slice(0, 180)}...\n`,
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[rag:search] Failed:', err);
  process.exit(1);
});
