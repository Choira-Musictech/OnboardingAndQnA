// ==================================================================
// Document routes.
//
// Deliberately NOT behind `authenticate`: a browser cannot put an
// Authorization header on <img src>, <object data> or pdf.js's own fetch, so
// the signed, expiring link is the credential instead - see
// documentLink.service.js.
// ==================================================================
import { Router } from 'express';
import * as documentController from '../controllers/document.controller.js';

const router = Router();

// The file name is cosmetic for serving, but the chat reads the document's type
// from its extension, so it has to be part of the path.
router.get('/:accountDocId/:fileName', documentController.streamDocument);

export default router;
