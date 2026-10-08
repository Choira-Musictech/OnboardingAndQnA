import { strict as assert } from 'node:assert';
import test from 'node:test';
import crypto from 'node:crypto';
import {
  formatAmount,
  generatePayuHash,
  verifyPayuHash,
  generateVerifyPaymentHash,
} from '../src/modules/payment/services/payu/payu.utils.js';
import { resolveFee, FEES_BY_REG_TYPE } from '../src/modules/payment/services/payu/feeSchedule.js';
import { registrationEmailService } from '../src/modules/registration/services/registrationEmail.service.js';

// The DB-backed tests below complete real registrations, and complete() emails IPRS and the member
// on the first transition - a test run must never send real mail.
registrationEmailService.sendCompletionEmails = async () => {};

async function makeAccount({ regType, email, name = 'PayU Tester' } = {}) {
  const { prisma } = await import('../src/shared/prisma.js');
  const account = await prisma.appAccounts.create({
    data: {
      AccountGroupId: 0,
      AccountMobile: `9${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 10)}`,
      AccountEmail: email,
      AccountName: name,
      AccountRegType: regType,
    },
  });
  return String(account.AccountId);
}

async function deleteAccount(userId) {
  const { prisma } = await import('../src/shared/prisma.js');
  await prisma.appAccountsRegPayment.deleteMany({ where: { AccountId: BigInt(userId) } });
  await prisma.appAccountsDoc.deleteMany({ where: { AccountId: BigInt(userId) } });
  await prisma.appAccountsChatJournal.deleteMany({ where: { AccountId: BigInt(userId) } }).catch(() => {});
  await prisma.appAccounts.delete({ where: { AccountId: BigInt(userId) } }).catch(() => {});
}

// PayU's reverse hash: salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key.
// Nine empty udf slots (udf10..udf2) before udf1 - getting that count wrong makes every "valid"
// callback fail signature verification.
function reverseHash({ salt, status, udf1, email, firstname, productinfo, amount, txnid, key }) {
  const seq = [salt, status, ...Array(9).fill(''), udf1, email, firstname, productinfo, amount, txnid, key];
  return crypto.createHash('sha512').update(seq.join('|')).digest('hex').toLowerCase();
}

test('formatAmount formats numbers and strings to 2 decimal places', () => {
  assert.equal(formatAmount(1000), '1000.00');
  assert.equal(formatAmount(99.5), '99.50');
  assert.equal(formatAmount('499.99'), '499.99');
  assert.equal(formatAmount(0), '0.00');
  assert.equal(formatAmount('invalid'), '0.00');
  assert.equal(formatAmount(null), '0.00');
});

test('generatePayuHash computes the exact SHA-512 hash per PayU formula', () => {
  const key = 'merchant_key_123';
  const salt = 'merchant_salt_456';
  const txnid = 'TXN_9999_1710000000_abc';
  const amount = '1000.00';
  const productinfo = 'IPRS Membership';
  const firstname = 'John Doe';
  const email = 'john@example.com';
  const udf1 = '9999';

  // Array of 17 fields: key, txnid, amount, productinfo, firstname, email, udf1..udf10, salt
  const expectedSequence = [
    key,
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    udf1,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    salt,
  ].join('|');
  const expectedHash = crypto.createHash('sha512').update(expectedSequence).digest('hex').toLowerCase();

  const generatedHash = generatePayuHash({
    key,
    txnid,
    amount: 1000,
    productinfo,
    firstname,
    email,
    udf1,
    salt,
  });

  assert.equal(generatedHash, expectedHash);
  assert.equal(generatedHash.length, 128); // 512 bits in hex
});

test('verifyPayuHash validates a correct reverse hash without additionalCharges', () => {
  const key = 'test_key';
  const salt = 'test_salt';
  const txnid = 'TXN_12345';
  const amount = '1000.00';
  const productinfo = 'Membership Fee';
  const firstname = 'Alice';
  const email = 'alice@example.com';
  const status = 'success';
  const udf1 = '42';

  // Reverse hash formula: salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key
  const reverseSequence = [
    salt,
    status,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    udf1,
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key,
  ].join('|');
  const validHash = crypto.createHash('sha512').update(reverseSequence).digest('hex').toLowerCase();

  const payuResponse = {
    key,
    txnid,
    amount: '1000.00',
    productinfo,
    firstname,
    email,
    status,
    udf1,
    hash: validHash,
    mihpayid: '9876543210',
    mode: 'UPI',
    bank_ref_num: 'BANK_REF_001',
  };

  assert.equal(verifyPayuHash(payuResponse, salt), true);
});

