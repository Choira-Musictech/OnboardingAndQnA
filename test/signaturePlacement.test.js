// ==================================================================
// Where eMudhra is told to sign (node:test): the anchors are read from a REALLY rendered application
// PDF, so the Work Notification page's box follows that page when the works table pushes it on.
// Needs headless Chrome (puppeteer); skips when it cannot start. Run: npm test
// ==================================================================
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { applicationPdfService } from '../src/modules/esign/services/applicationPdf.service.js';
import { DECLARATION_BOX, findAnchors, signatureBoxesFor } from '../src/modules/esign/services/signaturePlacement.js';
import { WORK_PAGE_SIGNATURE } from '../src/modules/esign/templates/applicationForm.js';

const address = { line: 'Hanuman Chawl, Kandivali East', city: '', pincode: '400101', state: '', country: 'INDIA' };
const work = (i) => ({
  songName: `Song ${i}`, album: 'Album', languages: 'hindi', category: 'Film', singers: 'Singer', composer: 'Composer',
  publisher: 'Publisher', lyricist: 'Lyricist', digitalLink: `https://youtu.be/song${i}`, fileLink: '', releaseYear: '2020',
});
const form = (workCount) => ({
  variant: 'individual', roleType: 'Composer', applicationDate: '01/01/2026', applicationNo: '20490',
  fullName: 'TEST MEMBER', alias: '', pan: 'ABCDE1234F', gst: '', nationality: 'Indian', parentName: 'PARENT',
  placeOfBirth: 'MUMBAI', dob: '01/01/1990', mobile: '919999999999', altPhone: '', email: 'member@example.com',
  altEmail: '', whatsapp: '', gender: 'MALE', preferredLanguage: 'English', photo: null,
  addresses: { firstLabel: 'Communication Address', first: address, secondLabel: 'Permanent Address', second: address },
  other: {}, bank: {}, declarationRoles: 'Composer', isPublisher: false,
  signing: { date: '01/01/2026', place: '', macid: 'NA', guid: 'guid', ip: '10.0.0.1', submittedDate: '01/01/2026' },
  works: Array.from({ length: workCount }, (_, i) => work(i + 1)),
  documents: [{ name: 'PAN', url: 'https://files.example/pan.png' }],
  footerName: 'TEST MEMBER',
});

let chromeError = null;
async function render(workCount) {
  try {
    return await applicationPdfService.renderPdf(form(workCount));
  } catch (err) {
    chromeError = err;
    return null;
  }
}

after(() => applicationPdfService.closeBrowser());

test('one work: the second signature goes on page 4, inside the page and above the anchor', async (t) => {
  const pdf = await render(1);
  if (!pdf) return t.skip(`headless Chrome unavailable: ${chromeError.message}`);

  const anchors = await findAnchors(pdf);
  assert.deepEqual(anchors.map((a) => a.page), [3, 4]);

  const [declaration, workPage] = await signatureBoxesFor(pdf);
  assert.deepEqual(declaration, DECLARATION_BOX);
  assert.equal(workPage.page, 4);
  assert.equal(workPage.width, WORK_PAGE_SIGNATURE.width);
  assert.equal(workPage.height, WORK_PAGE_SIGNATURE.height);
  assert.ok(workPage.left >= 0 && workPage.left + workPage.width <= 595, 'inside the page width');
  // The box ends just above the anchor's baseline (anchor y is from the bottom, box top from the top).
  const anchorFromTop = workPage.pageHeight - anchors[1].y;
  assert.ok(workPage.top + workPage.height <= anchorFromTop && workPage.top > 0, 'above the anchor, on the page');
});

test('many works: the second signature follows the Work Notification page past page 4', async (t) => {
  const pdf = await render(25);
  if (!pdf) return t.skip(`headless Chrome unavailable: ${chromeError.message}`);

  const boxes = await signatureBoxesFor(pdf);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].page, 3);
  assert.ok(boxes[1].page > 4, `landed on page ${boxes[1].page}`);
});

test('an unreadable PDF is rejected, so esign.service falls back to the declaration box', async () => {
  await assert.rejects(signatureBoxesFor(Buffer.from('%PDF-1.4 not really')));
});
