// ==================================================================
// Conversation routes.
// ==================================================================
import express, { Router } from 'express';
import multer from 'multer';
import { validate } from '../../../shared/validate.js';
import { authenticate } from '../../../middlewares/auth.js';
import { env } from '../../../config/env.js';
import * as conversationController from '../controllers/conversation.controller.js';
import { sendMessageSchema } from '../validators/conversation.validator.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

const router = Router();

router.post('/message', authenticate, validate(sendMessageSchema), conversationController.sendMessage);
router.post('/upload', authenticate, upload.single('file'), conversationController.uploadDocument);

// An image arrives here as base64, so it needs more room than a chat message.
router.post(
  '/detect-edges',
  authenticate,
  express.json({ limit: `${env.MAX_UPLOAD_SIZE_MB}mb` }),
  conversationController.detectDocumentEdges,
);

export default router;