test('verifyPayuHash validates a correct reverse hash with additionalCharges', () => {
  const key = 'test_key';
  const salt = 'test_salt';
  const txnid = 'TXN_67890';
  const amount = '1000.00';
  const additionalCharges = '20.00';
  const productinfo = 'Membership Fee';
  const firstname = 'Bob';
  const email = 'bob@example.com';
  const status = 'success';

  // Reverse hash with additionalCharges:
  // additionalCharges|salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key
  const reverseSequence = [
    additionalCharges,
    salt,
    status,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key,
  ].join('|');
  const validHash = crypto.createHash('sha512').update(reverseSequence).digest('hex').toLowerCase();

  const payuResponse = {
    key,
    txnid,
    amount,
    additionalCharges,
    productinfo,
    firstname,
    email,
    status,
    hash: validHash,
  };

  assert.equal(verifyPayuHash(payuResponse, salt), true);
});

test('verifyPayuHash rejects tampered amount, status, or hash', () => {
  const key = 'test_key';
  const salt = 'test_salt';
  const txnid = 'TXN_12345';
  const amount = '1000.00';
  const productinfo = 'Membership Fee';
  const firstname = 'Alice';
  const email = 'alice@example.com';
  const status = 'success';

  const reverseSequence = [
    salt,
    status,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key,
  ].join('|');
  const validHash = crypto.createHash('sha512').update(reverseSequence).digest('hex').toLowerCase();

  // Tampered amount
  assert.equal(
    verifyPayuHash(
      { key, txnid, amount: '500.00', productinfo, firstname, email, status, hash: validHash },
      salt,
    ),
    false,
  );

  // Tampered status
  assert.equal(
    verifyPayuHash(
      { key, txnid, amount, productinfo, firstname, email, status: 'failure', hash: validHash },
      salt,
    ),
    false,
  );

  // Bogus hash
  assert.equal(
    verifyPayuHash(
      { key, txnid, amount, productinfo, firstname, email, status, hash: 'badhash123' },
      salt,
    ),
    false,
  );

  // Missing salt or payload
  assert.equal(verifyPayuHash(null, salt), false);
  assert.equal(verifyPayuHash({}, null), false);
});

test('resolveFee returns the right fee for each registration type', () => {
  for (const [regType, fee] of Object.entries(FEES_BY_REG_TYPE)) {
    assert.equal(resolveFee(regType), fee);
  }
});

test('resolveFee returns null for an unrecognised or missing role', () => {
  assert.equal(resolveFee('Some Unknown Role'), null);
  assert.equal(resolveFee(null), null);
  assert.equal(resolveFee(undefined), null);
  assert.equal(resolveFee(''), null);
});

test('resolveFee trims surrounding whitespace before matching', () => {
  assert.equal(resolveFee('  C  '), FEES_BY_REG_TYPE.C);
});

test('generateVerifyPaymentHash creates correct hash for webservice verification', () => {
  const key = 'merchant_key';
  const command = 'verify_payment';
  const var1 = 'TXN_101';
  const salt = 'merchant_salt';

  const expectedSequence = `${key}|${command}|${var1}|${salt}`;
  const expectedHash = crypto.createHash('sha512').update(expectedSequence).digest('hex').toLowerCase();

  const generated = generateVerifyPaymentHash({ key, command, var1, salt });
  assert.equal(generated, expectedHash);
});

test('POST /payment/initiate requires authentication', async () => {
  const { app } = await import('../src/app.js');
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/payment/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1000 }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'UNAUTHORIZED');
  } finally {
    server.close();
  }
});

test('POST /payment/callback rejects missing or invalid payload', async () => {
  const { app } = await import('../src/app.js');
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/payment/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txnid: 'TXN_NON_EXISTENT', hash: 'badhash' }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
  } finally {
    server.close();
  }
});

