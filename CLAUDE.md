# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

IPRS Platform Backend for an AI-powered onboarding & Q&A chatbot platform (musicians joining IPRS).

**Implemented**: auth (OTP/JWT), user + registration modules, document upload with real OCR
(`ocr.choira.io`) for PAN/Aadhaar/bank, and the onboarding conversation (`conversation` module).
The frontend talks only to this backend. The flow runs **inside this backend** (no Typebot server):
`services/flow/flowEngine.js` runs the Typebot export committed at
`src/modules/conversation/flow/registrationFlow.json`, with Typebot's ids and response shapes. See
`AGENTS.md`'s "Built-in flow engine", "Typebot Registration Flow" and "Conversation Router" sections
for the full architecture and API contracts; this file stays at the orientation level.

**Still out of scope / later milestones**: the AI Q&A chatbot itself (RAG/vector DB/tool calling —
`aiEngine.js` is still a stub, reachable only once `ApplicationStatus === 1`), WhatsApp channel
integration, staff dashboard, payments, escalation. Don't implement these without being asked.

Note: `README.md` describes an earlier MySQL-based design; the project has since moved to SQL Server. `AGENTS.md` and `prisma/schema.prisma` reflect the current, real state — trust those over the README.

## Stack

- **Node.js 20+** (ES Modules, `"type": "module"` — imports require explicit `.js` extensions)
- **Express 4**
- **Prisma ORM 5** (pinned — do not upgrade to v6/v7, breaking change with no benefit here) + **SQL Server** (local named instance `SQLEXPRESS01`, DB `Dreamsoft_UAT`)
- **JWT** (`jsonwebtoken`), **Zod** validation
- **Helmet**, **CORS**, **express-rate-limit**, **multer** (memory storage, only on `POST /conversation/upload`)
- **Pino / pino-http** logging
- **bcryptjs**, **http-status-codes**, **dotenv**
- Real external services: **`ocr.choira.io`** (PAN/Aadhaar/bank OCR), **`spotify.choira.in`** (role-labelled song credits for Spotify + YouTube work links) — all via plain `fetch`, no SDK. The onboarding flow itself has no external dependency (built-in flow engine).
- Tests via **`node:test`**

## Commands

```bash
npm run dev              # node --watch src/server.js
npm start                # production boot
npm test                 # node:test against "test/**/*.test.js"
npm run prisma:migrate   # prisma migrate dev
npm run prisma:generate  # prisma generate
npm run prisma:studio    # prisma studio
npm run setup:db         # enable SQL Server TCP/SQL auth, create Dreamsoft_UAT + iprs_app login, write DATABASE_URL to .env
```

Run a single test file directly, e.g. `node --test test/smoke.test.js`.

- Always run `npm test` (and `node --check <file>` on any file you touch) before finishing.
- No linter/formatter/typecheck is configured — don't hunt for ESLint/Prettier config. `node --check` + `npm test` are the only verification available.
- `setup:db` is a Windows-only PowerShell script (`scripts/setup-db.ps1`) that must be run **as Administrator**. It assumes local SQL Server instance `SQLEXPRESS01` and rewrites `DATABASE_URL` in `.env`. After it runs, import the schema from the production dump: `sqlcmd -S tcp:localhost,1433 -U iprs_app -P iprs_app -C -d Dreamsoft_UAT -i scripts/mra_cleaned.sql`.
- DB-dependent tests auto-skip when SQL Server is unreachable, so `npm test` is safe to run without a live DB — but full coverage (including the auth round-trip against `/registration/status` and `/conversation/message`) requires the live instance set up as above. That round-trip also asserts the response echoes the OTP, so it requires `OTP_PROVIDER=mock` (the default).

## Architecture & Data Flow

```
Route → Controller → Service → Repository → Prisma → SQL Server
```

Layering rules (non-negotiable):
- **Controllers**: thin. Parse already-validated input, call a service, format response via `shared/response.js`. No business logic.
- **Services**: all business logic (use cases, orchestration, throwing `AppError`s).
- **Repositories**: data access only. No validation, no business logic.
- **Validators**: Zod schemas only.

Each module (`src/modules/*`) is self-contained (own routes/controllers/services/repositories/validators). Extend the system by adding new modules rather than growing cross-module dependencies. Prefer calling another module's *service* over its repository when a cross-module call is genuinely needed (see AGENTS.md's "Conventions to preserve").

### Folder layout

