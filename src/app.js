
// ==================================================================
// Express application assembly.
// Middleware order matters: security -> parsing -> logging -> routes -> 404 -> errors.
// ==================================================================
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env.js';
import { requestLogger } from './utils/logger.js';
import { globalRateLimiter } from './middlewares/rateLimiter.js';
import { errorHandler, notFoundHandler } from './shared/errorHandler.js';
import authRoutes from './modules/auth/routes/auth.routes.js';
import registrationRoutes from './modules/registration/routes/registration.routes.js';
import conversationRoutes from './modules/conversation/routes/conversation.routes.js';
import healthRoutes from './modules/health/routes/health.routes.js';
import spotifyRoutes from './modules/spotify/routes/spotify.routes.js';
import paymentRoutes from './modules/payment/routes/payment.routes.js';

export const app = express();

// Behind the cloudflared tunnel / any real reverse proxy, req.ip otherwise resolves to the proxy's
// own address rather than the member's - needed for PublicIP capture at OTP verification.
app.set('trust proxy', true);

// --- Security ---
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(','),
    credentials: true,
  }),
);
app.use(globalRateLimiter);

// --- Parsing + logging ---
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(requestLogger());

// --- Routes ---
app.use('/health', healthRoutes);
app.use('/auth', authRoutes);
app.use('/registration', registrationRoutes);
app.use('/conversation', conversationRoutes);
app.use('/spotify', spotifyRoutes);
app.use('/payment', paymentRoutes);


// --- 404 + central error handling (LAST) ---
app.use(notFoundHandler);
app.use(errorHandler);