test('End-to-end dummy payment flow with PayU test credentials', async () => {
  const { app } = await import('../src/app.js');
  const { env } = await import('../src/config/env.js');
  const { signAccessToken } = await import('../src/utils/token.js');

  const regType = 'I';
  const expectedFee = FEES_BY_REG_TYPE[regType]; // 1200
  const expectedAmount = formatAmount(expectedFee);
  const accountName = 'PayU Tester';
  const accountEmail = `payu.e2e.${Date.now()}@example.com`;

  const userId = await makeAccount({ regType, email: accountEmail, name: accountName });
  const token = signAccessToken({ sub: userId, phone: '9999999999', registrationStatus: 'started' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Initiate payment - no amount is sent by the client; it comes entirely from the account's
    // own registration type (AccountRegType), via feeSchedule.js.
    const initRes = await fetch(`${baseUrl}/payment/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ productInfo: 'IPRS Test Membership Fee' }),
    });

    assert.equal(initRes.status, 200);
    const initBody = await initRes.json();
    assert.equal(initBody.success, true);
    assert.ok(initBody.data.txnId);
    assert.equal(initBody.data.key, env.PAYU_KEY);
    assert.equal(initBody.data.amount, expectedAmount, 'amount is the role fee, not a client-supplied value');
    assert.ok(initBody.data.hash);
    assert.ok(initBody.data.actionUrl.includes('test.payu.in'));
    // surl/furl must be OUR backend's own callback endpoint, not a frontend or PayU-owned page -
    // that's the only way PayU's postback ever reaches /payment/callback at all.
    assert.equal(initBody.data.params.surl, env.PAYU_CALLBACK_URL);
    assert.equal(initBody.data.params.furl, env.PAYU_CALLBACK_URL);

    const txnId = initBody.data.txnId;

    // 2. Verify hash formula matches with env.PAYU_KEY and env.PAYU_SALT
    const expectedOutgoingHash = generatePayuHash({
      key: env.PAYU_KEY,
      txnid: txnId,
      amount: expectedAmount,
      productinfo: 'IPRS Test Membership Fee',
      firstname: accountName,
      email: accountEmail,
      udf1: userId,
      salt: env.PAYU_SALT,
    });
    assert.equal(initBody.data.hash, expectedOutgoingHash);

    // 3. Simulate PayU Webhook / Callback POST (Success)
    const mihpayid = `TEST_${Date.now()}`;
    const bankRefNum = `BRN_${Date.now()}`;
    const status = 'success';

    // Reverse hash sequence: salt|status|udf10..udf1|email|firstname|productinfo|amount|txnid|key
    const reverseSeq = [
      env.PAYU_SALT,
      status,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      userId, // udf1
      accountEmail,
      accountName,
      'IPRS Test Membership Fee',
      expectedAmount,
      txnId,
      env.PAYU_KEY,
    ].join('|');
    const callbackHash = crypto.createHash('sha512').update(reverseSeq).digest('hex').toLowerCase();

    const callbackPayload = {
      txnid: txnId,
      status,
      amount: expectedAmount,
      productinfo: 'IPRS Test Membership Fee',
      firstname: accountName,
      email: accountEmail,
      udf1: userId,
      mihpayid,
      mode: 'UPI',
      bank_ref_num: bankRefNum,
      key: env.PAYU_KEY,
      hash: callbackHash,
    };

    const cbRes = await fetch(`${baseUrl}/payment/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(callbackPayload),
    });

    assert.equal(cbRes.status, 200);
    const cbBody = await cbRes.json();
    assert.equal(cbBody.success, true);
    assert.equal(cbBody.data.status, 'SUCCESS');
    assert.equal(cbBody.data.mihPayId, mihpayid);

    // 4. Verify status endpoint
    const statusRes = await fetch(`${baseUrl}/payment/status/${txnId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.data.status, 'SUCCESS');
    assert.equal(statusBody.data.txnId, txnId);

    // 5. Verify history endpoint
    const histRes = await fetch(`${baseUrl}/payment/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json();
    assert.ok(Array.isArray(histBody.data));
    const found = histBody.data.find((p) => p.txnId === txnId);
    assert.ok(found, 'Transaction must be present in payment history');
    assert.equal(found.status, 'SUCCESS');
  } finally {
    server.close();
    await deleteAccount(userId);
  }
});

test('a client-supplied amount is ignored - the fee always comes from the role on file', async () => {
  const { app } = await import('../src/app.js');
  const { signAccessToken } = await import('../src/utils/token.js');

  const regType = 'NC';
  const expectedAmount = formatAmount(FEES_BY_REG_TYPE[regType]); // 3700.00
  const userId = await makeAccount({ regType, email: `payu.override.${Date.now()}@example.com` });
  const token = signAccessToken({ sub: userId, phone: '9999999999', registrationStatus: 'started' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/payment/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ amount: 1, productInfo: 'trying to pay 1 rupee' }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.amount, expectedAmount, 'the client-sent amount=1 must be ignored entirely');
  } finally {
    server.close();
    await deleteAccount(userId);
  }
});

