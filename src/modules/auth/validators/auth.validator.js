// ==================================================================
// Auth request validators (Zod).
// ==================================================================
import { z } from 'zod';

const phoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{9,14}$/, 'Must be a valid phone number (9-14 digits, optional +)');

export const sendOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
  }),
});

export const verifyOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    otp: z.string().regex(/^\d{4,6}$/, 'OTP must be 4-6 digits'),
    // Frontend's own persisted browser id, if it sends one - see auth.service.js's verifyOtp,
    // which falls back to a server-generated one when this is absent. GUID column is NVarChar(50).
    guid: z.string().max(50).optional(),
  }),
});

const emailSchema = z.string().email('Must be a valid email');

export const sendEmailOtpSchema = z.object({
  body: z.object({ email: emailSchema }),
});

export const verifyEmailOtpSchema = z.object({
  body: z.object({ email: emailSchema, otp: z.string().regex(/^\d{4}$/, 'OTP must be exactly 4 digits') }),
});
