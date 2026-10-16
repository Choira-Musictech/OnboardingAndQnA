// ==================================================================
// E-sign controller - thin request dispatching and response formatting.
// ==================================================================
import { env } from '../../../config/env.js';
import { ok } from '../../../shared/response.js';
import { applicationPdfService } from '../services/applicationPdf.service.js';
import { esignService } from '../services/esign.service.js';

// The member's own application form, exactly as it will be sent for signing.
export const preview = async (req, res, next) => {
  try {
    const { pdf, data } = await applicationPdfService.generate(req.user.id, { ip: req.ip });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="IPRS-Application-${data.applicationNo}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdf);
  } catch (err) {
    return next(err);
  }
};

export const start = async (req, res, next) => {
  try {
    const data = await esignService.start(req.user.id, { ip: req.ip });
    return ok(res, { data });
  } catch (err) {
    return next(err);
  }
};

export const status = async (req, res, next) => {
  try {
    const data = await esignService.getStatus(req.user.id);
    return ok(res, { data });
  } catch (err) {
    return next(err);
  }
};

// emSigner sends the member's browser here (GET or POST) after signing. The member is always
// forwarded to the frontend's result page, which reads the real status from GET /esign/status.
export const emSignerReturn = async (req, res, next) => {
  try {
    const eSignId = req.query.esign ?? req.body?.esign;
    const result = await esignService.handleProviderReturn(eSignId);
    const target = new URL(env.ESIGN_RESULT_URL);
    target.searchParams.set('status', result);
    return res.redirect(302, target.toString());
  } catch (err) {
    return next(err);
  }
};