test('initiate refuses to start a payment before the role question has been answered', async () => {
  const { app } = await import('../src/app.js');
  const { signAccessToken } = await import('../src/utils/token.js');

  const userId = await makeAccount({ regType: null, email: `payu.norole.${Date.now()}@example.com` });
  const token = signAccessToken({ sub: userId, phone: '9999999999', registrationStatus: 'started' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${baseUrl}/payment/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'REGISTRATION_INCOMPLETE');
  } finally {
    server.close();
    await deleteAccount(userId);
  }
});

test('registrationService.complete() refuses to finish a registration with no successful payment', async () => {
  const { prisma } = await import('../src/shared/prisma.js');
  const { registrationService } = await import('../src/modules/registration/services/registration.service.js');

  const userId = await makeAccount({ email: `payu.complete.${Date.now()}@example.com` });

  // Everything else complete() checks for (email + identity/bank/address-proof docs) - so the
  // payment check below is the only thing left that can fail.
  await prisma.appAccountsDoc.createMany({
    data: [
      { AccountId: BigInt(userId), DocumentName: 'PAN', DocumentCaption: 'https://example.com/pan.jpg' },
      { AccountId: BigInt(userId), DocumentName: 'BANK', DocumentCaption: 'https://example.com/bank.jpg' },
      {
        AccountId: BigInt(userId),
        DocumentName: 'PERMANENT_ADDRESS_PROOF',
        DocumentCaption: 'https://example.com/addr.jpg',
      },
    ],
  });

  try {
    await assert.rejects(
      () => registrationService.complete(userId, userId),
      (err) => {
        assert.equal(err.errorCode, 'REGISTRATION_INCOMPLETE');
        assert.ok(err.details?.missing?.includes('payment'), `expected "payment" in ${JSON.stringify(err.details?.missing)}`);
        return true;
      },
    );

    // PaymentStatus 1 (unconfirmed - covers both "still pending" and "failed", see
    // payment.service.js's module doc comment) must not count either.
    await prisma.appAccountsRegPayment.create({
      data: { AccountId: BigInt(userId), TransactionNo: `TXN_UNCONFIRMED_${userId}`, PaymentAmount: 1200, PaymentStatus: 1 },
    });
    await assert.rejects(() => registrationService.complete(userId, userId), (err) => {
      assert.ok(err.details?.missing?.includes('payment'));
      return true;
    });

    // Now a real SUCCESS payment - completion should go through.
    await prisma.appAccountsRegPayment.create({
      data: { AccountId: BigInt(userId), TransactionNo: `TXN_SUCCESS_${userId}`, PaymentAmount: 1200, PaymentStatus: 0 },
    });
    const result = await registrationService.complete(userId, userId);
    assert.ok(result);

    const account = await prisma.appAccounts.findUnique({ where: { AccountId: BigInt(userId) } });
    assert.equal(account.ApplicationStatus, 1);
  } finally {
    await deleteAccount(userId);
  }
});

test('hasSuccessfulPayment only counts a SUCCESS row', async () => {
  const { prisma } = await import('../src/shared/prisma.js');
  const { paymentService } = await import('../src/modules/payment/services/payment.service.js');

  const userId = await makeAccount({ email: `payu.haspaid.${Date.now()}@example.com` });

  try {
    assert.equal(await paymentService.hasSuccessfulPayment(userId), false, 'no rows at all');

    await prisma.appAccountsRegPayment.create({
      data: { AccountId: BigInt(userId), TransactionNo: `TXN_F_${userId}`, PaymentAmount: 1200, PaymentStatus: 1 },
    });
    assert.equal(await paymentService.hasSuccessfulPayment(userId), false, 'FAILED does not count');

    await prisma.appAccountsRegPayment.create({
      data: { AccountId: BigInt(userId), TransactionNo: `TXN_S_${userId}`, PaymentAmount: 1200, PaymentStatus: 0 },
    });
    assert.equal(await paymentService.hasSuccessfulPayment(userId), true);
  } finally {
    await deleteAccount(userId);
  }
});

