import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  type AgentChatRequestDto,
  type AgentChatResponseDto,
  PortfolioAgentService,
} from '../application/portfolio-agent.service.js';
import { HmacOriginGuard } from '../infrastructure/security/hmac-origin.guard.js';
import { RateLimitGuard } from '../infrastructure/security/rate-limit.guard.js';

@Controller()
export class AgentController {
  constructor(
    @Inject(PortfolioAgentService)
    private readonly agentService: PortfolioAgentService
  ) {}

  @Get('health')
  getHealth() {
    return {
      status: 'operational',
      service: 'api-santiago-jv',
      framework: 'NestJS 12 + @nestjs/ai',
      security: {
        hmacServerToServer: true,
        promptInjectionShield: true,
        dualWindowRateLimit: true,
        aiGatewayReady: Boolean(
          process.env.CLOUDFLARE_AI_GATEWAY_GOOGLE_URL ||
            process.env.CLOUDFLARE_AI_GATEWAY_GROQ_URL ||
            process.env.AI_GATEWAY_MODEL
        ),
      },
      tools: ['list_knowledge_topics', 'query_knowledge_base'],
    };
  }

  @Post('v1/agent/chat')
  @HttpCode(HttpStatus.OK)
  @UseGuards(HmacOriginGuard, RateLimitGuard)
  async chat(@Body() body: AgentChatRequestDto): Promise<AgentChatResponseDto> {
    return this.agentService.chat(body);
  }
}
