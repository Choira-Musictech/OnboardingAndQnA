// ==================================================================
// The mother-tongue list (node:test): labels like `Hindi(हिन्दी)`, resolving a label (or a plain
// name) to its LanguageId, and the data the list is built from.
//
// prisma.appLanguageLookup.findMany is stubbed - no database. Run: npm test
// ==================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prisma } from '../src/shared/prisma.js';
import {
  languageLookupService,
  primaryNativeName,
  buildLanguageLabel,
} from '../src/modules/registration/services/languageLookup.service.js';

const ROWS = [
  { LanguageId: 59n, LanguageName: 'Hindi', NativeName: 'हिन्दी, हिंदी' },
  { LanguageId: 25n, LanguageName: 'Catalan, Valencian', NativeName: 'català, valencià' },
  { LanguageId: 56n, LanguageName: 'Hausa', NativeName: '(Hausa) هَوُسَ' },
  { LanguageId: 29n, LanguageName: 'Chinese', NativeName: '中文 (Zhōngwén), 汉语, 漢語' },
  { LanguageId: 40n, LanguageName: 'English', NativeName: 'English' },
  { LanguageId: 193n, LanguageName: 'Manipuri (Meitei)', NativeName: 'ꯃꯤꯇꯩꯂꯣꯟ' },
  { LanguageId: 19n, LanguageName: 'Bengali', NativeName: 'বাংলা' },
  { LanguageId: 184n, LanguageName: 'Nyishi', NativeName: 'Nyishi' },
];

beforeEach(() => {
  languageLookupService.resetLanguageCache();
  prisma.appLanguageLookup.findMany = async () => ROWS.map((row) => ({ ...row }));
});

test('the first real native name is shown, without brackets or alternatives', () => {
  assert.equal(primaryNativeName('हिन्दी, हिंदी'), 'हिन्दी');
  assert.equal(primaryNativeName('(Hausa) هَوُسَ'), 'هَوُسَ');
  assert.equal(primaryNativeName('中文 (Zhōngwén), 汉语, 漢語'), '中文');
  assert.equal(primaryNativeName('(originally:) Occidental, (after WWII:) Interlingue'), 'Occidental');
  assert.equal(primaryNativeName(''), '');
  assert.equal(primaryNativeName(null), '');
});

test('a label is LanguageName(NativeName); a native name that is just the English name is left out', () => {
  assert.equal(buildLanguageLabel(ROWS[0]), 'Hindi(हिन्दी)');
  assert.equal(buildLanguageLabel(ROWS[1]), 'Catalan, Valencian(català)');
  assert.equal(buildLanguageLabel(ROWS[2]), 'Hausa(هَوُسَ)');
  assert.equal(buildLanguageLabel(ROWS[3]), 'Chinese(中文)');
  assert.equal(buildLanguageLabel(ROWS[4]), 'English');
  assert.equal(buildLanguageLabel(ROWS[7]), 'Nyishi');
  assert.equal(buildLanguageLabel({ LanguageName: 'Khasi', NativeName: null }), 'Khasi');
});

test('listLanguages gives the picker every row with its label, in alphabetical order of the stub', async () => {
  const list = await languageLookupService.listLanguages();
  assert.equal(list.length, ROWS.length);
  assert.deepEqual(list.find((l) => l.id === '59'), {
    id: '59',
    label: 'Hindi(हिन्दी)',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    aliases: [],
  });
  assert.deepEqual(list.find((l) => l.id === '19').aliases, ['bangla'], 'Bengali is also searched as Bangla');
});

test('a label resolves to its row and gives back the same canonical label', async () => {
  assert.deepEqual(await languageLookupService.resolveLanguage('Hindi(हिन्दी)'), { id: 59n, label: 'Hindi(हिन्दी)' });
  assert.deepEqual(await languageLookupService.resolveLanguage('Catalan, Valencian(català)'), {
    id: 25n,
    label: 'Catalan, Valencian(català)',
  });
  assert.deepEqual(await languageLookupService.resolveLanguage('Manipuri (Meitei)(ꯃꯤꯇꯩꯂꯣꯟ)'), {
    id: 193n,
    label: 'Manipuri (Meitei)(ꯃꯤꯇꯩꯂꯣꯟ)',
  });
});

