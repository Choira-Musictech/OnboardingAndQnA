# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

IPRS Platform Backend for an AI-powered onboarding & Q&A chatbot platform (musicians joining IPRS).

**Implemented**: auth (OTP/JWT), user + registration modules, document upload with real OCR
(`ocr.choira.io`) for PAN/Aadhaar/bank, a backend-driven Typebot relay (`conversation` module)
that drives the onboarding conversation via Typebot's Chat API, work-link collection with
role-labelled credits (Spotify/YouTube) verified against the member's own name, a pre-payment
review, and resuming an abandoned registration from a persisted journal.

**Still out of scope / later milestones**: actual payment processing (only the review screen before
the payment button exists), the AI Q&A chatbot itself (RAG/vector DB/tool calling —
`aiEngine.js` is still a stub, only reachable once `ApplicationStatus === 1`), WhatsApp channel
integration, staff dashboard, escalation. Don't implement these without being asked.

## Stack

- **Node.js 20+** (ES Modules, `"type": "module"`)
- **Express 4**
- **Prisma ORM 5 + SQL Server** (local instance `SQLEXPRESS01`, DB `Dreamsoft_UAT`)
- **JWT** (`jsonwebtoken`), **Zod** validation
- **Helmet**, **CORS**, **express-rate-limit**
- **Pino / pino-http** logging
- **bcryptjs**, **http-status-codes**, **dotenv**
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
npm run build:progress-map # regenerate progressMap.js from the live published Typebot flow - run after EVERY Studio republish
```

Run a single test file directly with `node --test test/workMatch.test.js` (etc.).

- Always run `npm test` (and `node --check` on any file you touch) before finishing.
- No linter/formatter/typecheck is configured — don't hunt for ESLint/Prettier. `node --check` + `npm test` are the only verification.
- `setup:db` is a Windows-only PowerShell script (`scripts/setup-db.ps1`) that must be run **as Administrator**.
  It assumes a local SQL Server named instance `SQLEXPRESS01` and rewrites `DATABASE_URL` in `.env`.
  After it runs, import the schema from the production dump: `sqlcmd -S tcp:localhost,1433 -U iprs_app -P iprs_app -C -d Dreamsoft_UAT -i scripts/mra_cleaned.sql`.

## Architecture & Data Flow

```
Route → Controller → Service → Repository → Prisma → SQL Server
```

Layering rules (non-negotiable):
- **Controllers**: thin. Parse already-validated input, call a service, format response via `shared/response.js`. No business logic.
- **Services**: all business logic (use cases, orchestration, throwing `AppError`s).
- **Repositories**: data access only. **No validation, no business logic.**
- **Validators**: Zod schemas only.

### Folder layout
```
src/
├─ config/          env.js (Zod-validated env loader)
├─ shared/          prisma.js, response.js, errors.js, errorHandler.js, validate.js, asyncHandler.js
├─ utils/           logger.js (Pino), token.js (JWT)
├─ middlewares/     auth.js (JWT), rateLimiter.js
├─ modules/
│  ├─ auth/         services/otp/{interface,factory,mock,msg91} + tokenBlacklist.js
│  ├─ user/         repository only - service/controller/routes/validators removed, unused
│  │                (auth.service.js imports user.repository.js directly at login)
│  ├─ registration/  controllers/services/repositories/validators + services/{ocr/*,verify/*,registrationReview.service.js}
│  ├─ conversation/ services/{conversation.router,conversationJournal.service.js,emailOtpGate.js,
│  │                typebot/typebotClient,typebotSessionStore,progressMap,documentTypeMap,
│  │                addressProofTypeMap,conversationFieldMap,workLinkGate,workDetailsGate,paymentGate,verifyGate}.js
│  │                + repositories/{conversationJournal.repository.js}
│  │                + engines/{aiEngine,registrationEngine}.js
│  ├─ work/         services/{workLinkResolver,musicCredits,youtube,gemini,workLink,workMatch}.service.js
│  │                + repositories/work.repository.js
│  ├─ spotify/      standalone POST /spotify/metadata (services/{spotify,spotify.claim}) - legacy, see below
│  └─ health/
├─ app.js           middleware + route assembly (mounts /health, /auth, /registration, /conversation, /spotify)
└─ server.js        DB connectivity check (fail-fast) + bootstrap + graceful shutdown
prisma/             schema.prisma (no migrations/ folder - schema comes from the SQL dump + db push)
scripts/            setup-db.ps1, mra_cleaned.sql, build-progress-map.mjs, add-*.sql (schema-gap scripts - run by hand, NOT db push)
test/               node:test suites - pure-logic tests plus DB-dependent ones that auto-skip
```

Each module is self-contained (its own routes/controllers/services/repositories/validators). Extend by adding modules rather than growing cross-module dependencies.

## Code Conventions

- Use **`async`/`await`** everywhere. Node 20+, ESM.
- Use **ES Modules with `.js` extensions** on all imports (Node ESM requires explicit extensions).
- Use **private class methods** (`#method`) for internal helpers on services.
- Follow **SOLID** and keep modules **loosely coupled**; use dependency injection where it aids testability.
- `default`-export route routers; use named exports elsewhere.
- Add comments only where they clarify intent.
- No code style: decorators (none), classes used for services/repositories.
- Do not duplicate logic — reuse shared helpers.

## Response & Error Conventions

**Success shape** — via `shared/response.js`:
```json
{ "success": true, "data": { ... }, "meta"? }
```
Use `ok(res, { data, meta?, status? })`, `created(res, data)`, `accepted(res)`.

**Error shape** — produced by `shared/errorHandler.js`:
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
- **Zod errors** → 422 `VALIDATION_ERROR` (with `details`)
- **Prisma** `P2002` → 409, `P2025` → 404, `P2003`/`P2014` → 400, other known → 500
- **JWT** verify failures → 401 (raised in `middlewares/auth.js`)
- Malformed JSON body → 400
- Unknown errors → sanitized 500 (never leak internals); logged with full stack.

Routes wrapped with `asyncHandler` (Express 4 doesn't catch rejected promises).

## Validation Middleware

`src/shared/validate.js` uses `schema.shape`, **not** `schema.body`:
```js
router.post('/x', validate(someSchema), controller.handler);
```
Schemas are objects shaped `{ body?, query?, params? }`. Always call `.parse`; Zod throws → central handler returns 422.

## Auth & Middleware

- `authenticate` (JWT) middleware sets `req.user = { id, phone, registrationStatus }`.
- Use it on protected routes. Blacklist-aware logout lives in the auth service.
- Rate limits: global + stricter auth limiter in `middlewares/rateLimiter.js` (configurable via env).

## Environment / Config

- `config/env.js` reads `.env` and validates via Zod (fails fast) — **add env keys to `.env`, `.env.example`, and the `envSchema`**.
- Key vars: `PORT`, `DATABASE_URL`, `JWT_SECRET` (≥16 chars), `JWT_EXPIRES_IN`, `JWT_ISSUER`, `CORS_ORIGIN`,
  `OTP_PROVIDER` (mock|sms), `OTP_TTL_SECONDS`, `OTP_MOCK_VALUE` (dev-only fixed OTP),
  `MSG91_AUT_KEY`, `MSG91_TEMP_ID`, `MSG91_OTP_LENGTH`, `MSG91_OTP_EXPIRY`, plus global/auth rate-limit values.
- OCR: `OCR_PROVIDER` (http|stub), `OCR_API_BASE_URL`, `OCR_REQUEST_TIMEOUT_MS`, `OCR_ENABLED` (blanket kill-switch,
  default true - flip to false when ocr.choira.io is flaky so chat-flow testing can pass uploads).
- Typebot: `TYPEBOT_API_BASE_URL`, `TYPEBOT_ID`, `TYPEBOT_PREVIEW_MODE`, `TYPEBOT_API_TOKEN` (optional),
  `TYPEBOT_REQUEST_TIMEOUT_MS`, `MAX_UPLOAD_SIZE_MB` (multer limit on `POST /conversation/upload`).
- Email/OTP: `EMAIL_OTP_LENGTH/EXPIRY_MINUTES/MAX_ATTEMPTS/RESEND_COOLDOWN_SECONDS`, `SMTP_HOST/PORT/SECURE/USER/PASSWORD`
  (see "Email OTP Verification"), `SUPPORT_CONTACT` (quoted to the member at the payment review when they report an error).
- Work links / credits: `MUSIC_CREDITS_API_BASE_URL` (default `https://spotify.choira.in`), `MUSIC_CREDITS_ENABLED`
  (kill-switch), `MUSIC_CREDITS_REQUEST_TIMEOUT_MS`, `YOUTUBE_REQUEST_TIMEOUT_MS`, `GEMINI_API_KEY/MODEL/REQUEST_TIMEOUT_MS`
  (see "Music Credits Service"); optional `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` (see "Spotify metadata").
- Never commit real `.env` (it's git-ignored); keep `.env.example` in sync.

## Prisma

- `prisma/schema.prisma` is generated from the live DB with `npx prisma db pull` (the 13 tables
  imported from `scripts/mra_cleaned.sql` / `Dreamsoft_UAT`). When the DB changes, re-run `db pull`.
- The "user" table is `App_Accounts` (`@@map("App_Accounts")`), model `AppAccounts`; PK `AccountId` is a
  SQL Server `bigint` → Prisma `BigInt` (stringify ids when putting them in JWTs / route params).
  `AccountMobile` is the OTP login identifier; `ApplicationStatus` (1 = completed) drives registration routing.
  Field names mirror the DB columns (PascalCase, e.g. `AccountName`, `AccountMobile_Alt`) — verify with
  `npx prisma db pull` rather than hand-writing. `@db.Money` columns are typed `Float`, not `Decimal`.
- No migrations are used: the schema is imported from the production dump (`scripts/mra_cleaned.sql`), so
  there is no `prisma/migrations/` folder. For an additive schema change, use `npx prisma db push`
  after editing `schema.prisma` — or better, a plain idempotent SQL script like
  `scripts/add-chat-journal.sql`, which is what IPRS's DBA can actually run against production.
  `prisma:migrate` (`prisma migrate dev`) fails here
  because it needs shadow-database `CREATE DATABASE` permission the `iprs_app` DB user doesn't have.
  This still isn't a green light to add columns freely — every column this app adds is one IPRS has
  to add to their real production database too, so PAN/GST deliberately went into the existing
  generic `Detail2`/`Detail1` columns rather than new ones; treat any further schema change the same
  way: stop, check whether
  an existing column genuinely can't work, and say so explicitly before editing `schema.prisma`.
- Use the shared singleton from `shared/prisma.js` in repositories. It exposes `pingDatabase()`
  (a `SELECT 1` probe) used by `server.js` at boot and by the health service.
- Prisma is pinned to v5 (`prisma` + `@prisma/client` `^5.22.0`). **Do not upgrade to v6/v7** —
  it's a breaking change (mandatory `prisma.config.ts`, driver adapters, new generator) with no benefit
  for this milestone. If you ever do, treat it as a dedicated migration task.

## Pluggable Providers (design extension points)

- **OTP**: `modules/auth/services/otp/otpProvider.interface.js` defines the contract;
  `mockOtpProvider.js` (default, echoes OTP in dev) and `otpProvider.factory.js` selects by
  `OTP_PROVIDER`. For future third-party SMS: add `SmsOtpProvider`, flip env. Do not touch controllers/services.
- **Token blacklist**: `modules/auth/services/tokenBlacklist.js` in-memory now; swap for Redis behind the same interface in a later milestone.

## Typebot Registration Flow

These endpoints are mounted on the existing `/registration` router (no `/api/v1` prefix — nothing
else in this app uses one) and sit behind the existing `authenticate` middleware. Originally
designed for Typebot's own Studio HTTP Request blocks to call directly; as of the backend-driven
relay (see Conversation Router below), `saveDocument()` is instead called **in-process** from
`registrationEngine.handleUpload()` for uploads that arrive through `/conversation/upload`, and
`complete()` is called **in-process** from `registrationEngine.handle()` when the Typebot session
ends. **The live published flow has zero HTTP Request blocks of any kind** (confirmed via the
builder API, `bot.builder.choira.io/api/v1/typebots/{id}/publishedTypebot`) — Typebot itself never
called `basic-details` or `complete` even before this, since no HTTP Request blocks exist in the
flow to call them.

**`POST /registration/start`, `PATCH /registration/:registrationId/basic-details`, and
`PUT /registration/status` were removed** — grepped every call site in `src/` and confirmed nothing
in the live chat flow (or anywhere else internally) ever called them; `registrationId` is just the
stringified `App_Accounts.AccountId` already returned at login (`user.id`), so `start()` was a
no-op wrapper, and `saveBasicDetails()`/`updateStep()` collected fields (`FirstName`/`LastName`/
`DOB`/`Gender`/`AccountAddress`, or a linear step count) the Typebot flow never asks for and no
other caller ever populated. `registration.service.js` no longer exports `start`/`saveBasicDetails`/
`updateStep`. `GET /registration/status` stays — it's the real, documented signal the frontend uses
to check `completed: true/false`.

- `POST /registration/:registrationId/documents/:documentType` — body `{ documentUrl }` (S3 URL
  from Typebot's own upload). `documentType` is a Zod enum: `PAN`, `AADHAAR`, `BANK`, `NOC`,
  `COMPANY_DOC`, `PROFILE_PHOTO`, `PERMANENT_ADDRESS_PROOF`, `CURRENT_ADDRESS_PROOF`,
  `DRIVING_LICENCE`, `VOTER_ID` (a single generalized route, not one per type — reuses
  `saveDocument`/`upsertDocument` unchanged for every type, to avoid duplicating the same logic
  across N routes). Upserts an `App_Accounts_Doc` row keyed by `(AccountId, DocumentCaption)`
  (manual find-then-update-or-create — no unique constraint exists to use Prisma's native
  `upsert`). `DocumentCaption` holds the type string, `DocumentName` holds the URL.
  **`DocumentLookupId` is intentionally left `null`** — `Doc_LookUp` has zero seed rows in the
  current DB/dump, so there's nothing valid to reference; wire it up once that lookup table is
  populated.
- `POST /registration/:registrationId/complete` — requires `AccountEmail` set + one document from
  each of the 3 `REQUIRED_DOC_GROUPS` in `registration.service.js`: identity
  (`PAN`/`COMPANY_PAN`/`PASSPORT`/`TIN` — an NRI often has no Indian PAN, observed live),
  `BANK`, and address-proof (`PERMANENT_ADDRESS_PROOF`/`REGISTERED_ADDRESS_PROOF`). **There is no
  `REQUIRED_DOC_TYPES` array anymore** — it was replaced by groups because each role path collects
  the same real-world requirement under a different doc type (an individual uploads PAN +
  PERMANENT_ADDRESS_PROOF; a company COMPANY_PAN + REGISTERED_ADDRESS_PROOF), and requiring the
  individual names outright made completion impossible on the three company/NRI paths. `AADHAAR` is
  deliberately not in any group — the live flow never asks for it. On missing items, `complete()`
  throws 400 `REGISTRATION_INCOMPLETE` with a `details.missing` list of group labels. Otherwise it
  reuses `markCompleted`/`toPublic` (`ApplicationStatus = 1`) already used by `GET /status`, and
  also defaults an empty `TeritoryAppFor` to `'WORLD'` (idempotent, only fires while empty).

**Fields intentionally not persisted**: the actual Typebot flow also asks about role
(lyricist/composer), membership in another society, tax residency, and a Spotify link. None of
these map to a documented `AppAccounts` column — the generic `Detail1`…`Detail12` free-text columns
are shared production data (`Dreamsoft_UAT`) whose usage elsewhere is unverified, so nothing guesses
a mapping for these. These answers live only in Typebot's own result store, not in this DB, until a
real column/mapping is confirmed.

**GST number, stage name/alias, email, place of birth, role (lyricist/composer/both), territory
applied for (INDIA/WORLD)**, plus a wide set of NRI and Owner/Publisher fields, *are* persisted
(via `conversationFieldMap.js` + `registrationService.saveConversationField()`, see "Conversation
Router" below) — `Detail1` (the GST number), and the existing
`AccountAlias`/`AccountEmail`/`PlaceOfBirth`/`RollTypeIds`/`TeritoryAppFor`
columns, plus `Nationality`/`DualNationality`/`AssociationName_India`/`ChanlDesc`/`KindAttention1`/
`EntityType` and the `AccountAddress`/`AccountAddress_PR` manual "type your address" entries on the
NRI/company paths. Territory initially had no `options.variableId` set in Studio at all (Typebot
only branched on it, never stored it to a variable) — the user assigned it a variable and
republished, confirmed live via the builder API (`variableId = vufrpq6qr5rpcbewbffajjb73` in the
old individual-only bot; the new four-path bot's territory variable is `vn91tusicqaolw34d4zq2id33`),
then it was wired the same way as every other `conversationFieldMap.js` entry. `EntityType`
(Owner/Publisher fork: "Corporate (Pvt Ltd/Ltd Company)"/"Partnership"/"sole proprietry consern")
stores the raw answer — `EntityType` had to be widened from `NVarChar(10)` to `NVarChar(50)` for
it. `DualNationality` is special-cased in `saveConversationField()` (Yes/No → 1/0, the column is an
Int); `AccountEmail` is always stored lowercased so the unique index can't be bypassed by case.

**Bug found and fixed**: `PlaceOfBirth`'s key was `vfvvwcz6g7ueiw2lhqnwvg9z` — which turned out to
be the **block id** of the "Please enter your place of birth" text-input block, not its
`options.variableId` (`vy80zc5eoveac6euqlurki58o`, confirmed via the builder API). Since
`resolveConversationField()` matches against `input.options.variableId`, not the block id, this
entry never matched anything and the field was never persisted — in any session, since it was first
added. Fixed by correcting the key. **Every `conversationFieldMap.js`/`addressProofTypeMap.js`
entry must be verified against `options.variableId` specifically** (fetch the live published flow
via the builder API and check the block's `options.variableId`, not its `id` or any other field) —
a block id and a variableId can look superficially similar and this exact mixup is easy to repeat.

**DOB, Gender, and Nationality from OCR** are also now persisted, alongside the PAN/bank fields/address
in `runOcrAndPersist()`: `DOB` (from whichever doc type's OCR happens to include `extracted.dob` -
PAN or Passport - parsed from the API's `DD/MM/YYYY` string format via a small `parseOcrDate()`
helper, since `Date`'s constructor assumes `MM/DD/YYYY`), `Gender` (from Aadhaar/Voter ID's
`extracted.gender`), `Nationality` (Passport-only, `extracted.nationality`). All three follow the
same "opportunistic, whichever OCR call produced it" pattern as `address` above, and the same
"never let a bad value break the upload" guarantee (`parseOcrDate()` returns `undefined` — skipping
the write — on anything that doesn't match `DD/MM/YYYY`, rather than throwing).

**Deliberately NOT wired** (audited but rejected — don't re-propose without new information): the
top-level "(Individual) Author/Composer" vs the other 3 dead-end role choices (only this branch
ever completes registration, so there's no real variance to persist); both consent gates
(fraud-caution + data-consent — only one `Consent`/`ConsentDate` column pair exists for two
distinct consents); `SocietyId` (BigInt FK, semantically wrong for the "member of another society?"
yes/no answer); Spotify URL (no real matching column); OCR `fatherOrHusbandName` (can legitimately
be a husband's name for married women voters, not a father's — and there's no matching column for
it anyway); bank OCR's `city`/`state`, EPIC number, driving-licence number, passport number (no
matching column exists at all for any of these). Note that OCR `name` **is** now persisted — but
only from identity documents (PAN/AADHAAR/PASSPORT, see `IDENTITY_OCR_DOC_TYPES`), and only while
`AccountName` is still empty — the earlier blanket "never persist OCR name" rule was relaxed for
that one evidence-backed case, keeping the clobber guard the rest of the field still has.

**Address-proof OCR's extracted `address`** (from Driving Licence/Voter ID/Electricity Bill - the 3
address-proof types with an `address` field, see `OCR_FIELD_LABELS`) is now persisted too, unlike
every other extracted field: `runOcrAndPersist()` takes a 4th param, `addressSlot` (the original
`docType` `saveDocument()` was called with, before any `ocrDocType` override — i.e.
`PERMANENT_ADDRESS_PROOF`/`CURRENT_ADDRESS_PROOF`), and writes to `AccountAddress` (permanent) or
`AccountAddress_PR` (current) accordingly. This mapping (base column = Permanent, `_PR` suffix =
Current) was user-confirmed, not derived from any column comment — the columns' real semantics
outside this app are otherwise unverified, same caveat as `Detail1`-`Detail12` below.

**Confirmed `Detail1`/`Detail2`/`Detail10` mapping** (user-provided, unlike the rest of
`Detail1`–`Detail12` which stay unmapped): `Detail1` holds the GST number (written by
`saveConversationField()`) and `Detail2` holds the OCR'd PAN (written by `runOcrAndPersist()`).
These are the *only* place those two values live - this app used to add its own `GSTNo`/`PANNo`
columns and dual-write both, but those were dropped so IPRS has two fewer columns to add to their
real production schema (`Detail1`/`Detail2` already exist there, and are wider than the dropped
columns were).
`Detail10` is set to the literal string `'choira'` by `registrationRepository.markCompleted()`, once,
the first time `ApplicationStatus` flips to 1 — a marker for other `Dreamsoft_UAT` consumers that
this registration came through the Choira onboarding flow. `Detail3`–`Detail9`, `Detail11`,
`Detail12` remain unmapped/unused.

**Auth model**: the frontend runs the existing `/auth/send-otp` + `/auth/verify-otp` first (no new
token mechanism) and then calls the conversation endpoints with `Authorization: Bearer <token>` —
reusing `authenticate` unchanged. `registrationEngine.startChat` feeds `token` + `registrationId`
in as Typebot `prefilledVariables`, which is how the relay knows whose registration it is.
Every service function additionally calls `assertOwnRegistration(userId, registrationId)`
(in `registration.service.js`), which 403s if the path param doesn't match `req.user.id` — the id
alone is never sufficient to touch another user's registration.

**OCR**: implemented for `PAN`/`AADHAAR`/`BANK`/`DRIVING_LICENCE`/`VOTER_ID`/`PASSPORT`/`ELECTRICITY`
— `NOC`/`COMPANY_DOC`/`PROFILE_PHOTO` never trigger OCR, they just save. `PROFILE_PHOTO` was briefly
wired to the `passport-photo` endpoint (face detection + photo-quality checks) but that endpoint
stopped working and the wiring was reverted — `OCR_DOC_TYPES` no longer includes it,
`DOC_TYPE_PATHS` in `httpOcrProvider.js` has no `PROFILE_PHOTO` entry, and
`buildOcrConfirmationMessages()` is back to a flat `extracted?.[key]` lookup (the dotted-path
`getPath()` helper it briefly needed was removed along with the `OCR_FIELD_LABELS.PROFILE_PHOTO`
entry that was its only consumer). `society-noc` was deliberately **not** wired: its consistency
check needs
`applicantName`/`societyName`/`flatNumber`, and neither `societyName` nor `flatNumber` exists
anywhere in this codebase (no `AppAccounts` column, no Typebot question) - also unclear whether the
flow's "NOC" upload step is even a housing-society NOC. `PASSPORT`/`ELECTRICITY`'s
`OCR_FIELD_LABELS` field names are a best-effort guess (the collection only documented them as
one-liners: "MRZ and printed fields" / "Bill name + address") - unmatched keys are silently omitted
from the confirmation message (harmless), but worth confirming against a real success response if a
user reports a suspiciously empty confirmation for these two.
`modules/registration/services/ocr/` follows the OTP provider pattern exactly:
`ocrProvider.interface.js` (contract), `ocrProvider.factory.js` (selects by `OCR_PROVIDER` env,
`http` default / `stub` for local dev without network), `httpOcrProvider.js` (calls the real
`https://ocr.choira.io` service), `stubOcrProvider.js` (always throws, kept for
`OCR_PROVIDER=stub`).

**On the "Document Verification API" Postman collection**: this service's transport contract has
flip-flopped **three times** during this project — JSON `{documentUrl}` → multipart `document` file
→ back to JSON `{documentUrl}`. **Currently confirmed live** (matches the latest collection the user
supplied, `document-verification.postman_collection (1)new.json`): the service accepts a JSON body
`{ documentUrl }` on `POST {OCR_API_BASE_URL}/api/documents/{pan|aadhaar|bank|driving-licence|voter-id}`
and returns a `{success, message, code, data}` envelope; a multipart upload is explicitly rejected
with `415 UPLOAD_NOT_SUPPORTED` ("Send the document link in the 'documentUrl' field of a JSON
body"). `httpOcrProvider.js` sends JSON directly (`documentUrl` passed straight through, no
download/re-upload step needed). Errors carry `details: { stage: 'ocr_call', ...body }` for
diagnosability (see `runOcrAndPersist()`'s catch in `registration.service.js`, which logs `stage`
and `details` before degrading to "unverified"). **Lesson, worth repeating**: don't trust a past
empirical finding here without re-probing live (`curl`) if OCR starts failing again — this has
flipped multiple times with no changelog. `/api/documents/bank` isn't in the collection's own
documented endpoint list, but **is live and working** (confirmed via probe - returns a real
`DOCUMENT_NUMBER_NOT_FOUND` with a bank-specific message about account number/IFSC, not a 404), so
`DOC_TYPE_PATHS.BANK: 'bank'` in `httpOcrProvider.js` stays as-is.

`saveDocument()` in `registration.service.js` calls `ocrProvider.extract()` before upserting the
doc row, so the final `App_Accounts_Doc.DocStatus` is written once: `0` = no OCR attempted,
`1` = OCR-verified, `2` = OCR failed (a failed extraction — 422, timeout, or the service being
unreachable — never fails the upload itself; the document still saves, just flagged unverified).
Env: `OCR_PROVIDER`, `OCR_API_BASE_URL` (default `https://ocr.choira.io`),
`OCR_REQUEST_TIMEOUT_MS`.

What gets persisted to `AppAccounts` from a successful OCR result, and what doesn't:
- **PAN**: the extracted number is written to `AppAccounts.Detail2` (`NVarChar(100)`), a generic
  column IPRS's real schema already has. No PAN-shaped column exists on this table: the only
  `PanNo` field anywhere in the schema is on `AppAccountsTemp`, which is `@@ignore`'d by Prisma
  (no usable primary key) and isn't the table this app writes to.
- **Aadhaar**: extracted number/name/dob/gender/address are used only to compute `verified` —
  never written to `AppAccounts`. Same reasoning as the role/tax-residency/etc. fields above: no
  safe existing column, and this one wasn't worth a schema change. **Aadhaar as its own upload
  step is gone from the live flow** (replaced by the generalized address-proof flow below) — the
  `AADHAAR` doc type/OCR path is kept only for direct REST testability, chat can't reach it anymore.
- **Driving Licence / Voter ID**: same treatment as Aadhaar — extracted fields are used only to
  compute `verified` for the confirmation gate, nothing is written to `AppAccounts` (no matching
  columns exist for either).
- **Bank**: `bankName`/`accountNumber`/`ifsc`/`branch`/`micr` map onto the existing
  `BankName`/`BankAcNo`/`BankIFSCCode`/`BankBranchName`/`MicrCode` columns and get auto-filled on
  success (only fields OCR actually returned — never overwritten with `null`). The bank OCR
  response has no account-holder-name or SWIFT field, so `BankAccountName`/`BankSwift` are
  untouched by OCR.

The document upload response includes `verified` (boolean) and `extracted` (raw OCR data) when
OCR was attempted for that doc type; both are absent for NOC/COMPANY_DOC/PROFILE_PHOTO.

Schema note: **this app adds no columns at all** to `App_Accounts` any more - every answer goes
into a column IPRS's real production schema already has, as the code their own system uses
(`AccountRegType` = I/NI/C/NC, `EntityType` = CP/PR/SP, `RollTypeIds` = MemberRoleType_LookUp ids,
`Detail1` = GST, `Detail2` = PAN; see `memberRoleCodes.js`). `ApplicantPath`/`EntityTypeDetail`,
added earlier when those code meanings weren't yet known, have been dropped -
`scripts/add-applicant-path-column.sql`/`add-entity-type-detail-column.sql` are marked superseded
and must not be run. `AccountPassword` and `EntityType` were also narrowed back to match prod
exactly (`NVarChar(100)`/`NVarChar(10)`, confirmed against `mraai_uat`). One
table was added: `App_Accounts_ChatJournal` (created by `scripts/add-chat-journal.sql`, model added
to `schema.prisma` by hand — see "Resuming an abandoned registration"). A member's alias names live
in `App_Accounts.AccountAlias` itself, comma-separated — `App_Accounts_Alias` was tried as a
separate table first and reversed; `scripts/add-alias-table.sql` is marked superseded, and if it was
ever created locally it's been dropped. See "Work links in the conversation flow" below. Payments
write to `App_Accounts_RegPayment` — IPRS's own
real registration-payment table (confirmed to already exist and be actively used in production,
see `scripts/add-regpayment-table.sql`), not a table this app invented for itself (an earlier
`App_Accounts_Payment` table/script is superseded). Email OTP verification state is **not** in the
database at all — `modules/auth/services/emailOtpStore.js` holds it in memory (same pattern as
`tokenBlacklist.js`), since IPRS's real database has no OTP-verification concept for email
anywhere to mirror. There is still no `prisma/migrations/` folder; the live schema and
`schema.prisma` are kept in sync by whichever of
those two paths a change needs.

## Conversation Router

`modules/conversation/services/conversation.router.js` decides engine by `user.ApplicationStatus === 1`
(AIEngine) vs everything else (RegistrationEngine). `AIEngine` is still a Week 1 **stub** — out of
scope, leave it. `RegistrationEngine` is a real, backend-driven relay to Typebot's Chat API.

**Architecture**: the frontend never talks to Typebot directly — only to this backend
(`POST /conversation/message`, `POST /conversation/upload`). Login/OTP happens on the frontend via
the existing `/auth/*` endpoints (unchanged); once authenticated, every conversation turn goes
through this backend, which drives Typebot's `startChat`/`continueChat` on the frontend's behalf.
This is the reverse of the earlier "Typebot calls us via HTTP Request blocks" model for the
conversational Q&A itself — **basic-details and complete are not driven by Typebot at all**: the
live published flow has no HTTP Request blocks (verified via the builder API), so
`registrationEngine.handle()` calls `registrationService.complete()` itself when the Typebot
session ends (`sessionEnded: true`). Because the flow never asks for first/last name, DOB, or
gender, and its `address` variable is unused, `complete()`'s basic-details gate only requires
`AccountEmail` (the one field the flow does collect, via `conversationFieldMap.js`) plus one
document from each `REQUIRED_DOC_GROUPS` group (see "Typebot Registration Flow" above) — see
`registration.service.js`'s `complete()`.

- `modules/conversation/services/typebot/typebotClient.js` — `startChat`, `continueChat`,
  `generateUploadUrl`, `uploadToPresignedUrl`. Plain `fetch` + timeout, mirrors
  `modules/registration/services/ocr/httpOcrProvider.js`'s style exactly. Throws `appError`
  (`TYPEBOT_NOT_CONFIGURED`, 503) if `TYPEBOT_ID` is unset. `TYPEBOT_PREVIEW_MODE=true` makes
  `startChat` call Typebot's `.../typebots/{id}/preview/startChat` (internal id, no publish/paid
  plan needed — per Typebot's own docs, answers aren't saved and some of Typebot's own blocks like
  "Send email" are skipped) instead of `.../typebots/{publicId}/startChat`; flip to `false` and
  update `TYPEBOT_ID` to the real `publicId` once the bot is published. The app must still boot
  fine with `TYPEBOT_ID` unset either way. Current bot: `publicId = all-flow-finished-p4opm8e`
  (published, `TYPEBOT_PREVIEW_MODE=false`) — this is the four-path flow (Individual **and** NRI
  Author/Composer, Owner/Publisher, NRI Owner/Publisher), all of them reaching a working upload +
  payment step now; full per-path processor coverage sits in `documentTypeMap.js` /
  `conversationFieldMap.js` / `addressProofTypeMap.js`. `progressMap.js` is generated from this
  flow by `npm run build:progress-map` and no longer covers "one live path".
- `modules/conversation/services/typebot/typebotSessionStore.js` — in-memory
  `Map<userId, session>` where `session` is `{ sessionId, input }` plus the gate/turn state fields
  below (`pendingDocConfirmation`, `pendingEmailVerification`, `pendingWorkLinkConfirm`,
  `pendingWorkLinkAlias`, `pendingWorkLinkChoice`, `pendingPaymentReview`, `pendingResumeChoice`,
  `addressProofOcrType`, `emailChanges`). Mirrors `modules/auth/services/tokenBlacklist.js` (swap
  for Redis behind the same interface in a later milestone).
- `modules/conversation/services/typebot/documentTypeMap.js` — maps a file-input block's
  `variableId` to one of our document types (`PAN`/`BANK`/`PROFILE_PHOTO`/`NOC`/
  `PERMANENT_ADDRESS_PROOF`/`CURRENT_ADDRESS_PROOF`, plus the NRI/company path uploads:
  `TRC`/`SS_NUMBER`/`FORM_41`/`TIN`/`SELF_DECLARATION`/`PASSPORT`/`COMPANY_PHOTO`/`PEC`/
  `ENTITY_INCORPORATION`/`COMPANY_TRC`/`LETTER`/`REGISTERED_ADDRESS_PROOF`/`COMM_ADDRESS_PROOF`/
  `COMM_ADDRESS_PROOF_2`/`COMPANY_PAN`/`GST_CERTIFICATE`/`MOA_AOA`/`BOARD_RESOLUTION`/`COMPANY_NOC`/
  `PARTNERSHIP_DEED`/`AUTHORITY_LETTER`/`TUM`). Update this whenever a file-input block's
  variable is added/renamed in the Typebot flow. `COMPANY_DOC` has no entry yet — the company
  branch uses `COMPANY_PAN`/`GST_CERTIFICATE`/etc. instead of a generic company-document slot.
  Note the REST document route's Zod enum only accepts a subset of these; the chat path saves the
  full set in-process via this map.
- `modules/conversation/services/typebot/addressProofTypeMap.js` — the live flow replaced the old
  dedicated Aadhaar upload with a generalized "address proof" flow, asked twice (permanent, then
  current-only-if-different): the user picks a document type from a choice input (Passport /
  Electricity Bill / Driving Licence / Voter ID / Letter from Property Owner), then uploads a file
  into a *separate* variable (`permanent_address_proof` / `current_address_proof`) that doesn't
  itself encode which type it is. This map recognizes the two type-choice blocks by `variableId`
  and maps the answer text to an OCR doc type (`DRIVING_LICENCE`/`VOTER_ID`/`PASSPORT`/`ELECTRICITY`)
  or `null` (only "Letter from Property Owner" has no OCR endpoint anywhere).
  `registrationEngine.handle()` stashes the resolved type in
  `typebotSessionStore` as `addressProofOcrType` when the type-choice question is answered, so the
  paired file-upload (next turn) can read it back. `handleUpload()` passes it to
  `registrationService.saveDocument()`'s new optional `ocrDocType` parameter, which runs OCR under
  that type while still saving the DB row under the generic `PERMANENT_ADDRESS_PROOF`/
  `CURRENT_ADDRESS_PROOF` caption. The session field is naturally overwritten (never explicitly
  cleared) by the next `typebotSessionStore.set()` call regardless of path taken, so it can't leak
  into an unrelated later upload.

  **Bug found and fixed**: `OCR_TYPE_BY_ANSWER`'s key was `'electricity bill'`, but the live
  button's actual text (confirmed via the builder API) is `"Electricity/Light Bill"` — the
  lowercased answer never matched, so `resolveAddressProofOcrType()` silently returned `null` for
  every Electricity Bill selection, which made `saveDocument()` fall back to the generic
  `PERMANENT_ADDRESS_PROOF`/`CURRENT_ADDRESS_PROOF` type (not in `OCR_DOC_TYPES`), skipping OCR
  entirely with no error and no confirmation prompt — just a silent advance to the next question.
  Fixed by correcting the key to `'electricity/light bill'`. **Always re-verify a live button's
  exact text via the builder API before hardcoding it here** — this is the second time in this
  project a hardcoded guess at Typebot's exact wording has been wrong (see the OCR transport-contract
  flip-flops above for a similar "don't trust a past assumption, re-probe live" lesson).

  Directly verified `VOTER_ID` does **not** have this bug: calling `saveDocument()` with
  `ocrDocType: 'VOTER_ID'` against a real test account correctly ran OCR against the `voter-id`
  endpoint and returned a result with an `extracted` key (so `handleUpload()`'s confirmation gate
  *would* fire). If a user still reports a fully silent Voter ID upload after this fix, the bug is
  further upstream — most likely `session.addressProofOcrType` not surviving from the type-choice
  answer turn to the paired upload turn during the real conversation — not in `saveDocument()` or
  the OCR routing itself. Two `logger.warn()` calls were added specifically to catch this: one in
  `handle()` when `resolveAddressProofOcrType()` returns `null` for a type-choice answer, one in
  `handleUpload()` when an address-proof upload has no `ocrDocType` recorded in its session. Check
  these on the next live report before re-investigating from scratch.
- `modules/conversation/services/typebot/conversationFieldMap.js` — same pattern as
  `documentTypeMap.js` but for plain text/choice answers: maps a block's `variableId` to an
  `AppAccounts` column. Today it maps GST no, alias/stage name, email, place of birth,
  role/`RollTypeIds`, territory, nationality, association name, dual nationality, the manual
  "type your address" answers, `ChanlDesc`/`KindAttention1`/`EntityType` (Owner/Publisher path) and
  the company trade name (reuses `AccountAlias`). Persisted via
  `registrationService.saveConversationField()`, which whitelists the field name against a
  hardcoded `CONVERSATION_FIELDS` list rather than trusting the map blindly.
- `modules/conversation/engines/registrationEngine.js`:
  - `handle({ userId, token, message, attachedFileUrls })` — no existing session → `startChat`
    with `prefilledVariables: { token, registrationId: userId }`; existing session →
    `continueChat`. **A blank `message` is treated as a start call, not an answer** (Typebot
    rejects empty text on every input type, and the validator lets `""` through), which also
    discards a stale stored session. Before overwriting the session, it checks whether the
    *previous* turn's input (`existing.input`, i.e. the question `message` is answering) maps to a
    known field via `conversationFieldMap.js`, and persists it if so — a failure here is logged
    and swallowed, it never breaks the conversation relay itself. **An expired Typebot session
    (404 from `continueChat`, see `typebotClient.isDeadSessionError`) is recovered by restarting
    the chat automatically** — one restart only, with a message telling the member nothing was
    lost. Response shape stays close to Typebot's own (`messages`/`input`/`progress`) — no
    invented transformation, since the frontend's exact expectations weren't specified.
  - `handleUpload({ userId, token, file })` — gets a presigned URL from Typebot for the *current*
    file-input step, uploads the buffer, and — this is the key simplification versus the original
    wiring guide — **saves the document itself** by calling the existing
    `registrationService.saveDocument()` directly (same OCR + PAN/bank-column persistence
    built for the Studio-HTTP-block model, just invoked from here instead). Because of this,
    Typebot's Studio no longer needs its own HTTP Request blocks for documents at all. File names
    are sanitised first (`safeFileName`) — Typebot drops the raw name into the presigned URL and
    rejects URLs with spaces/`#`/`?` on the next answer, so "Copy of Choira PAN.jpeg" must become
    "pan.jpeg".
  - `POST /conversation/upload` is `multipart/form-data` (via `multer`, memory storage, limited by
    `MAX_UPLOAD_SIZE_MB`) — the only multipart endpoint in this app; everything else is JSON.
  - **OCR-confirmation gate**: for OCR-eligible doc types (PAN/AADHAAR/BANK, and address-proof
    uploads routed to DRIVING_LICENCE/VOTER_ID via `addressProofTypeMap.js`), `handleUpload()` does
    *not* advance the conversation immediately after `saveDocument()`. If OCR extracted anything,
    it stores `{ ..., pendingDocConfirmation: { fileUrl } }` in `typebotSessionStore` and returns a
    message listing the extracted values (labeled per doc type — `OCR_FIELD_LABELS`, sourced from
    the real "Document Verification API" contract, not the raw OCR keys) plus a synthetic
    `choice input` (`"Yes, confirm"` / `"No, re-upload"` — not a real Typebot block, Studio needs no
    changes). `handle()` checks `pendingDocConfirmation` before anything else: an affirmative answer
    replays the original upload's `attachedFileUrls` through the normal relay path (exactly what
    would have happened pre-gate); anything else re-asks the same file-input step. If OCR found
    nothing at all (`extracted` present but `null` — e.g. an unreadable image), the user is told to
    re-upload a clearer image instead, no confirmation choice shown. This exists because OCR's own
    `isValid` flag doesn't catch every misread (a real Union Bank passbook once extracted as "The
    Federal Bank" with `isValid: true`) — a human check catches what automated verification misses.
  - **`progress`**: Typebot's Chat API never returns a `progress` field (confirmed live against
    `startChat`/`continueChat` — Studio's Theme "Enable progress bar" toggle only affects Typebot's
    own embed widget, not the API), so it's self-computed by
    `modules/conversation/services/typebot/progressMap.js`. The published flow is a branching graph
    (four role paths plus GST/alias/other-society forks), not linear, so
    `progressMap.js` is **generated** — `npm run build:progress-map` re-derives "questions answered
    on this path" per input-block id from the live published flow's `groups`/`edges` (builder API,
    `bot.builder.choira.io/api/v1/typebots/{id}/publishedTypebot`), sorted by percent, and fails
    loudly if progress would move backwards on any edge or a payment block is unresolvable. **Run
    it after every Studio republish** — the map went stale once in production precisely because no
    one regenerated it. Nothing in the map reaches 100 on purpose; `handle()` forces 100 when the
    session actually ends. The script needs `TYPEBOT_ID` and `TYPEBOT_API_TOKEN` (the builder
    token) from `.env`.
  - **More gates in `handle()`**, all synthetic-block driven (Studio needs no changes), checked
    before the normal relay: the work-link loop (`workLinkGate.js`, see "Work links in the
    conversation flow") and the pre-payment review (`paymentGate.js`, "Payment review" below). The
    payment gate is the odd one out — it keys off the **block id** (`PAYMENT_BLOCK_IDS`), not a
    `variableId`, because the payment blocks are single-item choice inputs with no variable
    attached; if a republish changes those ids the gate goes silently unreachable, so re-verify
    them via the builder API.

## Resuming an abandoned registration

The flow asks 30-odd questions plus several uploads, so leaving to find a PAN card is normal.
`typebotSessionStore` is in-memory (no TTL, gone on restart) and Typebot drops its own session after
~20 minutes idle, so a returning member used to land on question 1.

`App_Accounts_ChatJournal` records **every answer Typebot accepted**, in order. On an empty start
call with a journal present, `registrationEngine`'s `offerResume()` returns the synthetic
`RESUME_CHOICE_INPUT` ("Continue where I left off" / "Start over"); `resumeFromJournal()` then opens
a fresh chat and replays the answers into it until it is asking what it was asking when they left.

### Why replay and not a cursor — verified live, don't re-litigate

`startFrom: { type: 'group', groupId }` is **accepted but silently ignored** by
`/api/v1/typebots/{publicId}/startChat` — the response is byte-identical to a normal start, at
question 1. It works only on `/preview/startChat`, which serves the **draft** flow, so returning
members would get whatever half-finished edit is open in Studio while everyone else gets the
published one. (Measured once with the draft 3 days ahead of published.) Not acceptable here.

Replay was measured to land on the identical block id, **file uploads included**: a presigned S3 URL
minted for the old session is still accepted as an answer by a new one, even though it embeds the
old result id.

### Why the existing columns aren't enough

**38 of the flow's 131 input blocks have no `variableId` at all** — pure navigation choices
("(Individual) Author / Composer", "I Accept"). Their answers are stored nowhere, yet they decide
which branch the member is on. The path cannot be reconstructed from `App_Accounts`.

### Rules that keep it safe

- **Journal what was SENT to Typebot, not what the member typed.** The gates (email OTP, work link,
  OCR confirmation, payment review) transform answers before the relay; journaling the relayed
  value is what makes replay side-effect-free — no OTP re-sent, no work link re-saved against the
  5-link cap, no document re-read.
- **Only journal accepted answers.** Typebot answers a rejected input with **200 and the same input
  repeated**, so `response.input?.id !== answeredInput.id` is the acceptance test. Also skipped when
  `sessionExpired`, where the answer was never delivered at all.
- **`replayJournal()` never goes back through `handle()`** — it talks straight to `typebotClient`.
  Every gate lives inside `handle()` and has already run for these answers.
- **The block-id guard is the republish detector.** `response.input.id !== turn.blockId` stops the
  replay rather than feeding a stored answer to a different question. A short replay then calls
  `truncateAfterReplay()`, because turns past that point describe a path the member is no longer on
  and the *next* resume would replay them faithfully into the wrong branch. (The journal also stores
  `variableId` per turn — diagnostic only; replay matches on the block id.)
- **Only an explicit "start over" clears a journal.** Anything else resumes — the destructive branch
  must never be reachable by a stray tap. A "start over" also calls `workLinkService.clearWorkLinks()`
  — work links are append-only with a hard cap, so keeping them would let a restarted member hit the
  5-link ceiling with one song. Documents and account fields are deliberately NOT cleared on restart.
- **The resume answer tells them what's already on file.** `resumeFromJournal()` prepends a summary
  (from `registrationReviewService.buildReview()`) and "We've restored as much of your earlier
  registration as we could" when the flow diverged — build failures are logged and skipped, never
  allowed to block the resume.

Block ids survive a republish (checked after the 2026-09-09 publish: 0 of `progressMap.js`'s 131
ids lost, all gate ids and the 7 OCR button labels intact), so journals normally stay valid across
Studio edits — and `progressMap.js` is regenerable via `build:progress-map` if a future publish
ever does move ids.

Created by `scripts/add-chat-journal.sql`, **not `db push`** — see that script and
`scripts/add-alias-table.sql` for why (`db push` doesn't know about the filtered unique indexes on
`App_Accounts` and may drop them). Add the model to `schema.prisma` by hand, then `prisma generate`
only.

## Music Credits Service (work links)

`modules/work/services/musicCredits.service.js` calls the in-house credits service
(`MUSIC_CREDITS_API_BASE_URL`, default `https://spotify.choira.in`). **One endpoint per platform** —
the resolver already knows which it has, so the provider-specific route is used rather than the
auto-detecting `/resolve`:

| | endpoint | what comes back |
|---|---|---|
| Spotify | `GET /credits?track=<url>` | **structured** — `contributors[]`, each with a `role` (`Main Artist`, `Composer`, `Lyricist`, `Producer`) and a `role_group`, read server-side from Spotify's own credits |
| YouTube | `GET /youtube/raw?url=<url>` | **raw InnerTube** — nothing structured; this module parses it |

It is the first source this app has that reports **what a credited person actually did**.

**This is what changed the "grounded data only" rule.** `Author_Composer` and `Author_Lyricist` were
historically left null because Spotify returned one unlabelled bag of artists and a YouTube title is
a sentence. Both are now written — *only* from role-labelled output. When there is none, they stay
null exactly as before. `LanguageNames`, `WorkCategory` and `DocLink` remain null always.

### Reading the raw YouTube response

`findRenderer()` searches by renderer name rather than walking a hardcoded path — InnerTube moves its
nesting between builds, and a fixed path breaks silently. Two renderers matter:

- `musicResponsiveHeaderRenderer` → `title` (the *clean* song name, not the marketing video title),
  `straplineTextOne` (artist), `subtitle` (`"626M views • Nov 7, 2022"`). **That subtitle is the only
  release date YouTube gives us** — oEmbed carried none, so YouTube links can now fill `ReleaseYear`.
- `musicDescriptionShelfRenderer` → the label's own credit block, parsed by label
  (`Song:`, `Movie:`, `Singers:`, `Music:`, `Lyrics:`).

**`CREDIT_LABELS` is deliberately narrow, and "Written by" is excluded on purpose.** In a film
description that is the screenwriter, sitting next to `Directed by:`/`Produced by:` — not the
lyricist. A wrong name in `Author_Lyricist` is a wrong name in a rights register. Only labels that
unambiguously name a *song* credit may fill those columns. Every other labelled name still lands in
`allCredits`, which only decides whether the member is asked for an alias — generous there is safe,
generous in the register is not. `test/musicCredits.test.js` pins this.

> **A music page is NOT an isMusicVideo test.** `/youtube/raw` answers with an ordinary watch page
> for a TED talk — but *also* for a real song that simply isn't on YouTube Music (verified live:
> "Chaleya" returns no music renderer at all). So "no music renderer" means only *no credits from
> this source*; the resolver falls back to the title path rather than rejecting a member's genuine
> work. **Do not "optimise" this into a rejection.**

### Hybrid on the Spotify path

The credits response carries no album name, release date or ISRC, so `resolveSpotify()` calls the
credits service *and* `spotifyService.getTrackMetadata()` in parallel (`Promise.allSettled`) and
merges: song/artists/writers from credits, `filmOrAlbum`/`releaseYear` from the Web API, publisher
from credits `source` falling back to the album's P-line copyright. Either half may fail; only both
failing throws.

> **Known live issue:** the Spotify Web API returns **403** for this project's credentials —
> *"Active premium subscription required for the owner of the app."* The client id/secret are valid
> (the token call succeeds), but `/v1/tracks/{id}` is refused until the account owning the Spotify
> app holds an active Premium subscription. Until then `Film_AlbumName` and `ReleaseYear` are null
> for Spotify links, and the resolver logs this at **info**, not warn — it is fully handled, the link
> still resolves from credits, and a warn-with-stack on every Spotify link made a working system look
> broken. `spotify.choira.in` itself never failed here. The code self-heals when access returns.

### Degradation

`fetchSpotifyCredits()` / `fetchYoutubeCredits()` **never throw**. Every failure returns `null` —
disabled, unreachable, non-200 (422 is "not a Spotify or YouTube link"), unparseable, or no credits
found — and the resolver falls back to the Spotify Web API / oEmbed + Gemini pair. A member must
never be blocked on the work-link step by a metadata outage. `MUSIC_CREDITS_ENABLED=false` is the
kill-switch, same shape as `OCR_ENABLED`.

`"N/A"` is the Spotify path's null sentinel: an unknown track id answers **200** with
`song_name: "N/A"` and `__typename: "NotFound"`, not a 404. `hasUsableCredits()` therefore judges on
**credited people**, not on a song name — both empty cases still return a name.

> **Caveat, pre-existing:** with `GEMINI_API_KEY` blank, the fallback title path returns
> `isMusicVideo: true` for everything (`parsed ? parsed.isMusicVideo : true`), so a non-music video
> reaches the confirmation card. Configure `GEMINI_API_KEY` if this matters; there is no
> deterministic substitute, for the "Chaleya" reason above.

## Work links in the conversation flow

The live flow asks for *one* song link and moves on; **everything else** — identifying the provider,
showing the song back, extracting a credited name when the match fails, looping up to the cap — is
backend-driven with synthetic blocks from `services/typebot/workLinkGate.js`, Studio needs no
changes. All four role paths share one `workUrl` variable (`WORK_URL_VARIABLE_ID`; all gates match
their step by `options.variableId`, the one exception being the payment gate below, which keys off
a block id).

- `registrationEngine.handle()` intercepts the link answer *before* relaying to Typebot:
  `workLinkResolver.service.js` turns the URL into a provider-agnostic `resolved` shape
  (`{ provider, url, songName, artists, filmOrAlbum, releaseYear, publishers, composers, lyricists,
  credits, isMusicVideo }`), then a synthetic confirm card shows the song. Unresolvable/not-a-song
  links re-ask the step; nothing is written until the member confirms the song.
- On confirm, `matchCredits()` (`workMatch.service.js`) checks the song's **`credits`** (every
  platform-reported name) against the member's names, split by evidentiary weight:
  **trusted** = `AccountName` + the first name on file in `AccountAlias` (both on file before the
  member saw the credit list), **claimed** = every later name in `AccountAlias` (see below) - names
  the member typed at the work-link step *after* seeing the list. A trusted match stores the link
  `verified`; a claimed match stores it unverified — appending a name to `AccountAlias` never
  promotes it to trusted, only position 0 counts as that. If nothing matches, a synthetic
  `WORK_LINK_ALIAS_INPUT` asks "what name are you credited under?"; `parseAliasList()` splits
  comma-separated names, `addAliases()` appends them to `AccountAlias` (case-insensitive dedup
  against what's already there, and it stops adding once the column's own 200-char width would
  overflow rather than truncating a name) so the next link matches without asking again, and after
  `MAX_ALIAS_ATTEMPTS` (2) the song is saved unverified rather than wedging the member. `AccountAlias`
  is the same column the flow's own stage-name/traderName question writes - that write always runs
  first (fixed question order across all four paths), so it reliably occupies position 0 before any
  work-link claim is appended; `getIdentityNames()` in `registration.service.js` is where this split
  happens. There is no longer a separate alias table — see the Prisma note above.
- Saving is `workLinkService.saveWorkLink()` (one `App_Accounts_WorkRegistration` row), hard-capped
  at `MAX_WORK_LINKS = 5` **in the service**, not just the gate — the cap still bites if a restarted
  conversation re-asks the step. `CreatedBy`/`ModifedBy` are both the member's own `AccountName`
  (fetched via `registrationService.getIdentityNames()`), set together at creation and never touched
  again — same pattern `registration.service.js` uses for `App_Accounts.CreatedBy`/`ModifedBy`.
  `Author_Composer`/`Author_Lyricist` are filled directly from the confirmed song's own role-labelled
  credits (whatever the credits service returned), independent of which specific role the confirming
  member holds in it — `saveWorkLink()` only ever runs after the member has said "Yes, this is my
  song" and passed the broader credits-match gate above, so the columns record the song's own writer
  credit for that already-confirmed link, not a per-role identity check.
- Name comparison is token-based (first and last tokens must correspond; initial-for-full-name and a
  one-letter typo are accepted; a single-token mononym credit may match the member's first *or* last
  token, but a single-token *member* name must equal the whole credit) — see `workMatch.service.js`,
  pinned by `test/workMatch.test.js`.
- Right after that song is saved, `saveAndOfferAnother()` asks its own `Film_AlbumName`/`Publisher`/
  `WorkCategory`/`LanguageNames`/`ReleaseYear` - whichever the just-created row is missing, in that
  order - before offering another link slot or falling through to Typebot. See `workDetailsGate.js`.
  None of these five can always be sourced from Spotify/YouTube's credits (`ReleaseYear` is frequently
  null on Spotify links specifically, from the Spotify Web API's known 403 issue above; `Film_AlbumName`
  and `Publisher` are often missing on YouTube links whose description doesn't spell them out), so
  they're asked here, one field at a time, right after "yes, that's my song" - not saved up into one
  batch at the end, so a member with 3 links is asked about each song immediately after confirming it,
  not all fifteen questions at once after the third. `Film_AlbumName`/`Publisher`/`LanguageNames` are
  freeform text (whatever the member types is the authoritative answer, unlike the resolved-link
  metadata elsewhere); `WorkCategory` is a fixed 5-option choice (`Film` / `Non Film` / `BG - TV` /
  `BG-Film` / `AD - Jingle`); `ReleaseYear` requires a 4-digit year no more than one year in the
  future. State lives in `pendingWorkRowDetails: { queue, index, lastUrl, atCap, saved }`; once that
  song's queue is empty (including immediately, when nothing was missing), `finishSaveOutcome()`
  either offers another link slot or - at the cap - falls through to Typebot exactly like the
  direct-decline path always did. Each answer is written to its row immediately
  (`workLinkService.updateWorkDetails()`), and a field already on file (e.g. a YouTube link whose
  description did carry a year) is never re-asked.
- After each save (and any details it needed) a synthetic "add another?" input loops the step; at the
  cap the last URL is replayed as the answer to Typebot's own question so the conversation advances
  normally. As a safety net for rows saved some other way (a replayed/resumed session, or older data),
  `startWorkDetailsFollowUp()` re-checks every saved song for anything still missing when the member
  taps "No, continue" - a no-op in the normal case, since the per-song ask above already covered it.

## Payment review

`paymentGate.js` intercepts Typebot's **reply**, not the member's answer: when the relay's response
`input` is one of the payment blocks (`PAYMENT_BLOCK_IDS`, keyed by **block id** because the payment
buttons are single-item choice inputs with no variable attached — re-verify these via the builder API
if a republish changes them), `handle()` swaps in the synthetic `PAYMENT_REVIEW_INPUT` and shows
everything on file first, built by `registrationReviewService.buildReview()` straight from the
database (fields, uploaded documents, claimed songs, aliases) — not from Typebot variables, so an
OCR misread that never made it into the DB shows up as missing rather than passing silently. "Yes,
everything is correct" returns the real payment block; "No" answers with `SUPPORT_CONTACT` + the
registration id (Typebot can't be driven backwards, so the payment button is still offered). A failed
`buildReview()` never blocks the button.

**A payment block is a terminal state — Typebot is never driven past one.** All four blocks lead to a
single "Thank you for your payment." text (Group #144) and then the flow ends, so that message is now
dead code: real payment happens entirely outside Typebot, via `POST /payment/initiate` and PayU's
callback, and the frontend's own success page is the closure. Three rules enforce this:

- `handle()` never relays a message that arrives while the member is parked on a payment block. It
  answers with `describePaymentPending()` (or `describePaymentReceived()` if a SUCCESS payment exists
  but `complete()` is still refusing) and re-offers the same button. Before this, relaying handed
  Typebot the button's own answer — so anyone who typed into the chat, or posted `{"message": "Pay"}`
  by hand, got congratulated on a payment that never happened, the session ended, and
  `clearJournal()` wiped their resume data.
- `initiatePayment()` throws 409 `PAYMENT_ALREADY_COMPLETED` when the account already has a SUCCESS
  payment, so a stale chat tab or a back button can't mint a second live PayU checkout. Only SUCCESS
  blocks — a PENDING row is what an abandoned PayU page leaves behind and those members must be able
  to retry.
- On a successful callback, `handlePayuCallback()` clears the Typebot session and the journal — but
  **only once `complete()` has actually succeeded**. If it threw (a document still missing), both are
  left intact so the member can still resume, and the failure is logged at `warn`: money has changed
  hands and they are not registered.

## Spotify Credit Verification

`POST /spotify/metadata` (`modules/spotify/`, behind `authenticate`) — given `{ url, actualName,
stageName }`, fetches the track's metadata from the real Spotify Web API (client-credentials OAuth,
token cached in-memory) and checks whether `actualName` or `stageName` matches one of the track's
credited artists (diacritics/punctuation/case-insensitive match via `normalizeName()`). An
`App_Accounts_WorkRegistration` row (song/album/artists/release-year) is written **only when the
claim actually matched** — an earlier version wrote one for every call, which put songs that weren't
the caller's into the rights register while the response said `status: false`.
`SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` are optional in `envSchema` (feature no-ops with a clear
`SPOTIFY_CREDENTIALS_MISSING` 500 if unset, same graceful-missing-config pattern as `TYPEBOT_ID`).

**This endpoint is legacy relative to the conversation flow.** The old "Spotify hard gate" inside
`registrationEngine.js` (a `spotifyGate.js` that blocked non-matching links on the "Enter your
spotify link" step) is **gone** — that step was replaced wholesale by the work-link gate
(`workLinkGate.js`), which accepts both Spotify *and* YouTube links, resolves them via
`workLinkResolver.service.js`, and verifies the member against role-labelled credits (not just
artists) — see "Work links in the conversation flow" below. `POST /spotify/metadata` still exists
and works as a standalone check/diagnostic, but nothing in the chat path calls it anymore. There is
no `SPOTIFY_VERIFICATION_BYPASS` env var anymore either — the work-link gate has no bypass flag, it
degrades to a confirm-and-save flow instead of blocking.

## Email OTP Verification

`modules/auth/services/emailOtp.service.js` (`emailOtpService.sendEmailOtp`/`verifyEmailOtp`,
merged from the `email` branch, PR #3) — sends a 4-digit OTP via `nodemailer` (`utils/email.js`,
SMTP config in `envSchema`) to a given email, hashed with `bcrypt` and stored in
`EmailVerificationOtp` (`Email_Verification_Otp` table, added via `db push` — not in the original
DB dump). `verifyEmailOtp` enforces expiry (`EMAIL_OTP_EXPIRY_MINUTES`), a resend cooldown
(`EMAIL_OTP_RESEND_COOLDOWN_SECONDS`), and a max-attempts lockout (`EMAIL_OTP_MAX_ATTEMPTS`), each
with a clear, user-facing error message. Also exposed standalone as `POST /auth/send-email-otp` /
`POST /auth/verify-email-otp` (no `authenticate` — usable pre-login), but the conversation flow
below calls the service directly rather than looping back through HTTP.

**Wired into the conversation flow as a hard gate**, same synthetic-block pattern as the
OCR-confirmation and work-link gates —
`modules/conversation/services/emailOtpGate.js` recognizes the "Provide your email id" email-input
block by its `variableId` (`EMAIL_VARIABLE_ID` — same id already mapped to `AccountEmail` in
`conversationFieldMap.js`). Unlike the work-link loop (pass/fail or loop), this is a send-then-verify
sub-conversation, tracked via a new `pendingEmailVerification: { email }` field in
`typebotSessionStore` (same shape/precedent as `pendingDocConfirmation`):

- A fresh answer to the email question (format-checked first) triggers `sendVerificationOtp()` and
  replaces the real input with a synthetic `EMAIL_OTP_INPUT` block (non-Typebot, Studio needs no
  changes — same pattern as `OCR_CONFIRM_CHOICE_INPUT`) asking for the OTP.
- `handle()` checks `pendingEmailVerification` before anything else on the next turn: typing one of
  `isResendKeyword()`'s recognized phrases (`resend`, `resend otp`, `resend the otp`, `send otp
  again`, `send again`, `new otp`) re-sends a fresh OTP (the service's own cooldown throws its own
  message if spammed); anything else is treated as the OTP itself. A wrong OTP now returns
  `verifyEmailOtp()`'s message **with a remaining-attempts count** ("Invalid OTP. N attempts
  left.", `details: { attemptsRemaining }`) computed in `emailOtp.service.js`. Every
  wrong/expired/maxed-out response — not just the initial send — also has a `'Type "resend" to get
  a new OTP.'` hint appended in `registrationEngine.js`, so resend stays discoverable through
  repeated wrong guesses and especially right after max-attempts lockout (where the record is
  invalidated server-side and further digit-entry alone would just repeat "OTP not found..." with
  no way out otherwise). The conversation never reaches Typebot's `continueChat` until verification
  succeeds. A correct OTP clears `pendingEmailVerification` and replays the turn as if the user had
  just answered the email question correctly, so the normal relay/persist path
  (`resolveConversationField` → `AccountEmail`) runs unchanged.

**Setup**: nothing DB-side to set up - OTP state lives in memory (`emailOtpStore.js`), not a table
(IPRS's real database has no equivalent to mirror, so this sidesteps that rather than working
around it - a server restart just clears any pending OTP, the member requests a new one).
`SMTP_USER`/`SMTP_PASSWORD` are optional in `envSchema` with no default; without them,
`sendVerificationOtp()` fails with `'Failed to send email'` and the real email question re-asks —
fill them in `.env` for actual delivery.

## GST Verification

Same "hard gate" pattern as the email-OTP and work-link steps, for a different reason: the GST
number is a typed answer that needs checking against a government-lookup service before it's worth
persisting at all, not a multi-turn sub-conversation like OTP. TAN verification is deliberately NOT
built yet - no Studio question exists for it, and nothing here should be extended to TAN until
asked for.

`modules/registration/services/verify/` mirrors the OCR provider's interface+factory shape
(`verifyProvider.interface.js`, `httpVerifyProvider.js`, `stubVerifyProvider.js`,
`verifyProvider.factory.js`, selected by the existing `OCR_PROVIDER` env var — the verify endpoint
lives on the same `ocr.choira.io` host as document OCR, so this isn't a second provider switch). The
provider takes a typed `value`, not a `documentUrl`: `POST {OCR_API_BASE_URL}/api/verify/gstin`,
body `{ gstin: value }`, response `{ success, verified, message, data }`.

**Pass/fail rule (confirmed, not guessed): the response's TOP-LEVEL `success` field alone.** A live
probe against a syntactically wrong GSTIN returned `{ success: true, verified: false, message:
"Invalid GSTIN", data: null }` - so `verified` and everything under `data`
(`gstin_status`/`gstin_checksum_valid`) are informational only and are never used to reject an
answer. Only a genuine service/transport failure (network error, non-2xx, or the service's own
`success: false`) blocks the member; that throws `VERIFY_REQUEST_FAILED`. Once `success` is true,
the answer is treated as passed regardless of what the nested fields say.

`modules/conversation/services/typebot/verifyGate.js` recognizes the GST question's `variableId`
(`vqpmuqooo8wn2ktrfx9uf4l1j` — same id already mapped to `Detail1` in `conversationFieldMap.js`) and
is wired into `registrationEngine.js`'s gate chain between the work-link and email gates. A fresh
answer is checked before it's relayed to Typebot or persisted at all. On a service/transport failure,
the same question is re-asked (`input: existing.input`, no `typebotSessionStore.set()` with a new
input, no `continueChat` call — Typebot's session never advances, same guarantee as the email gate's
failure path) with a message built from the service's own `message` field where present. Retries are
unbounded — unlike OTP resends/email changes, a failed verify call has no side effect worth capping.
Once the service responds successfully, the answer falls through unchanged to the normal
relay/persist path, so GST's existing `Detail1` write is untouched.

`env.GST_VERIFY_ENABLED` (default `true`) is a blanket kill-switch for this whole gate — same
shape/purpose as `OCR_ENABLED`. Set to `false` locally to test the chat flow past the GST step
without a real, valid-format GSTIN on hand; when off, the step is never matched in
`registrationEngine.js`, so the typed answer is saved unchecked, same as any other unguarded text
field. Always `true` in production.

## Conventions to preserve

- Keep the response envelope, error codes, and status codes consistent — do not introduce ad-hoc shapes.
- Controllers must stay thin; do not move business logic into them.
- Prefer calling another module's *service* over reaching into its repository (e.g.
  `registrationEngine.js` calls `registrationService.saveDocument()`, not
  `registrationRepository` directly). `auth.service.js` importing `userRepository` predates this
  and is the one exception — don't take it as license to reach into repositories generally.

## Testing notes

- `npm test` runs every `test/*.test.js` via `node:test`; any single file also runs via
  `node --test test/<name>.test.js`. Most suites are pure logic (no DB): `workMatch`,
  `musicCredits`, `progressMap`, `ocrLabels`, `uploadFileName`, `typebotSession`,
  `emailOtpGate`, `registrationReview`, `gemini`/`youtube` parsing. Suites with a DB-dependent
  part (auth round-trip, `workLink`, `conversationJournal`, `addressProofReupload`) auto-skip just
  that part when SQL Server is unreachable.
- The DB-dependent parts run against a live instance (`npm run setup:db` as Administrator + import
  `scripts/mra_cleaned.sql` first). The auth round-trip asserts the response echoes the OTP, so it
  requires `OTP_PROVIDER=mock` (the default). It also exercises `/registration/status` and
  `/conversation/message` with a real JWT.