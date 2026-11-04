// ==================================================================
// Auth routes.
// ==================================================================
import { Router } from 'express';
import { validate } from '../../../shared/validate.js';
import { authenticate } from '../../../middlewares/auth.js';
import { authRateLimiter } from '../../../middlewares/rateLimiter.js';
import * as authController from '../controllers/auth.controller.js';
import { sendOtpSchema, verifyOtpSchema } from '../validators/auth.validator.js';
import { authenticateService } from '../../../middlewares/serviceAuth.js';
import { trustedLoginSchema } from '../validators/auth.validator.js';
import { sendEmailOtpSchema, verifyEmailOtpSchema } from '../validators/auth.validator.js';

const router = Router();

router.post('/send-otp', authRateLimiter, validate(sendOtpSchema), authController.sendOtp);
router.post('/verify-otp', authRateLimiter, validate(verifyOtpSchema), authController.verifyOtp);
router.post('/send-email-otp', authRateLimiter, validate(sendEmailOtpSchema), authController.sendEmailOtp);
router.post('/verify-email-otp', authRateLimiter, validate(verifyEmailOtpSchema), authController.verifyEmailOtp);
router.post('/trusted-login', authenticateService, validate(trustedLoginSchema), authController.trustedLogin);
router.post('/logout', authenticate, authController.logout);

export default router;
