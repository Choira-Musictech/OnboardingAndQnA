// ==================================================================
// POST /auth/send-otp waits per phone number (node:test). Stub provider and a fake clock - no DB, no SMS.
// Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../src/modules/auth/services/auth.service.js';

function setup({ cooldownSeconds = 60, failSend = false } = {}) {
  const sent = [];
  const clock = { ms: 1_000_000 };
  const otpProvider = {
    send: async (phone) => {
      if (failSend) throw new Error('gateway down');
      sent.push(phone);
    },
  };
  const service = createAuthService({ otpProvider, cooldownSeconds, now: () => clock.ms });
  return { service, sent, clock };
}

test('a second code for the same number inside the wait is refused, with the seconds left', async () => {
  const { service, sent, clock } = setup();
  await service.sendOtp({ phone: '9876543210' });
  clock.ms += 20_000;

  await assert.rejects(service.sendOtp({ phone: '9876543210' }), (err) => {
    assert.equal(err.statusCode, 400);
    assert.equal(err.errorCode, 'OTP_COOLDOWN');
    assert.equal(err.message, 'Please wait 40 seconds before requesting another OTP.');
    assert.equal(err.details.retryAfterSeconds, 40);
    return true;
  });
  assert.equal(sent.length, 1, 'nothing was sent the second time');
});

test('after the wait the number can be sent a code again, and the wait restarts', async () => {
  const { service, sent, clock } = setup();
  await service.sendOtp({ phone: '9876543210' });
  clock.ms += 60_000;
  await service.sendOtp({ phone: '9876543210' });
  assert.equal(sent.length, 2);

  clock.ms += 1_000;
  await assert.rejects(service.sendOtp({ phone: '9876543210' }), /Please wait 59 seconds/);
});

test('one second left reads "1 second"', async () => {
  const { service, clock } = setup();
  await service.sendOtp({ phone: '9876543210' });
  clock.ms += 59_000;
  await assert.rejects(service.sendOtp({ phone: '9876543210' }), /Please wait 1 second before/);
});

test('a different number is not held up', async () => {
  const { service, sent } = setup();
  await service.sendOtp({ phone: '9876543210' });
  await service.sendOtp({ phone: '9123456780' });
  assert.equal(sent.length, 2);
});

test('+91, 91 and the bare number are one number and share the wait', async () => {
  const { service } = setup();
  await service.sendOtp({ phone: '+919876543210' });
  await assert.rejects(service.sendOtp({ phone: '9876543210' }), /Please wait/);
  await assert.rejects(service.sendOtp({ phone: '919876543210' }), /Please wait/);
});

test('a send that fails does not start the wait', async () => {
  const failing = setup({ failSend: true });
  await assert.rejects(failing.service.sendOtp({ phone: '9876543210' }), /gateway down/);
  await assert.rejects(failing.service.sendOtp({ phone: '9876543210' }), /gateway down/, 'still tries, not "please wait"');
});

test('a wait of 0 turns the check off', async () => {
  const { service, sent } = setup({ cooldownSeconds: 0 });
  await service.sendOtp({ phone: '9876543210' });
  await service.sendOtp({ phone: '9876543210' });
  assert.equal(sent.length, 2);
});

test('the reply says how long the wait is, so the login screen can count it down', async () => {
  const { service } = setup({ cooldownSeconds: 30 });
  const res = await service.sendOtp({ phone: '9876543210' });
  assert.equal(res.resendAfterSeconds, 30);

  const off = setup({ cooldownSeconds: 0 });
  assert.equal((await off.service.sendOtp({ phone: '9876543210' })).resendAfterSeconds, undefined);
});
