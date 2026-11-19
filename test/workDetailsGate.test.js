// ==================================================================
// The release-year answer a member types for a song (workDetailsGate.js parseReleaseYear).
// No DB, no network. Run: npm test
// ==================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReleaseYear } from '../src/modules/conversation/services/typebot/workDetailsGate.js';

const NOW = new Date('2026-11-19T12:00:00Z');

test('this year, past years and 1900 are accepted', () => {
  assert.equal(parseReleaseYear('2026', NOW), 2026);
  assert.equal(parseReleaseYear('2019', NOW), 2019);
  assert.equal(parseReleaseYear('1900', NOW), 1900);
});

test('a future year is refused, including next year', () => {
  assert.equal(parseReleaseYear('2027', NOW), null);
  assert.equal(parseReleaseYear('2030', NOW), null);
  assert.equal(parseReleaseYear('9999', NOW), null);
});

test('a year before 1900 is refused', () => {
  assert.equal(parseReleaseYear('1899', NOW), null);
  assert.equal(parseReleaseYear('0000', NOW), null);
});

test('anything that is not exactly four digits is refused', () => {
  for (const answer of ['abc', '20', '20233', '', '   ', '20 26', '2026.5', '-2020', null, undefined]) {
    assert.equal(parseReleaseYear(answer, NOW), null, JSON.stringify(answer));
  }
});

test('spaces around a valid year are ignored', () => {
  assert.equal(parseReleaseYear('  2020 ', NOW), 2020);
});

test('the limit follows the current year, so it moves on at New Year', () => {
  assert.equal(parseReleaseYear('2027', new Date('2027-01-01T00:30:00Z')), 2027);
  assert.equal(parseReleaseYear('2028', new Date('2027-01-01T00:30:00Z')), null);
});

test('without a date given, the real current year is used', () => {
  const year = new Date().getFullYear();
  assert.equal(parseReleaseYear(String(year)), year);
  assert.equal(parseReleaseYear(String(year + 1)), null);
});
