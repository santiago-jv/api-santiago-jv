import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rootDir = path.resolve(import.meta.dirname, '..');
const privateDir = path.join(rootDir, '.private');

const promptPath = path.join(privateDir, 'system-prompt.txt');
const kbPath = path.join(privateDir, 'knowledge-base.md');

if (!fs.existsSync(promptPath) || !fs.existsSync(kbPath)) {
  console.error(
    'Missing .private/system-prompt.txt or .private/knowledge-base.md. Create them locally before packing.'
  );
  process.exit(1);
}

const promptB64 = Buffer.from(fs.readFileSync(promptPath, 'utf8'), 'utf8').toString('base64');
const kbB64 = Buffer.from(fs.readFileSync(kbPath, 'utf8'), 'utf8').toString('base64');
const sampleHmacSecret = crypto.randomBytes(32).toString('hex');

console.log('# === Copy and paste these into Vercel Environment Variables ===\n');
console.log(`INTERNAL_HMAC_SECRET=${sampleHmacSecret}\n`);
console.log(`AGENT_SYSTEM_PROMPT_B64=${promptB64}\n`);
console.log(`KNOWLEDGE_BASE_MD_B64=${kbB64}\n`);
