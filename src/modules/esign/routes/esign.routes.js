// ==================================================================
// E-sign routes - the member's application form and its signing.
// ==================================================================
import { Router } from 'express';
import { authenticate } from '../../../middlewares/auth.js';
import * as esignController from '../controllers/esign.controller.js';

const router = Router();

// emSigner's redirect after signing (public - the browser arrives without our token).
router.get('/emsigner/return', esignController.emSignerReturn);
router.post('/emsigner/return', esignController.emSignerReturn);

router.get('/preview', authenticate, esignController.preview);
router.post('/start', authenticate, esignController.start);
router.get('/status', authenticate, esignController.status);

export default router;