test('a plain name from another client resolves to the same row and the same label', async () => {
  assert.deepEqual(await languageLookupService.resolveLanguage('hindi'), { id: 59n, label: 'Hindi(हिन्दी)' });
  assert.deepEqual(await languageLookupService.resolveLanguage('Catalan'), { id: 25n, label: 'Catalan, Valencian(català)' });
  assert.deepEqual(await languageLookupService.resolveLanguage('Manipuri'), { id: 193n, label: 'Manipuri (Meitei)(ꯃꯤꯇꯩꯂꯣꯟ)' });
  assert.deepEqual(await languageLookupService.resolveLanguage('bangla'), { id: 19n, label: 'Bengali(বাংলা)' });
  assert.equal(await languageLookupService.resolveLanguageId('English'), 40n);
});

test('something that is not in the list resolves to null, never a guess', async () => {
  assert.equal(await languageLookupService.resolveLanguage('Bhojpuri'), null);
  assert.equal(await languageLookupService.resolveLanguage('Hindi(English)'), null);
  assert.equal(await languageLookupService.resolveLanguage('   '), null);
});

test('two languages with the same label are refused rather than left ambiguous', async () => {
  prisma.appLanguageLookup.findMany = async () => [
    { LanguageId: 1n, LanguageName: 'Hmar', NativeName: 'Hmar' },
    { LanguageId: 2n, LanguageName: 'hmar', NativeName: 'HMAR' },
  ];
  await assert.rejects(languageLookupService.listLanguages(), /two languages labelled/);
  assert.equal(await languageLookupService.resolveLanguage('Hmar'), null, 'resolving never throws');
});

// --- the data itself -------------------------------------------------------

function seedRows() {
  const Q = "'";
  const rows = [];
  for (const line of fs.readFileSync('scripts/add-language-lookup-table.sql', 'utf8').split(/\r?\n/)) {
    if (!/^\s*\(\d+,\s*N/.test(line)) continue;
    const out = [];
    let i = line.indexOf('(') + 1;
    const idm = /^\s*(\d+)\s*,/.exec(line.slice(i));
    out.push(Number(idm[1]));
    i += idm[0].length;
    while (i < line.length) {
      while (line[i] === ' ' || line[i] === ',') i++;
      if (line.startsWith('NULL', i)) { out.push(null); i += 4; continue; }
      if (line[i] === 'N' && line[i + 1] === Q) {
        i += 2;
        let v = '';
        while (i < line.length) {
          if (line[i] === Q) { if (line[i + 1] === Q) { v += Q; i += 2; continue; } break; }
          v += line[i++];
        }
        i++;
        out.push(v);
        continue;
      }
      break;
    }
    rows.push({ LanguageId: BigInt(out[0]), LanguageFamily: out[1], LanguageName: out[2], NativeName: out[3], LanguageDesc: out[5] });
  }
  return rows;
}

// UTF-8 read as Windows-1252 leaves these lead characters behind (`à¤¹` for `ह`, `â€“` for `–`).
const MOJIBAKE = /[ÃÂÐÑØÙà][\u0080-¿‘-›€™ŒœŽžŠš]|â€/;

test('the seed data has all 218 languages, each with a real native name and no mojibake', () => {
  const rows = seedRows();
  assert.equal(rows.length, 218);
  for (const row of rows) {
    assert.ok(row.NativeName?.trim(), `row ${row.LanguageId} has no NativeName`);
    for (const column of ['NativeName', 'LanguageName', 'LanguageFamily', 'LanguageDesc']) {
      assert.ok(!MOJIBAKE.test(row[column] ?? ''), `row ${row.LanguageId} ${column} looks garbled: ${row[column]}`);
    }
  }
});

test('every seed language gets a unique label that fits App_Accounts.LanguageName (100 characters)', async () => {
  const rows = seedRows();
  prisma.appLanguageLookup.findMany = async () => rows;
  const list = await languageLookupService.listLanguages();
  assert.equal(new Set(list.map((l) => l.label)).size, 218);
  for (const { label } of list) assert.ok(label.length <= 100, `${label} is ${label.length} characters`);
});
