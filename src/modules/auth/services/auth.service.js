// ==================================================================
// Auth service - OTP flow + JWT issuance + logout.
// Uses the pluggable OTP provider (mock now, SMS later) and the
// token blacklist (in-memory now, Redis later).
// Users are App_Accounts rows; AccountId is a bigint (stringified for JWT).
// ==================================================================
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { badRequestError, unauthorizedError } from '../../../shared/errors.js';
import { signAccessToken } from '../../../utils/token.js';
import { normalizePhone } from '../../../utils/phone.js';
import { userRepository } from '../../user/repositories/user.repository.js';
import { createOtpProvider } from './otp/otpProvider.factory.js';
import { tokenBlacklist } from './tokenBlacklist.js';

export function createAuthService({ otpProvider = createOtpProvider() } = {}) {
  // AccountMobile is the login identity, so every path - OTP send, OTP verify, lookup and create -
  // has to agree on one spelling of the number. Without this, "+919876543210" and "9876543210" are
  // the same person to MSG91 but two different accounts to us. See utils/phone.js.
  function toCanonicalPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw badRequestError('Invalid phone number', { errorCode: 'INVALID_PHONE' });
    return normalized;
  }

  async function sendOtp({ phone }) {
    const canonicalPhone = toCanonicalPhone(phone);
    await otpProvider.send(canonicalPhone);

    // Dev-only: echo the generated OTP so the flow can be exercised
    // without an SMS gateway. Keyed by the same canonical number send() used.
    const mockOtp =
      typeof otpProvider.getLastOtp === 'function'
        ? await otpProvider.getLastOtp(canonicalPhone)
        : null;

    return { message: 'OTP sent', ...(mockOtp ? { otp: mockOtp } : {}) };
  }

  async function verifyOtp({ phone, otp, ip, guid }) {
    const canonicalPhone = toCanonicalPhone(phone);
    const valid = await otpProvider.verify({ phone: canonicalPhone, otp });
    if (!valid) throw badRequestError('Invalid or expired OTP', { errorCode: 'INVALID_OTP' });

    let user = await userRepository.findByAccountMobile(canonicalPhone);
    if (!user) {
      try {
        user = await userRepository.create({
          AccountGroupId: 0,
          AccountMobile: canonicalPhone,
          AccountType: 'C',
        });
        // AccountId is only known once the insert returns, and the IP is only meaningful for the
        // request that actually created this account (the race loser below just logs into an
        // account someone else's request already stamped).
        user = await userRepository.update(user.AccountId, {
          AccountCode: `c-${user.AccountId}`,
          PublicIP: ip || null,
          // No frontend sends its own persisted browser id yet - fall back to a server-generated
          // one so the column is never left empty, while still honouring a real one once sent.
          GUID: guid || crypto.randomUUID(),
        });
      } catch (err) {
        // Two verify requests for the same new number can both miss the lookup above and race to
        // create. The filtered unique index on App_Accounts(AccountMobile) makes the loser fail with
        // P2002 - that member should simply be logged into the account the winner created, not shown
        // an error. (See scripts/add-unique-indexes.sql.)
        if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
        user = await userRepository.findByAccountMobile(canonicalPhone);
        if (!user) throw err;
      }
    }

    const registrationStatus = deriveRegistrationStatus(user);
    const token = signAccessToken({
      sub: String(user.AccountId),
      phone: user.AccountMobile,
      registrationStatus,
    });

    return { user: publicUser(user), token };
  }

  function logout(token) {
    const decoded = jwt.decode(token);
    if (!decoded) throw unauthorizedError('Invalid token');

    const jti = decoded.jti ?? token;
    const expiresAtMs = decoded.exp ? decoded.exp * 1000 : Date.now() + 60_000;
    tokenBlacklist.add(jti, expiresAtMs);

    return { loggedOut: true };
  }

  function isTokenBlacklisted(jti) {
    return tokenBlacklist.has(jti);
  }

  return { sendOtp, verifyOtp, logout, isTokenBlacklisted };
}

// ApplicationStatus 1 = fully registered, everything else = onboarding.
function deriveRegistrationStatus(user) {
  return user.ApplicationStatus === 1 ? 'completed' : 'started';
}

function publicUser(user) {
  return {
    id: String(user.AccountId),
    phone: user.AccountMobile,
    name: user.AccountName,
    email: user.AccountEmail,
    registrationStatus: deriveRegistrationStatus(user),
  };
}

export const authService = createAuthService();
