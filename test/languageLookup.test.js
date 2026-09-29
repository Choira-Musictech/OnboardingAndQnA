// ==================================================================
// languageLookup.service.js (node:test).
//
// resolveLanguageId() must never guess - a real, DB-backed match or null, nothing in between.
// These tests run against the live App_Language_Lookup table (218 static rows, see
// scripts/add-language-lookup-table.sql) and skip if SQL Server isn't reachable.
// Run: npm test
// ==================================================================
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/shared/prisma.js';
import { languageLookupService } from '../src/modules/registration/services/languageLookup.service.js';

let dbAvailable = false;

before(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

test('an exact, unqualified name matches directly', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const id = await languageLookupService.resolveLanguageId('Bengali');
  assert.notEqual(id, null);
});

test('the odia/bangla/gujrati alias table still resolves against their real lookup-table spelling', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const odia = await languageLookupService.resolveLanguageId('odia');
  const bangla = await languageLookupService.resolveLanguageId('bangla');
  assert.notEqual(odia, null, 'odia -> Oriya');
  assert.notEqual(bangla, null, 'bangla -> Bengali');
});

test('a bare name matches a lookup row that carries a trailing qualifier - e.g. "Manipuri" against "Manipuri (Meitei)"', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const id = await languageLookupService.resolveLanguageId('Manipuri');
  assert.equal(id, 193n, 'row 193 is literally "Manipuri (Meitei)" - the frontend picker submits the bare name');
});

test('the full qualified name still matches too - stripping is additive, not a replacement', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const id = await languageLookupService.resolveLanguageId('Manipuri (Meitei)');
  assert.equal(id, 193n);
});

test('a language genuinely absent from the table returns null, never a guess', async (t) => {
  if (!dbAvailable) return t.skip('SQL Server is not reachable');
  const id = await languageLookupService.resolveLanguageId('Bhojpuri');
  assert.equal(id, null, 'confirmed absent from the live 218-row table - not a code bug');
});

test('empty/whitespace-only input resolves to null without hitting the DB', async () => {
  assert.equal(await languageLookupService.resolveLanguageId(''), null);
  assert.equal(await languageLookupService.resolveLanguageId('   '), null);
});
