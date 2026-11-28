import crypto from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

const MAX_TIMESTAMP_DRIFT_MS = 60_000;
const MAX_SEEN_SIGNATURES = 4_000;
const TIMESTAMP_REGEX = /^\d{13}$/;
const HEX_SHA256_REGEX = /^[0-9a-f]{64}$/i;

const seenSignatures = new Map<string, number>();

export function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyCloudflareOriginToken(
  tokenHeader: string | undefined,
  expectedSecret = process.env.CF_ORIGIN_SECRET?.trim(),
): boolean {
  if (!expectedSecret) {
    return false;
  }
  if (!tokenHeader) {
    return false;
  }
  return constantTimeStringEqual(tokenHeader.trim(), expectedSecret);
}

export function computeHmacSignature(
  timestamp: string,
  payloadJson: string,
  secret: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payloadJson}`, 'utf8')
    .digest('hex');
}

export function computeHmacSignatureV2(
  timestamp: string,
  clientIp: string,
  payloadJson: string,
  secret: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${clientIp}.${payloadJson}`, 'utf8')
    .digest('hex');
}

export function verifyHmacSignature(
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  payloadJson: string,
  secret: string,
  now = Date.now(),
  clientIp?: string,
  version: '1' | '2' = '1',
): boolean {
  if (!timestampHeader || !signatureHeader || !secret) {
    return false;
  }

  const cleanTs = timestampHeader.trim();
  const cleanSig = signatureHeader.trim();

  if (!TIMESTAMP_REGEX.test(cleanTs) || !HEX_SHA256_REGEX.test(cleanSig)) {
    return false;
  }

  const parsedTs = Number.parseInt(cleanTs, 10);
  if (!Number.isFinite(parsedTs) || Math.abs(now - parsedTs) > MAX_TIMESTAMP_DRIFT_MS) {
    return false;
  }

  const expectedHex =
    version === '2'
      ? computeHmacSignatureV2(cleanTs, (clientIp || '').trim(), payloadJson, secret)
      : computeHmacSignature(cleanTs, payloadJson, secret);

  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const actualBuf = Buffer.from(cleanSig, 'hex');
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

export function isReplaySignature(key: string, now = Date.now()): boolean {
  if (seenSignatures.size > MAX_SEEN_SIGNATURES) {
    for (const [entryKey, expiresAt] of seenSignatures.entries()) {
      if (expiresAt <= now) {
        seenSignatures.delete(entryKey);
      }
    }
    while (seenSignatures.size > MAX_SEEN_SIGNATURES) {
      const oldest = seenSignatures.keys().next().value;
      if (!oldest) break;
      seenSignatures.delete(oldest);
    }
  }

  const existing = seenSignatures.get(key);
  if (existing && existing > now) {
    return true;
  }

  seenSignatures.set(key, now + MAX_TIMESTAMP_DRIFT_MS);
  return false;
}

export function resetSeenSignaturesForTests(): void {
  seenSignatures.clear();
}

export function isAllowedFrontendOrigin(
  originHeader: string | undefined,
  allowedOriginsEnv?: string,
  isProd = process.env.NODE_ENV === 'production',
): boolean {
  const configured = [
    ...(allowedOriginsEnv || process.env.ALLOWED_ORIGINS || '').split(','),
    'https://ai.santiago-jv.tech',
    'https://www.santiago-jv.tech',
  ]
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean);

  if (!originHeader) {
    // Missing Origin is permitted only for authenticated server-to-server calls (HMAC verified below)
    return true;
  }

  const normalizedOrigin = originHeader.trim().toLowerCase();
  if (configured.includes(normalizedOrigin)) {
    return true;
  }

  if (
    !isProd &&
    (normalizedOrigin.startsWith('http://localhost:') ||
      normalizedOrigin.startsWith('http://127.0.0.1:'))
  ) {
    return true;
  }

  return false;
}

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
  _verifiedClientIp?: string;
  _cfOriginVerified?: boolean;
}

@Injectable()
export class HmacOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<GuardedRequest>();

    const origin = this.readHeader(req.headers, 'origin');
    const isProd = process.env.NODE_ENV === 'production';

    const cfSecret = process.env.CF_ORIGIN_SECRET?.trim();
    const cfToken = this.readHeader(req.headers, 'x-santiago-origin-token');
    const cfVerified = verifyCloudflareOriginToken(cfToken, cfSecret);
    req._cfOriginVerified = cfVerified;

    if (isProd && cfSecret && !cfVerified) {
      throw new ForbiddenException({
        ok: false,
        code: 'FORBIDDEN_DIRECT_ORIGIN',
        message: 'Direct origin access is forbidden. Route requests through api.santiago-jv.tech.',
      });
    }

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
    const sigVersionHeader = this.readHeader(req.headers, 'x-santiago-sig-version')?.trim();
    const clientIpHeader = this.readHeader(req.headers, 'x-client-ip')?.trim();
    const rawBodyString =
      Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0
        ? req.rawBody.toString('utf8')
        : JSON.stringify(req.body ?? {});

    const requireV2 =
      process.env.HMAC_REQUIRE_V2 === 'true' ||
      (isProd && process.env.HMAC_REQUIRE_V2 !== 'false');
    const isV2 = sigVersionHeader === '2';

    if (requireV2 && !isV2) {
      throw new UnauthorizedException({
        ok: false,
        code: 'INVALID_HMAC_SIGNATURE',
        message: 'Direct external API calls are forbidden. Use ai.santiago-jv.tech.',
      });
    }

    const valid = isV2
      ? verifyHmacSignature(timestamp, signature, rawBodyString, secret, Date.now(), clientIpHeader || '', '2')
      : verifyHmacSignature(timestamp, signature, rawBodyString, secret, Date.now(), undefined, '1');

    if (!valid) {
      throw new UnauthorizedException({
        ok: false,
        code: 'INVALID_HMAC_SIGNATURE',
        message: 'Direct external API calls are forbidden. Use ai.santiago-jv.tech.',
      });
    }

    const replayKey = `${timestamp}:${signature}`;
    if (isReplaySignature(replayKey)) {
      throw new UnauthorizedException({
        ok: false,
        code: 'REPLAY_DETECTED',
        message: 'Replayed signature rejected.',
      });
    }

    if (isV2 && clientIpHeader) {
      req._verifiedClientIp = clientIpHeader;
    }

    return true;
  }

  private readHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string,
  ): string | undefined {
    const val = headers[key] ?? headers[key.toLowerCase()];
    return Array.isArray(val) ? val[0] : val;
  }
}
