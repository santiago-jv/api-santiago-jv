import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { AiModule } from '@nestjs/ai';
import { Module } from '@nestjs/common';
import { PortfolioAgentService } from './application/portfolio-agent.service.js';
import { PortfolioToolsProvider } from './application/portfolio-tools.provider.js';
import { KnowledgeRepositoryService } from './domain/knowledge-repository.service.js';
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

function createPrimaryAndFallbackModels() {
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

  const geminiModelId = process.env.GEMINI_MODEL_ID || 'gemini-3.8-flash';
  const groqModelId = process.env.GROQ_MODEL_ID || 'openai/gpt-oss-120b';
  const vercelGatewayModel = process.env.AI_GATEWAY_MODEL?.trim();

  return {
    primaryModel: vercelGatewayModel ? vercelGatewayModel : groqProvider(groqModelId),
    fallbackModel: googleProvider(geminiModelId),
  };
}

const { primaryModel, fallbackModel } = createPrimaryAndFallbackModels();

@Module({
  imports: [
    AiModule.forRoot({
      models: {
        default: {
          model: primaryModel,
          maxOutputTokens: 700,
          fallback: 'gemini-fallback',
          timeout: '10s',
          retry: false,
        },
        'gemini-fallback': {
          model: fallbackModel,
          maxOutputTokens: 700,
          timeout: '12s',
          retry: false,
        },
      },
      defaults: {
        maxSteps: 3,
        maxOutputTokens: 700,
        timeout: '15s',
      },
    }),
  ],
  controllers: [AgentController],
  providers: [
    KnowledgeRepositoryService,
    PortfolioToolsProvider,
    PortfolioAgentService,
    HmacOriginGuard,
    RateLimitGuard,
  ],
  exports: [PortfolioAgentService, PortfolioToolsProvider, KnowledgeRepositoryService],
})
export class AppModule {}