test('initiate refuses a second payment once one has succeeded', async () => {
  const { prisma } = await import('../src/shared/prisma.js');
  const { app } = await import('../src/app.js');
  const { signAccessToken } = await import('../src/utils/token.js');

  const regType = 'I';
  const userId = await makeAccount({ regType, email: `payu.dupe.${Date.now()}@example.com` });
  const token = signAccessToken({ sub: userId, phone: '9999999999', registrationStatus: 'started' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const initiate = () =>
    fetch(`${baseUrl}/payment/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });

  try {
    // An abandoned PayU page leaves its row at PaymentStatus 1 (unconfirmed) - that must never
    // lock the member out of retrying (see payment.service.js's module doc comment).
    const firstRes = await initiate();
    assert.equal(firstRes.status, 200, 'a PaymentStatus 1 (unconfirmed) attempt must still allow a retry');
    const firstTxnId = (await firstRes.json()).data.txnId;
    const abandoned = await prisma.appAccountsRegPayment.findUnique({ where: { TransactionNo: firstTxnId } });
    assert.ok(abandoned, 'initiate must create its row immediately');
    assert.equal(abandoned.PaymentStatus, 1);

    await prisma.appAccountsRegPayment.create({
      data: { AccountId: BigInt(userId), TransactionNo: `TXN_PAID_${userId}`, PaymentAmount: 1200, PaymentStatus: 0 },
    });

    const res = await initiate();
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'PAYMENT_ALREADY_COMPLETED');
  } finally {
    server.close();
    await deleteAccount(userId);
  }
});

test('a successful callback clears the Typebot session and journal once the registration completes', async () => {
  const { prisma } = await import('../src/shared/prisma.js');
  const { env } = await import('../src/config/env.js');
  const { app } = await import('../src/app.js');
  const { signAccessToken } = await import('../src/utils/token.js');
  const { typebotSessionStore } = await import('../src/modules/conversation/services/typebot/typebotSessionStore.js');

  const regType = 'I';
  const productinfo = 'IPRS Test Membership Fee';
  const accountName = 'PayU Tester';
  const accountEmail = `payu.cleanup.${Date.now()}@example.com`;
  const userId = await makeAccount({ regType, email: accountEmail, name: accountName });
  const token = signAccessToken({ sub: userId, phone: '9999999999', registrationStatus: 'started' });

  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Everything complete() needs apart from the payment itself.
    await prisma.appAccountsDoc.createMany({
      data: [
        { AccountId: BigInt(userId), DocumentName: 'PAN', DocumentCaption: 'https://example.com/pan.jpg' },
        { AccountId: BigInt(userId), DocumentName: 'BANK', DocumentCaption: 'https://example.com/bank.jpg' },
        { AccountId: BigInt(userId), DocumentName: 'PERMANENT_ADDRESS_PROOF', DocumentCaption: 'https://example.com/a.jpg' },
      ],
    });
    await prisma.appAccountsChatJournal.create({
      data: { AccountId: BigInt(userId), TurnIndex: 0, BlockId: 'someblockid', Answer: 'Yes' },
    });
    // The member is parked on the payment button, exactly as they are when checkout starts.
    typebotSessionStore.set(userId, {
      sessionId: 'sess-cleanup',
      input: { id: 'mqd5zfukd99nkczylu206jo1', type: 'choice input' },
    });

    const initBody = await (await fetch(`${baseUrl}/payment/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ productInfo: productinfo }),
    })).json();
    const txnId = initBody.data.txnId;
    const amount = initBody.data.amount;

    const cbRes = await fetch(`${baseUrl}/payment/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        txnid: txnId,
        status: 'success',
        amount,
        productinfo,
        firstname: accountName,
        email: accountEmail,
        udf1: userId,
        mihpayid: `TEST_${Date.now()}`,
        mode: 'UPI',
        key: env.PAYU_KEY,
        hash: reverseHash({
          salt: env.PAYU_SALT,
          status: 'success',
          udf1: userId,
          email: accountEmail,
          firstname: accountName,
          productinfo,
          amount,
          txnid: txnId,
          key: env.PAYU_KEY,
        }),
      }),
    });
    assert.equal(cbRes.status, 200);

    const account = await prisma.appAccounts.findUnique({ where: { AccountId: BigInt(userId) } });
    assert.equal(account.ApplicationStatus, 1, 'registration should have completed');

    assert.equal(typebotSessionStore.get(userId), null, 'dangling Typebot session must be cleared');
    const journalRows = await prisma.appAccountsChatJournal.count({ where: { AccountId: BigInt(userId) } });
    assert.equal(journalRows, 0, 'journal must be cleared once the registration is complete');
  } finally {
    server.close();
    typebotSessionStore.clear(userId);
    await deleteAccount(userId);
  }
});
