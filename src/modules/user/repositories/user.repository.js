// ==================================================================
// App_Accounts repository (the "user" table) - data access only.
// AccountId is a SQL Server bigint (Prisma BigInt); callers must
// pass numbers/BigInt for ids and accept BigInt in results.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

function create(data) {
  return prisma.appAccounts.create({ data });
}

function findById(accountId) {
  return prisma.appAccounts.findUnique({ where: { AccountId: BigInt(accountId) } });
}

function findByAccountMobile(mobile) {
  return prisma.appAccounts.findFirst({ where: { AccountMobile: mobile } });
}

function findByEmail(email) {
  return prisma.appAccounts.findFirst({ where: { AccountEmail: email } });
}

// ModifedDate only gets a value from the SQL default at insert, so every update stamps it itself.
function update(accountId, data) {
  return prisma.appAccounts.update({ where: { AccountId: BigInt(accountId) }, data: { ModifedDate: new Date(), ...data } });
}

function findByPhone(phone) {
  return findByAccountMobile(phone);
}

async function existsByPhone(phone) {
  const found = await prisma.appAccounts.findFirst({
    where: { AccountMobile: phone },
    select: { AccountId: true },
  });

  return Boolean(found);
}

export const userRepository = {
  create,
  findById,
  findByAccountMobile,
  findByPhone,
  existsByPhone,
  findByEmail,
  update,
};
