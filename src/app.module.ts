import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { AiModule } from '@nestjs/ai';
import { Module } from '@nestjs/common';
import { PortfolioAgentService } from './application/portfolio-agent.service.js';
import { PortfolioToolsProvider } from './application/portfolio-tools.provider.js';
import { KnowledgeRepositoryService } from './domain/knowledge-repository.service.js';
import {
  EMBEDDING_PORT,
  KNOWLEDGE_INGESTION_PORT,
  KNOWLEDGE_SEARCH_PORT,
} from './domain/knowledge/knowledge.ports.js';
import { NestJsEmbeddingAdapter } from './infrastructure/ai/nestjs-embedding.adapter.js';
import { InMemoryKnowledgeRepository } from './infrastructure/database/in-memory-knowledge.repository.js';
import { PgVectorKnowledgeRepository } from './infrastructure/database/pgvector-knowledge.repository.js';
import { PostgresPoolProvider } from './infrastructure/database/postgres-pool.provider.js';
import { DEFAULT_EMBEDDING_DIMENSIONS } from './infrastructure/database/rag-schema.js';
import { HmacOriginGuard } from './infrastructure/security/hmac-origin.guard.js';
import { RateLimitGuard } from './infrastructure/security/rate-limit.guard.js';
import { AgentController } from './presentation/agent.controller.js';

for (const envFile of ['.env', '.env.production']) {
  try {
    process.loadEnvFile?.(envFile);
  } catch {
    // Ignore if env file does not exist
  }
}

function createModelsAndEmbeddings() {
  const googleGatewayUrl = process.env.CLOUDFLARE_AI_GATEWAY_GOOGLE_URL?.trim();
  const groqGatewayUrl = process.env.CLOUDFLARE_AI_GATEWAY_GROQ_URL?.trim();

  const googleProvider = createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || 'unconfigured-local-key',
    ...(googleGatewayUrl ? { baseURL: googleGatewayUrl } : {}),
  });

  const groqProvider = createGroq({
    apiKey: process.env.GROQ_API_KEY || 'unconfigured-local-key',
    ...(groqGatewayUrl ? { baseURL: groqGatewayUrl } : {}),
  });

  const geminiModelId = process.env.GEMINI_MODEL_ID || 'gemini-2.5-flash';
  const groqModelId = process.env.GROQ_MODEL_ID || 'openai/gpt-oss-120b';
  const groqSecondaryModelId = process.env.GROQ_SECONDARY_MODEL_ID || 'openai/gpt-oss-20b';
  const vercelGatewayModel = process.env.AI_GATEWAY_MODEL?.trim();

  const embeddingModelId = process.env.EMBEDDING_MODEL_ID?.trim() || 'gemini-embedding-001';
  const embeddingDimensions =
    Number.parseInt(process.env.EMBEDDING_DIMENSIONS || '', 10) ||
    DEFAULT_EMBEDDING_DIMENSIONS;

  return {
    primaryModel: vercelGatewayModel ? vercelGatewayModel : groqProvider(groqModelId),
    secondaryModel: groqProvider(groqSecondaryModelId),
    fallbackModel: googleProvider(geminiModelId),
    embeddingModel: googleProvider.embedding(embeddingModelId),
    embeddingDimensions,
  };
}

const {
  primaryModel,
  secondaryModel,
  fallbackModel,
  embeddingModel,
  embeddingDimensions,
} = createModelsAndEmbeddings();

@Module({
  imports: [
    AiModule.forRoot({
      models: {
        default: {
          model: primaryModel,
          maxOutputTokens: 900,
          fallback: 'groq-secondary',
          timeout: '10s',
          retry: false,
        },
        'groq-secondary': {
          model: secondaryModel,
          maxOutputTokens: 900,
          fallback: 'gemini-fallback',
          timeout: '10s',
          retry: false,
        },
        'gemini-fallback': {
          model: fallbackModel,
          maxOutputTokens: 900,
          timeout: '12s',
          retry: false,
        },
      },
      embeddingModels: {
        default: {
          model: embeddingModel,
          timeout: '10s',
          retry: { attempts: 2, backoff: { delay: '400ms', maxDelay: '2s' } },
          providerOptions: {
            google: {
              outputDimensionality: embeddingDimensions,
            },
          },
        },
      },
      defaults: {
        maxSteps: 4,
        maxOutputTokens: 900,
        timeout: '15s',
      },
    }),
  ],
  controllers: [AgentController],
  providers: [
    PostgresPoolProvider,
    PgVectorKnowledgeRepository,
    InMemoryKnowledgeRepository,
    NestJsEmbeddingAdapter,
    {
      provide: EMBEDDING_PORT,
      useExisting: NestJsEmbeddingAdapter,
    },
    {
      provide: KNOWLEDGE_INGESTION_PORT,
      useExisting: PgVectorKnowledgeRepository,
    },
    {
      provide: KNOWLEDGE_SEARCH_PORT,
      inject: [PostgresPoolProvider, PgVectorKnowledgeRepository, InMemoryKnowledgeRepository],
      useFactory: (
        poolProvider: PostgresPoolProvider,
        pgVectorRepo: PgVectorKnowledgeRepository,
        inMemoryRepo: InMemoryKnowledgeRepository,
      ) => (poolProvider.isConfigured() ? pgVectorRepo : inMemoryRepo),
    },
    KnowledgeRepositoryService,
    PortfolioToolsProvider,
    PortfolioAgentService,
    HmacOriginGuard,
    RateLimitGuard,
  ],
  exports: [
    PortfolioAgentService,
    PortfolioToolsProvider,
    KnowledgeRepositoryService,
    KNOWLEDGE_SEARCH_PORT,
    KNOWLEDGE_INGESTION_PORT,
    EMBEDDING_PORT,
  ],
})
export class AppModule {}
