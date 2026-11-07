import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

export interface DualRateLimitDecision {
  allowed: boolean;
  minuteLimit: number;
  minuteRemaining: number;
  hourLimit: number;
  hourRemaining: number;
  retryAfterSeconds: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * 60_000;
const MAX_TRACKED_IPS = 4_000;

const ipTimestamps = new Map<string, number[]>();

export function checkDualRateLimit(
  ip: string,
  minuteLimit = 8,
  hourLimit = 30,
  now = Date.now()
): DualRateLimitDecision {
  if (ipTimestamps.size > MAX_TRACKED_IPS) {
    for (const [key, list] of ipTimestamps.entries()) {
      const fresh = list.filter((ts) => now - ts < HOUR_MS);
      if (fresh.length === 0) ipTimestamps.delete(key);
      else ipTimestamps.set(key, fresh);
    }
  }

  const history = (ipTimestamps.get(ip) || []).filter((ts) => now - ts < HOUR_MS);
  const lastMinute = history.filter((ts) => now - ts < MINUTE_MS);

  if (lastMinute.length >= minuteLimit) {
    ipTimestamps.set(ip, history);
    const oldestInMinute = lastMinute[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - now) / 1000));
    return {
      allowed: false,
      minuteLimit,
      minuteRemaining: 0,
      hourLimit,
      hourRemaining: Math.max(0, hourLimit - history.length),
      retryAfterSeconds,
    };
  }

  if (history.length >= hourLimit) {
    ipTimestamps.set(ip, history);
    const oldestInHour = history[0] ?? now;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInHour + HOUR_MS - now) / 1000));
    return {
      allowed: false,
      minuteLimit,
      minuteRemaining: Math.max(0, minuteLimit - lastMinute.length),
      hourLimit,
      hourRemaining: 0,
      retryAfterSeconds,
    };
  }

  history.push(now);
  ipTimestamps.set(ip, history);

  return {
    allowed: true,
    minuteLimit,
    minuteRemaining: Math.max(0, minuteLimit - (lastMinute.length + 1)),
    hourLimit,
    hourRemaining: Math.max(0, hourLimit - history.length),
    retryAfterSeconds: 0,
  };
}

export function resetDualRateLimiterForTests(): void {
  ipTimestamps.clear();
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      ip?: string;
    }>();
    const res = context.switchToHttp().getResponse<{
      setHeader?: (name: string, value: string) => void;
    }>();

    const forwardedClientIp =
      this.readHeader(req.headers, 'x-client-ip') ||
      this.readHeader(req.headers, 'cf-connecting-ip') ||
      this.readHeader(req.headers, 'x-forwarded-for')?.split(',')[0]?.trim() ||
      req.ip ||
      'unknown-ip';

    const minuteMax = Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE || '8', 10) || 8;
    const hourMax = Number.parseInt(process.env.RATE_LIMIT_PER_HOUR || '30', 10) || 30;

    const decision = checkDualRateLimit(forwardedClientIp, minuteMax, hourMax);

    res.setHeader?.('X-RateLimit-Limit-Minute', String(decision.minuteLimit));
    res.setHeader?.('X-RateLimit-Remaining-Minute', String(decision.minuteRemaining));
    res.setHeader?.('X-RateLimit-Limit-Hour', String(decision.hourLimit));
    res.setHeader?.('X-RateLimit-Remaining-Hour', String(decision.hourRemaining));

    if (!decision.allowed) {
      res.setHeader?.('Retry-After', String(decision.retryAfterSeconds));
      throw new HttpException(
        {
          ok: false,
          code: 'RATE_LIMITED',
          message: `Rate limit reached. Please wait ${decision.retryAfterSeconds}s before sending another message.`,
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    return true;
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string
  ): string | undefined {
    const val = headers[key] ?? headers[key.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  }
}
