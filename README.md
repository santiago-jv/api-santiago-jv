# Santiago Olayo — `@nestjs/ai` Agent Backend (`api.santiago-jv.tech`)

Production **NestJS 12 + `@nestjs/ai`** backend powering the interactive AI recruiter and engineering assistant at **[ai.santiago-jv.tech](https://ai.santiago-jv.tech)** and **[www.santiago-jv.tech](https://www.santiago-jv.tech)**.

---

## Architecture (Hexagonal / Ports & Adapters)

```text
src/
├── domain/                         # Pure domain logic & private knowledge loading
│   ├── knowledge-repository.service.ts  # Loads prompt & markdown from Base64 env vars or private URL
│   └── vacancy-matcher.service.ts       # Deterministic 0-100 vacancy fit scoring engine
├── application/                    # @nestjs/ai orchestration & @AgentFunction() tools
│   ├── portfolio-tools.provider.ts      # @AgentFunction: search_knowledge_base, evaluate_vacancy_match, get_contact_and_resumes
│   └── portfolio-agent.service.ts       # Agent run loop, AI Gateway routing, LRU cache & sandboxing
├── infrastructure/                 # Edge & HTTP security guards
│   └── security/
│       ├── hmac-origin.guard.ts         # Origin allowlist + HMAC-SHA256 + 60s replay protection
│       ├── rate-limit.guard.ts          # Dual-window per-IP rate limiter (minute + hour buckets)
│       └── prompt-injection.guard.ts    # Pre-LLM heuristic inspection + XML sandboxing + output sanitizer
├── presentation/                   # HTTP Controllers
│   └── agent.controller.ts              # GET /v1/health, POST /v1/agent/chat
├── app.module.ts                   # AiModule.forRoot (Gemini 2.5 Flash + Groq Llama 3.3 70B fallback)
└── main.ts                         # NestJS bootstrap
```

---

## Zero Prompts / Zero Private Markdown in Git

Because this repository (`https://github.com/santiago-jv/api-santiago-jv`) is **public**, **no real system prompts or knowledge-base markdown files are committed to Git**:

1. Local private authoring files live inside `.private/system-prompt.txt` and `.private/knowledge-base.md` (strictly ignored via `.gitignore`).
2. Run `npm run pack:secrets` locally to encode `.private/*` into single-line Base64 environment variables (`AGENT_SYSTEM_PROMPT_B64` and `KNOWLEDGE_BASE_MD_B64`) or host the markdown at a private URL (`KNOWLEDGE_BASE_URL` + `KNOWLEDGE_BASE_BEARER_TOKEN`).
3. An automated test in `test/api-santiago-jv.test.ts` fails CI if any `.md`, `.txt`, or `.prompt` file is ever placed inside `src/`.

---

## 6-Layer Security & Anti-Abuse Architecture

1. **Cloudflare WAF + AI Gateway (`api.santiago-jv.tech`):** TLS termination, bot mitigation, and optional provider-level caching/rate limiting via `GOOGLE_AI_GATEWAY_BASE_URL` / `GROQ_AI_GATEWAY_BASE_URL` or `AI_GATEWAY_API_KEY`.
2. **Origin & HMAC-SHA256 Gatekeeper (`HmacOriginGuard`):** Only `https://ai.santiago-jv.tech` (server-side route `/api/chat`) holds `INTERNAL_HMAC_SECRET`. Every request must carry `X-Santiago-Timestamp` (within a 60-second replay window) and `X-Santiago-Signature = HMAC_SHA256(secret, "${timestamp}.${rawBody}")`. Direct curl/Postman calls from external origins are rejected with `401`/`403`.
3. **Dual-Window Per-IP Rate Limiting (`RateLimitGuard`):** Enforces 8 requests/minute and 30 requests/hour per client IP (`CF-Connecting-IP` / `X-Forwarded-For`), returning `429 Too Many Requests` with `Retry-After`.
4. **Pre-LLM Prompt Injection Inspection (`inspectAndSandboxUserMessage`):** Blocks instruction-override, system-prompt extraction, role-hijacking, and XML tag-breakout attempts in English and Spanish **before spending a single LLM token**.
5. **XML Delimiter Sandboxing & Read-Only `@AgentFunction` Tools:** User messages are wrapped in `<untrusted_recruiter_input>...</untrusted_recruiter_input>` with `maxSteps: 3` and `maxOutputTokens: 650`. Tools have zero shell, filesystem-write, database-write, or outbound network mutation capabilities.
6. **Output Leak Sanitizer (`sanitizeModelOutput`):** Scans generated responses for internal canary markers before returning to the client.

---

## Local Development & Verification

```bash
# Install dependencies
npm install

# Generate Base64 environment variables from .private/
npm run pack:secrets

# Run TypeScript check, test suite, and build
npm run typecheck
npm test
npm run build
```
