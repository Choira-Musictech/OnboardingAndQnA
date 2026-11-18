// ==================================================================
// Serves files uploaded in the chat, kept on this server (conversation/services/flow/uploadStorage.js).
//
// Deliberately NOT behind `authenticate`: the OCR service and the browser's <img>/pdf viewer fetch
// these links without our token. The 128-bit random token in the path is the credential, as the
// public S3 links Typebot used to hand out were.
// ==================================================================
import { Router } from 'express';
import { asyncHandler } from '../../../shared/asyncHandler.js';
import * as uploadController from '../controllers/upload.controller.js';

const router = Router();

router.get('/:token/:fileName', asyncHandler(uploadController.serveUpload));

export default router;
