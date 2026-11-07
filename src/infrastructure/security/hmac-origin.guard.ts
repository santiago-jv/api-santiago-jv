import crypto from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

const MAX_TIMESTAMP_DRIFT_MS = 60_000;

export function computeHmacSignature(
  timestamp: string,
  payloadJson: string,
  secret: string
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payloadJson}`, 'utf8')
    .digest('hex');
}

export function verifyHmacSignature(
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  payloadJson: string,
  secret: string,
  now = Date.now()
): boolean {
  if (!timestampHeader || !signatureHeader || !secret) {
    return false;
  }

  const parsedTs = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(parsedTs) || Math.abs(now - parsedTs) > MAX_TIMESTAMP_DRIFT_MS) {
    return false;
  }

  const expectedHex = computeHmacSignature(timestampHeader, payloadJson, secret);
  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = Buffer.from(signatureHeader.trim(), 'hex');
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export function isAllowedFrontendOrigin(
  originHeader: string | undefined,
  allowedOriginsEnv?: string,
  isProd = process.env.NODE_ENV === 'production'
): boolean {
  const configured = (
    allowedOriginsEnv ||
    process.env.ALLOWED_ORIGINS ||
    'https://ai.santiago-jv.tech,https://www.santiago-jv.tech,https://ai-santiago-jv.vercel.app'
  )
    .split(',')
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  if (!originHeader) {
    // Allow missing Origin only when HMAC signature is present (server-to-server) or in local dev
    return true;
  }

  const normalizedOrigin = originHeader.trim().toLowerCase();
  if (configured.includes(normalizedOrigin)) {
    return true;
  }

  if (!isProd && (normalizedOrigin.startsWith('http://localhost:') || normalizedOrigin.startsWith('http://127.0.0.1:'))) {
    return true;
  }

  return false;
}

@Injectable()
export class HmacOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
    }>();

    const origin = this.readHeader(req.headers, 'origin');
    const isProd = process.env.NODE_ENV === 'production';

    if (!isAllowedFrontendOrigin(origin, process.env.ALLOWED_ORIGINS, isProd)) {
      throw new ForbiddenException({
        ok: false,
        code: 'FORBIDDEN_ORIGIN',
        message: 'Access restricted exclusively to ai.santiago-jv.tech.',
      });
    }

    const secret = process.env.INTERNAL_HMAC_SECRET?.trim();
    if (!secret) {
      if (!isProd) {
        return true;
      }
      throw new UnauthorizedException({
        ok: false,
        code: 'MISSING_SERVER_SECRET',
        message: 'Server-to-server authentication is not configured.',
      });
    }

    const timestamp = this.readHeader(req.headers, 'x-santiago-timestamp');
    const signature = this.readHeader(req.headers, 'x-santiago-signature');
    const canonicalBody = JSON.stringify(req.body ?? {});

    if (!verifyHmacSignature(timestamp, signature, canonicalBody, secret)) {
      throw new UnauthorizedException({
        ok: false,
        code: 'INVALID_HMAC_SIGNATURE',
        message: 'Direct external API calls are forbidden. Use ai.santiago-jv.tech.',
      });
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