```
src/
├─ config/          env.js (Zod-validated env loader)
├─ shared/          prisma.js, response.js, errors.js, errorHandler.js, validate.js, asyncHandler.js
├─ utils/           logger.js (Pino), token.js (JWT)
├─ middlewares/     auth.js (JWT - also attaches req.token), rateLimiter.js
├─ modules/
│  ├─ auth/         services/otp/{interface,factory,mock,msg91} + tokenBlacklist.js
│  ├─ user/         controllers/services/repositories/validators
│  ├─ registration/ controllers/services/repositories/validators + services/ocr/{interface,factory,http,stub}
│  ├─ conversation/ services/{conversation.router,conversationJournal,typebot/*} + engines/{aiEngine,registrationEngine}.js + repositories/
│  ├─ work/         services/{workLinkResolver,musicCredits,youtube,gemini,workLink,workMatch}.service.js
│  └─ health/
├─ app.js           middleware + route assembly (order: security → parsing → logging → routes → 404 → errors)
└─ server.js        DB connectivity check (fail-fast) + bootstrap + graceful shutdown
prisma/             schema.prisma (no migrations/ folder — schema is db-pushed, not migrated, see AGENTS.md)
scripts/            setup-db.ps1, mra_cleaned.sql
test/               smoke.test.js
```

## Code Conventions

- `async`/`await` everywhere; Node 20+, ESM with explicit `.js` extensions on all imports.
- Private class methods (`#method`) for internal helpers on services.
- Follow SOLID, keep modules loosely coupled; use dependency injection where it aids testability.
- Route routers use `default` export; everything else uses named exports.
- Classes are used for services/repositories; no decorators.
- Comments only where they clarify intent — don't narrate obvious code.
- Reuse shared helpers; don't duplicate logic across modules.

## Response & Error Conventions

**Success shape** (`shared/response.js`):
```json
{ "success": true, "data": { ... }, "meta"? }
```
Use `ok(res, { data, meta?, status? })`, `created(res, data)`, `accepted(res)`.

**Error shape** (`shared/errorHandler.js`):
```json
{ "success": false, "error": { "code": "...", "message": "...", "details"? } }
```

**Error factories** in `src/shared/errors.js` (function-based; each returns a real `Error` shaped for the central handler):
- `badRequestError` (400, `BAD_REQUEST`)
- `unauthorizedError` (401, `UNAUTHORIZED`)
- `forbiddenError` (403, `FORBIDDEN`)
- `notFoundError` (404, `NOT_FOUND`)
- `conflictError` (409, `CONFLICT`)
- `validationError` (422, `VALIDATION_ERROR`)
- `appError` (generic; default 500, `INTERNAL_ERROR`)

Central handler (`shared/errorHandler.js`) maps:
- Zod errors → 422 `VALIDATION_ERROR` (with `details`)
- Prisma `P2002` → 409, `P2025` → 404, `P2003`/`P2014` → 400, other known → 500
- JWT verify failures → 401 (raised in `middlewares/auth.js`)
- Malformed JSON body → 400
- Unknown errors → sanitized 500 (never leak internals); logged with full stack

