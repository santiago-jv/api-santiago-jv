import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rootDir = path.resolve(import.meta.dirname, '..');
const privateDir = path.join(rootDir, '.private');
const promptPath = path.join(privateDir, 'system-prompt.txt');

if (!fs.existsSync(promptPath)) {
  console.error('Missing .private/system-prompt.txt. Create it locally before packing.');
  process.exit(1);
}

const promptB64 = Buffer.from(fs.readFileSync(promptPath, 'utf8'), 'utf8').toString('base64');
const sampleHmacSecret = crypto.randomBytes(32).toString('hex');

console.log('# === Copy and paste these into Vercel Environment Variables ===\n');
console.log(`INTERNAL_HMAC_SECRET=${sampleHmacSecret}\n`);
console.log(`AGENT_SYSTEM_PROMPT_B64=${promptB64}\n`);
console.log('# Knowledge documents are stored in PostgreSQL + pgvector (set DATABASE_URL and run `npm run db:migrate && npm run ingest`).');
