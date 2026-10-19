// ==================================================================
// E-sign routes - the member's application form and its signing.
// ==================================================================
import { Router } from 'express';
import { authenticate } from '../../../middlewares/auth.js';
import * as esignController from '../controllers/esign.controller.js';

const router = Router();

// The providers' redirects after signing (public - the browser arrives without our token).
router.get('/emsigner/return', esignController.providerReturn);
router.post('/emsigner/return', esignController.providerReturn);
router.get('/docusign/return', esignController.providerReturn);

router.get('/preview', authenticate, esignController.preview);
router.post('/start', authenticate, esignController.start);
router.get('/status', authenticate, esignController.status);

export default router;
