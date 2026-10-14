// ==================================================================
// App_Accounts.ModifedDate is stamped on every update (node:test).
//
// The column only gets a value from the SQL default at insert, so the repositories set it on each
// update. prisma.appAccounts.update/updateMany are stubbed - no database. Run: npm test
// ==================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { registrationRepository } from '../src/modules/registration/repositories/registration.repository.js';
import { userRepository } from '../src/modules/user/repositories/user.repository.js';

let captured;

beforeEach(() => {
  captured = null;
  prisma.appAccounts.update = async (args) => { captured = args; return {}; };
  prisma.appAccounts.updateMany = async (args) => { captured = args; return { count: 1 }; };
});

const justNow = (date) => date instanceof Date && Math.abs(Date.now() - date.getTime()) < 5000;

test('a registration update stamps ModifedDate next to the saved fields', async () => {
  await registrationRepository.update(7, { LanguageName: 'Hindi(हिन्दी)' });
  assert.equal(captured.data.LanguageName, 'Hindi(हिन्दी)');
  assert.ok(justNow(captured.data.ModifedDate));
});

test('a ModifedDate passed by the caller is kept', async () => {
  const given = new Date('2020-01-01T00:00:00Z');
  await registrationRepository.update(7, { ModifedDate: given });
  assert.equal(captured.data.ModifedDate, given);
});

test('completing a registration stamps ModifedDate', async () => {
  assert.equal(await registrationRepository.markCompleted(7), true);
  assert.equal(captured.data.ApplicationStatus, 1);
  assert.ok(justNow(captured.data.ModifedDate));
});

test('a user update stamps ModifedDate', async () => {
  await userRepository.update(7, { AccountEmail: 'a@b.c' });
  assert.equal(captured.data.AccountEmail, 'a@b.c');
  assert.ok(justNow(captured.data.ModifedDate));
});
