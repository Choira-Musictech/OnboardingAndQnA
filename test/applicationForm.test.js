// ==================================================================
// The IPRS application form sent for e-signing (node:test): the values read from the database,
// and the HTML they are laid out in. Repositories and the photo download are stubbed - no
// database, no network, no browser. Run: npm test
// ==================================================================
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registrationRepository } from '../src/modules/registration/repositories/registration.repository.js';
import { workRepository } from '../src/modules/work/repositories/work.repository.js';
import { esignRepository } from '../src/modules/esign/repositories/esign.repository.js';
import {
  applicationDataService,
  formatBirthDate,
  formatDate,
  formatDateTime,
  formatMobile,
} from '../src/modules/esign/services/applicationData.service.js';
import { escapeHtml, renderApplicationForm, SIGNATURE_BOX } from '../src/modules/esign/templates/applicationForm.js';

const INDIVIDUAL = {
  AccountId: 20490n,
  AccountRegType: 'I',
  RollTypeIds: '2,1',
  AccountName: 'Uday Rajkumar Singh',
  AccountAlias: 'Uday',
  Detail2: 'iiups8911n',
  Nationality: 'Indian',
  FatherName: 'Rajkumar Singh',
  PlaceOfBirth: 'Mumbai',
  DOB: new Date('1999-02-22T00:00:00Z'),
  AccountMobile: '919892807545',
  AccountEmail: 'member@example.com',
  Gender: 'MALE',
  AccountAddress: 'Hanuman Chawl, Kandivali East 400101',
  Pincode: '400101',
  AccountAddress_PR: 'Hanuman Chawl, Kandivali East 400101',
  Pincode_PR: '400101',
  TeritoryAppFor: '2136',
  AssociationName_India: null,
  BankName: 'Union Bank of India',
  BankAcNo: '696702010006282',
  BankIFSCCode: 'UBIN0569674',
  BankBranchName: 'Kandivali',
  MicrCode: '400026176',
  BankAccountName: 'Uday Rajkumar Singh',
  PublicIP: '103.216.70.150',
  GUID: 'd83f2da0-2cef-4aa0-94a5-1137742f60d7',
  CreateDate: new Date('2026-10-14T08:01:47Z'),
};

const COMPANY = {
  ...INDIVIDUAL,
  AccountId: 25651n,
  AccountRegType: 'C',
  RollTypeIds: '4',
  EntityType: 'CP',
  AccountName: 'JP Motion Pictures Private Limited',
  AccountAlias: 'Soul Music Bhojpuri',
  FirstName: null,
  LastName: null,
};

let account;
let documents;
let works;

beforeEach(() => {
  account = { ...INDIVIDUAL };
  documents = [
    { DocumentName: 'PAN', DocumentLookupId: 1n, DocumentCaption: 'https://files.example/pan.png' },
    { DocumentName: 'BANK', DocumentLookupId: 2n, DocumentCaption: 'https://files.example/bank.png' },
  ];
  works = [
    {
      SongName: 'Vaaste',
      Film_AlbumName: 'Film',
      LanguageNames: 'hindi',
      WorkCategory: 'Non Film',
      Artist_Singers: 'Dhvani Bhanushali',
      Author_Composer: 'Tanishk Bagchi',
      Publisher: 'T Series',
      Author_Lyricist: 'Arafat Mehmood',
      DigitalLink: 'https://youtu.be/BBAyRBTfsOU',
      DocLink: null,
      ReleaseYear: '2019',
    },
  ];
  registrationRepository.findByAccountId = async () => account;
  registrationRepository.findDocumentsByAccountId = async () => documents;
  workRepository.findByAccountId = async () => works;
  esignRepository.findDocumentLookupNames = async () => new Map([['1', 'Identity Proof (Pan Card).']]);
});

const build = (options = {}) =>
  applicationDataService.buildApplicationData('20490', { signedAt: new Date('2026-10-01T11:51:00Z'), ...options });

test('dates, mobile numbers and birth dates are printed the way IPRS forms print them', () => {
  assert.equal(formatDate(new Date('2026-10-01T11:51:00Z')), '01-10-2026');
  assert.equal(formatDateTime(new Date('2026-10-01T11:51:00Z')), '01-10-2026 05:21:00 PM', 'India time');
  assert.equal(formatBirthDate(new Date('2001-10-02T00:00:00Z')), '02-Oct-2001');
  assert.equal(formatMobile('919892807545'), '+91-9892807545');
  assert.equal(formatMobile(null), '');
});

