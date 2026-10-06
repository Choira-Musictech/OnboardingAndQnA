// ==================================================================
// IPRS Platform Backend - Week 1 (Onboarding & Platform Foundation)
// Environment configuration loader (validated with Zod)
// ==================================================================
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_ISSUER: z.string().default('iprs'),

  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

  OTP_PROVIDER: z.enum(['mock', 'sms']).default('mock'),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MOCK_VALUE: z.coerce.string().optional(),
  MSG91_AUT_KEY: z.string().optional(),
  MSG91_TEMP_ID: z.string().optional(),
  MSG91_OTP_LENGTH: z.coerce.number().int().positive().default(4),
  MSG91_OTP_EXPIRY: z.coerce.number().int().positive().default(10),

  /* Email OTP configuration */
  EMAIL_OTP_LENGTH: z.coerce.number().int().positive().default(4),
  EMAIL_OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(2),
  EMAIL_OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  EMAIL_OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),

  /* SMTP (Nodemailer) */
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  // z.coerce.boolean() would treat the string "false" as truthy - compare explicitly.
  SMTP_SECURE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  // The envelope sender. Kept separate from SMTP_USER because relays like ZeptoMail
  // authenticate with a fixed literal username ("emailapikey"), which is not an address -
  // falling back to SMTP_USER there would put a non-address in the From header.
  SMTP_FROM: z.string().optional(),

  // Shown at the pre-payment review when the member says something needs correcting. Optional:
  // blank falls back to "our team will get in touch" rather than printing an empty contact line.
  SUPPORT_CONTACT: z.string().optional(),

  SPOTIFY_CLIENT_ID: z.string().optional(),
  SPOTIFY_CLIENT_SECRET: z.string().optional(),

  // Work links (the songs a member claims). Role-labelled credits come from the in-house
  // credits service (see work/services/musicCredits.service.js); the oEmbed + Gemini pair below
  // is the fallback for when it can't answer.
  MUSIC_CREDITS_API_BASE_URL: z.string().default('https://spotify.choira.in'),
  // Pathfinder + InnerTube + Gemini happen behind this one call, so it is slower than a plain
  // metadata fetch - a YouTube resolve measured ~10-20s.
  MUSIC_CREDITS_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // Kill-switch: false skips the credits service entirely and uses the oEmbed/Gemini + Spotify
  // Web API path alone. Same shape as OCR_ENABLED - z.coerce.boolean() would treat "false" as true.
  MUSIC_CREDITS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  // YouTube metadata's key-free path is the oEmbed endpoint (title/channel only) - see
  // work/services/youtube.service.js. YOUTUBE_API_KEY is optional: when set, musicCredits.service.js
  // uses the real YouTube Data API as a fallback description/publish-date source for videos
  // InnerTube has nothing structured for (not registered on YouTube Music).
  YOUTUBE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  YOUTUBE_API_KEY: z.string().optional(),
  // Gemini splits a YouTube title into song/artists/album. Optional: leave GEMINI_API_KEY blank and
  // the flow falls back to the raw video title instead of breaking.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-flash-lite-latest'),
  GEMINI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  /* Translation of the chatbot's own replies (modules/translation).
   * The flow is authored once in English and translated on the way out, so a flow edit never
   * needs a translated copy. Off by default: with TRANSLATION_ENABLED false - or the chosen
   * provider unconfigured - every member simply gets the English text.
   *
   * TRANSLATION_PROVIDER 'google' is Cloud Translation, the product IPRS asked for. Google no
   * longer accepts a plain API key on that API for every project (401 "API keys are not supported
   * by this API"), so it takes GOOGLE_TRANSLATE_TOKEN, an OAuth/service-account access token,
   * falling back to GOOGLE_TRANSLATE_API_KEY where keys are still permitted. 'gemini' reuses the
   * generative endpoint this repo already calls, which does accept a plain API key. */
  TRANSLATION_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TRANSLATION_PROVIDER: z.enum(['dictionary', 'gemini', 'google']).default('dictionary'),
  // JSON file of { "English phrase": { "hi": "...", "mr": "...", "gu": "..." } } used by
  // the 'dictionary' provider. Written once for the flow's fixed wording.
  TRANSLATION_DICTIONARY_PATH: z.string().optional(),
  // The language the Typebot flow itself is written in - never translated to.
  TRANSLATION_SOURCE_LANGUAGE: z.string().default('en'),
  // Must match the codes the frontend offers (src/constants/languages.js).
  TRANSLATION_SUPPORTED_LANGUAGES: z.string().default('en,hi,mr,gu,bn'),
  TRANSLATION_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  TRANSLATION_CACHE_MAX: z.coerce.number().int().positive().default(5000),
  // Defaults to GEMINI_MODEL when blank.
  TRANSLATION_GEMINI_MODEL: z.string().optional(),
  GOOGLE_TRANSLATE_API_KEY: z.string().optional(),
  GOOGLE_TRANSLATE_TOKEN: z.string().optional(),

  DEFAULT_REGISTRATION_STATUS: z.string().default('started'),
  REGISTRATION_TOTAL_STEPS: z.coerce.number().int().positive().default(10),

  OCR_PROVIDER: z.enum(['http', 'stub']).default('http'),
  OCR_API_BASE_URL: z.string().default('https://ocr.choira.io'),
  OCR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  // Blanket kill-switch for OCR across every doc type (independent of OCR_DOC_TYPES in
  // registration.service.js) - flip to false when ocr.choira.io itself is flaky so chat-flow
  // testing can proceed past uploads without getting stuck in the "please re-upload" retry loop.
  // z.coerce.boolean() would treat the string "false" as truthy - same fix as TYPEBOT_PREVIEW_MODE.
  OCR_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Blanket kill-switch for the GST verify gate (independent of OCR_ENABLED) - flip to false to
  // test the chat flow past the GST step without needing a real, valid-format GSTIN on hand.
  // Mirrors OCR_ENABLED's exact shape/reasoning.
  GST_VERIFY_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Blanket kill-switch for the `name` field sent to DRIVING_LICENCE/PASSPORT/VOTER_ID/BANK/GST OCR
  // calls (independent of OCR_ENABLED) - flip to false to stop the OCR service's own name-match check
  // from blocking uploads (e.g. NAME_MISMATCH) without needing a document in the account holder's
  // actual name on hand. This app has no cross-document name check of its own - this is the only
  // name-verification switch left. Mirrors OCR_ENABLED's exact shape/reasoning.
  OCR_NAME_VERIFICATION_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),

  TYPEBOT_API_BASE_URL: z.string().default('https://typebot.io'),
  // The bot's internal id (preview mode) or publicId (once published) - see TYPEBOT_PREVIEW_MODE.
  TYPEBOT_ID: z.string().optional(),
  // z.coerce.boolean() would treat the string "false" as truthy - compare explicitly instead.
  TYPEBOT_PREVIEW_MODE: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  TYPEBOT_API_TOKEN: z.string().optional(),
  TYPEBOT_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(10),
  // Where each member's uploads are also copied, one folder per member (see
  // documentStorage.service.js). Blank turns the copy off.
  DOCUMENT_STORAGE_DIR: z.string().default('uploads/member-documents'),

  /* PayU Payment Gateway */
  PAYU_KEY: z.string().optional().default('test_key'),
  PAYU_SALT: z.string().optional().default('test_salt'),
  PAYU_BASE_URL: z.string().default('https://test.payu.in'),
  PAYU_WEBSERVICE_URL: z.string().default('https://test.payu.in/merchant/postservice.php?form=2'),
  // No PAYU_DEFAULT_AMOUNT: the fee is never configurable or client-supplied. It is resolved
  // server-side from the member's own registration type (AccountRegType) via payu/feeSchedule.js, and
  // initiatePayment() refuses to start a payment it cannot price rather than falling back.
  // Where PayU itself POSTs the payment result back to (surl/furl sent in the initiate request) -
  // must be OUR OWN publicly reachable /payment/callback endpoint, not a page PayU or the frontend
  // owns. Optional so an unconfigured deploy falls back to PAYU_SUCCESS_URL/FAILURE_URL below
  // (payment.service.js's old behaviour) rather than failing outright.
  PAYU_CALLBACK_URL: z.string().optional(),
  // Where the member's BROWSER ends up after our /payment/callback has processed PayU's postback -
  // a frontend page, not PayU's own. payment.controller.js redirects here with ?txnid&status.
  PAYU_SUCCESS_URL: z.string().optional(),
  // Comma-separated sites a member may be returned to after paying. The origins of
  // PAYU_SUCCESS_URL/PAYU_FAILURE_URL are always allowed; list any other domains here.
  PAYU_RETURN_ORIGINS: z.string().optional().default(''),
  PAYU_FAILURE_URL: z.string().optional(),
  PAYU_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('âŒ Invalid environment configuration:');
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
});