Every route is wrapped with `asyncHandler` (Express 4 doesn't catch rejected promises on its own).

Keep the response envelope, error codes, and status codes consistent — don't introduce ad-hoc response shapes.

## Validation Middleware

`src/shared/validate.js` reads `schema.shape`, **not** `schema.body` — schemas are objects shaped `{ body?, query?, params? }`:
```js
router.post('/x', validate(someSchema), controller.handler);
```
Always call `.parse` (not `.safeParse`); a thrown `ZodError` is caught by `asyncHandler`/central handler and turned into a 422.

## Auth & Middleware

- `authenticate` (JWT) middleware sets `req.user = { id, phone, registrationStatus }`. Apply it to any protected route.
- Blacklist-aware logout lives in the auth service (`modules/auth/services/tokenBlacklist.js`, in-memory for now).
- Rate limits: global limiter + a stricter auth limiter, both in `middlewares/rateLimiter.js`, configurable via env.

## Environment / Config

- `config/env.js` reads `.env` and validates via Zod, failing fast on boot. **Adding an env var means updating three places: `.env`, `.env.example`, and `envSchema` in `config/env.js`.**
- Key vars: `PORT`, `DATABASE_URL`, `JWT_SECRET` (≥16 chars), `JWT_EXPIRES_IN`, `JWT_ISSUER`, `CORS_ORIGIN`, `OTP_PROVIDER` (`mock`|`sms`), `OTP_TTL_SECONDS`, `OTP_MOCK_VALUE` (dev-only fixed OTP), `MSG91_AUT_KEY`, `MSG91_TEMP_ID`, `MSG91_OTP_LENGTH`, `MSG91_OTP_EXPIRY`, plus global/auth rate-limit values.
- OCR: `OCR_PROVIDER` (`http`|`stub`), `OCR_API_BASE_URL`, `OCR_REQUEST_TIMEOUT_MS`.
- Music credits: `MUSIC_CREDITS_API_BASE_URL` (default `https://spotify.choira.in`),
  `MUSIC_CREDITS_REQUEST_TIMEOUT_MS`, `MUSIC_CREDITS_ENABLED` (kill-switch) — the role-labelled
  credits source behind `Author_Composer`/`Author_Lyricist`, see AGENTS.md's "Music Credits Service".
- Chat uploads: `UPLOAD_DIR` (kept on this server), served at `DOCUMENT_LINK_BASE_URL/uploads/<token>/<file>` — so `DOCUMENT_LINK_BASE_URL` must be the API's public address (OCR downloads from it); `MAX_UPLOAD_SIZE_MB`.
- Never commit real `.env` (git-ignored); keep `.env.example` in sync with any new key.

## Prisma

- `prisma/schema.prisma` is generated from the live DB via `npx prisma db pull` (13 tables imported from `scripts/mra_cleaned.sql` into `Dreamsoft_UAT`). When the DB changes, re-run `db pull` rather than hand-editing the schema.
- The "user" table is `App_Accounts` (`@@map("App_Accounts")`), Prisma model `AppAccounts`. PK `AccountId` is SQL Server `bigint` → Prisma `BigInt` — stringify ids before putting them in JWTs or route params.
- `AccountMobile` is the OTP login identifier. `ApplicationStatus` (1 = completed) drives registration/conversation routing.
- Field names mirror DB columns exactly (PascalCase, e.g. `AccountName`, `AccountMobile_Alt`) — verify against `npx prisma db pull` output rather than hand-writing field names.
- `@db.Money` columns are typed `Float` in Prisma, not `Decimal`.
- No `prisma/migrations/` folder exists — schema comes from the production dump. For an additive
  change (e.g. `AppAccounts.PANNo`, added for OCR), use `npx prisma db push`, not `prisma migrate
  dev` — the `iprs_app` DB user lacks the `CREATE DATABASE` permission the migrate workflow's
  shadow database needs. Schema changes still require confirming first that no existing column can
  hold the data — see AGENTS.md's Prisma and "Typebot Registration Flow" sections.
- Use the shared singleton from `shared/prisma.js` in repositories (not `new PrismaClient()` per module). It exposes `pingDatabase()` (a `SELECT 1` probe) used by `server.js` at boot and by the health service.

## Pluggable Providers (design extension points)

- **OTP**: `modules/auth/services/otp/otpProvider.interface.js` defines the contract; `mockOtpProvider.js` (default, echoes OTP in dev) and `otpProvider.factory.js` selects the implementation by the `OTP_PROVIDER` env var. `msg91OtpProvider.js` is the real SMS implementation. Adding a new provider means implementing the interface and updating the factory — never touch controllers/services to swap providers.
- **Token blacklist**: `modules/auth/services/tokenBlacklist.js` is in-memory now; a later milestone swaps it for Redis behind the same interface.
- **OCR**: `modules/registration/services/ocr/` — same interface+factory pattern, selected by `OCR_PROVIDER`. `httpOcrProvider.js` (default) calls the real `ocr.choira.io` service for PAN/Aadhaar/bank only; `stubOcrProvider.js` always throws, for offline dev.

## Conversation Router

`modules/conversation/services/conversation.router.js` decides engine by `user.ApplicationStatus === 1` (→ `AIEngine`, still a Week 1 stub — leave it) vs everything else (→ `RegistrationEngine`, driving the built-in flow engine).

`registrationEngine.js`'s `handle()` calls `typebotClient.startChat` (new session) or `continueChat` (existing session, tracked in `typebotSessionStore.js`) and returns the response close to as-received. `typebotClient.js` keeps its old name and methods, but now calls `services/flow/flowEngine.js` (the flow file) and `services/flow/uploadStorage.js` (files on this server) — no Typebot server. To change a question, edit `flow/registrationFlow.json` (or drop in a new Typebot export) and run `npm run build:progress-map`. `handleUpload()` handles a raw file from `POST /conversation/upload`: reserves a stored name (`generateUploadUrl`), writes the bytes, and — the key point — **saves the document itself** via `registrationService.saveDocument()` (same OCR + persistence as the registration module's own `/documents/:documentType` route) rather than relying on Typebot's Studio flow to call back into this API. Full detail, including the exact Typebot Chat API contract, is in AGENTS.md's "Typebot Registration Flow" and "Conversation Router" sections — read those before touching this module.
