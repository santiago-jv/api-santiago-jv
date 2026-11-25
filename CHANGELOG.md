# Changelog

All notable changes to `api-santiago-jv` (`https://api.santiago-jv.tech`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-11-25

### Bug Fixes

- fix(ci): enable automated tag releases and changelog generation (`15d63a1`)
## [2.0.0] - 2026-11-24

### Features

- Initialize NestJS AI agent backend with tool-calling portfolio & recruiter evaluation engine (`5a4844e`).
- Deploy hybrid `pgvector` + full-text RAG pipeline on Neon Postgres with HMAC-SHA256 v2 IP-bound signatures, Cloudflare origin lock, and TLS hardening (`b82fcc3`).
- Add Neon Postgres `site_config` remote configuration table with smart `primary_domain` cascade, `GET /v1/config/public` edge-cached endpoint, and live LLM prompt override injection (`d267aee`).
- Add multi-turn conversation history and relevance section ranking (`08ad44c`).

### Bug Fixes

- Enforce mandatory 3-tier RAG grounding fallback (`gemini-2.5-flash` fallback, programmatic search synthesis, and honest gap rules) (`c21d936`, `8637508`).
- Add `Transfiya` to RAG chunker tech tags and enforce latest-turn reply language parity (`90002d5`).
- Export Vercel Fluid Compute root handler in `src/main.ts` and normalize `sslmode=verify-full` (`c3e8e1c`).
- Allow up to 20 tool topics for vacancy evaluation and prevent empty reasoning replies (`b8bfd82`).

### Performance & Documentation

- Enforce concise 2-4 sentence answers without markdown tables (`eeef68e`).
- Update `@santiagojvtech` X links and synchronize architecture documentation in `README.md` (`1f022ac`).
