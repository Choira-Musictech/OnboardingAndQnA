// ==================================================================
// Who must e-sign, and whether they have. Kept apart from esign.service.js so that
// registration.service.js can ask "is the signature still missing?" in complete() without
// importing esign.service (which imports the PDF builder, which imports registration.service).
//
// Who signs with what (IPRS's own routing): AccountRegType I / C (Indian individual / company)
// sign with eMudhra emSigner Aadhaar eSign; NI / NC (NRI) sign with DocuSign embedded signing.
// ==================================================================
import { env } from '../../../config/env.js';
import { REG_TYPES } from '../../registration/services/memberRoleCodes.js';
import { esignRepository } from '../repositories/esign.repository.js';

export const ESIGN_PROVIDERS = Object.freeze({ EMSIGNER: 'EMSIGNER', DOCUSIGN: 'DOCUSIGN' });

const PROVIDER_BY_REG_TYPE = Object.freeze({
  [REG_TYPES.INDIVIDUAL]: ESIGN_PROVIDERS.EMSIGNER,
  [REG_TYPES.PUBLISHER]: ESIGN_PROVIDERS.EMSIGNER,
  [REG_TYPES.NRI_INDIVIDUAL]: ESIGN_PROVIDERS.DOCUSIGN,
  [REG_TYPES.NRI_PUBLISHER]: ESIGN_PROVIDERS.DOCUSIGN,
});

// A plain object so tests can swap a method, the same technique esign.service's esignProviders uses.
export const esignPolicy = {
  /** Which provider this account signs with (null when e-signing does not apply to them). */
  providerFor(account) {
    return PROVIDER_BY_REG_TYPE[String(account?.AccountRegType ?? '').trim()] ?? null;
  },

  /** Whether this account must sign before the registration can complete. */
  isRequiredFor(account) {
    return env.ESIGN_ENABLED && esignPolicy.providerFor(account) !== null;
  },

  /** Whether any signing attempt of this account has completed. */
  isSigned(accountId) {
    return esignRepository.hasCompletedSigning(accountId);
  },
};