test('an individual author gets the author wording, block letters and their own details', async () => {
  const data = await build();

  assert.equal(data.variant, 'individual');
  assert.equal(data.roleType, 'AUTHOR (MUSIC COMPOSER / MUSICAL WORKS), AUTHOR (LYRICIST / LYRICAL WORKS)');
  assert.equal(data.declarationRoles, 'Author (Music Composer / Musical Works), Author (Lyricist / Lyrical Works)');
  assert.equal(data.isPublisher, false);
  assert.equal(data.applicationNo, '20490');
  assert.equal(data.fullName, 'UDAY RAJKUMAR SINGH');
  assert.equal(data.pan, 'IIUPS8911N');
  assert.equal(data.gst, 'NA');
  assert.equal(data.dob, '22-Feb-1999');
  assert.equal(data.email, 'MEMBER@EXAMPLE.COM');
  assert.equal(data.addresses.firstLabel, 'Permanent Address');
  assert.equal(data.addresses.first.country, 'INDIA');
  assert.equal(data.other.territory, 'WORLD');
  assert.equal(data.other.indiaAssociation, 'NA');
  assert.equal(data.bank.currency, 'INDIAN RUPEES');
  assert.equal(data.signing.ip, '103.216.70.150');
  assert.equal(data.signing.date, '01-10-2026 05:21:00 PM');
});

test('the IP and GUID of this signing win over what is on the account', async () => {
  const data = await build({ ip: '10.0.0.9', guid: 'signing-guid' });
  assert.equal(data.signing.ip, '10.0.0.9');
  assert.equal(data.signing.guid, 'signing-guid');
});

test('a company prints its name as the company, the publisher wording and its entity type', async () => {
  account = { ...COMPANY };
  const data = await build();

  assert.equal(data.variant, 'company');
  assert.equal(data.roleType, 'PUBLISHER (Corporate (Pvt Ltd/Ltd Company) )');
  assert.equal(data.isPublisher, true);
  assert.equal(data.companyName, 'JP MOTION PICTURES PRIVATE LIMITED');
  assert.equal(data.fullName, '', 'no person name is known for the company');
  assert.equal(data.addresses.firstLabel, 'Registered Address');
  assert.equal(data.addresses.secondLabel, 'Communication Address');
});

test('documents use IPRS lookup names when known and the app labels otherwise; works are listed', async () => {
  const data = await build();

  assert.deepEqual(data.documents, [
    { name: 'Identity Proof (Pan Card).', url: 'https://files.example/pan.png' },
    { name: 'Bank passbook / cheque', url: 'https://files.example/bank.png' },
  ]);
  assert.equal(data.works.length, 1);
  assert.equal(data.works[0].songName, 'VAASTE');
  assert.equal(data.works[0].languages, 'HINDI');
  assert.equal(data.works[0].digitalLink, 'https://youtu.be/BBAyRBTfsOU', 'links keep their case');
});

test('the photo is embedded when it loads and simply left out when it does not', async () => {
  documents.push({ DocumentName: 'PROFILE_PHOTO', DocumentLookupId: 102n, DocumentCaption: 'https://files.example/me.jpg' });
  const ok = async () => new Response(Buffer.from('jpegbytes'), { headers: { 'content-type': 'image/jpeg' } });
  const withPhoto = await build({ fetchImpl: ok });
  assert.equal(withPhoto.photo, `data:image/jpeg;base64,${Buffer.from('jpegbytes').toString('base64')}`);

  const broken = async () => new Response('nope', { status: 404 });
  const withoutPhoto = await build({ fetchImpl: broken });
  assert.equal(withoutPhoto.photo, null);
});

test('a member with no account row cannot get a form', async () => {
  account = null;
  await assert.rejects(build(), /Registration not found/);
});

test('the form has all five parts, the signature anchor, and escapes what the member typed', async () => {
  account = { ...INDIVIDUAL, AccountAlias: '<script>alert(1)</script>' };
  const html = renderApplicationForm(await build());

  for (const part of ['PART 1', 'PART 3', 'PART 4', 'PART 5', 'PART 7', 'PART 8']) assert.ok(html.includes(part), part);
  assert.ok(html.includes('Approving Director Signature'));
  assert.ok(html.includes(SIGNATURE_BOX.anchorText));
  assert.ok(html.includes('&lt;SCRIPT&gt;'), 'the alias is escaped');
  assert.ok(!html.includes('<script>alert'), 'no raw markup from member data');
  assert.ok(html.includes('href="https://youtu.be/BBAyRBTfsOU"'));
});

test('only http(s) links become links', async () => {
  works[0].DigitalLink = 'javascript:alert(1)';
  const html = renderApplicationForm(await build());
  assert.ok(!html.includes('href="javascript:'));
});

test('the signature box sits on page 3, inside the page', () => {
  assert.equal(SIGNATURE_BOX.page, 3);
  const { left, top, width, height } = SIGNATURE_BOX.mm;
  assert.ok(left + width <= 210 && top + height <= 297, 'inside an A4 page');
  assert.equal(escapeHtml(`a"b'<`), 'a&quot;b&#39;&lt;');
});
