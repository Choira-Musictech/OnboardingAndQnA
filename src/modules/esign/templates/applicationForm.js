// ==================================================================
// The IPRS application form as HTML, rendered to PDF by applicationPdf.service.js.
//
// Layout follows the forms IPRS's own system prints: the society header on every page, grey
// "PART n" section bars, underlined label/value rows, and a footer (member name, page x/n,
// application number) added by Puppeteer's footer template.
//
// Page 3 is the declaration the member signs. Its height is fixed and the signature box sits at
// a fixed position on it, so a signing provider can be told exactly where to put the signature
// (SIGNATURE_BOX). The box also carries the text "sign_here" (invisible) for providers that place
// signatures by anchor text instead of coordinates.
// ==================================================================
import fs from 'node:fs';

const LOGO = `data:image/png;base64,${fs
  .readFileSync(new URL('../assets/iprs-logo.png', import.meta.url))
  .toString('base64')}`;

// A4, in millimetres. PAGE_MARGIN is applied by Puppeteer around every page.
export const PAGE_MARGIN = Object.freeze({ top: 10, right: 12, bottom: 18, left: 12 });
const CONTENT_HEIGHT = 297 - PAGE_MARGIN.top - PAGE_MARGIN.bottom;

// Where the member's signature goes on page 3, measured from the top-left of the content area.
const SIGN_BOX_MM = Object.freeze({ top: 140, left: 128, width: 58, height: 22 });
const MM_TO_PT = 72 / 25.4;

// Same box measured from the top-left corner of the PAGE, in millimetres and in PDF points.
export const SIGNATURE_BOX = Object.freeze({
  page: 3,
  mm: {
    left: PAGE_MARGIN.left + SIGN_BOX_MM.left,
    top: PAGE_MARGIN.top + SIGN_BOX_MM.top,
    width: SIGN_BOX_MM.width,
    height: SIGN_BOX_MM.height,
  },
  pt: {
    left: Math.round((PAGE_MARGIN.left + SIGN_BOX_MM.left) * MM_TO_PT),
    top: Math.round((PAGE_MARGIN.top + SIGN_BOX_MM.top) * MM_TO_PT),
    width: Math.round(SIGN_BOX_MM.width * MM_TO_PT),
    height: Math.round(SIGN_BOX_MM.height * MM_TO_PT),
  },
  // A4 height in points, for providers that measure from the bottom of the page.
  pageHeightPt: Math.round(297 * MM_TO_PT),
  anchorText: 'sign_here',
});

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

// Only http(s) links are printed as links; anything else is shown as plain text.
function link(url, label = url) {
  const href = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(href)) return e(label);
  return `<a href="${e(href)}">${e(label)}</a>`;
}

const header = () => `
  <header class="society">
    <img class="logo" src="${LOGO}" alt="IPRS">
    <div class="society-text">
      <h1>THE INDIAN PERFORMING RIGHT SOCIETY LIMITED</h1>
      <p class="sub">A Registered Copyright Society under Sec 33(3) of the Copyright Act</p>
      <p>Regd. Office:208, Golden Chambers 2nd Floor, New Andheri Link Road, Andheri (W),</p>
      <p>MUMBAI-400053 , Maharashtra , India</p>
      <p>Tel: (022) 4606 7653/ 6972 9999</p>
      <p>Email : membership@iprs.org | Web : www.iprs.org</p>
      <p>CIN : U92140MH1969GAP014359 | GSTIN : 27AAACT1594K1Z1</p>
    </div>
  </header>`;

const bar = (title, part) => `<div class="bar"><span>${e(title)}</span><span>${part ? `PART ${part}` : ''}</span></div>`;

// One label/value pair; `strong` prints the value bold, as the forms do for names.
const cell = (label, value, { strong = false } = {}) =>
  `<td class="label">${e(label)}</td><td class="value${strong ? ' strong' : ''}">${e(value)}</td>`;

function personalPart(data) {
  const company = data.variant === 'company';
  const photo = data.photo ? `<img class="photo" src="${e(data.photo)}" alt="">` : '';
  const rows = company
    ? [
        cell('Company Name :-', data.companyName, { strong: true }),
        cell('Establishment Date. :-', data.establishmentDate),
        cell('Full Name :-', data.fullName, { strong: true }),
        cell('Alias :-', data.alias),
      ]
    : [cell('Full Name :-', data.fullName, { strong: true }), cell('Alias :-', data.alias)];

  const identity = company
    ? `<tr>${cell('Pan No. :-', data.pan)}${cell('GST :-', data.gst)}</tr>`
    : `<tr>${cell('Pan No. :-', data.pan)}${cell('GST :-', data.gst)}</tr>
       <tr>${cell('Nationality :-', data.nationality)}${cell("Parent's Name :-", data.parentName)}</tr>`;

  const birth = company
    ? ''
    : `<tr>${cell('Place Of Birth :-', data.placeOfBirth)}${cell('DOB :-', data.dob)}</tr>`;

  const tail = company
    ? `<tr>${cell('WhatsApp No. :-', data.whatsapp)}<td></td><td></td></tr>`
    : `<tr>${cell('WhatsApp No. :-', data.whatsapp)}${cell('Gender :-', data.gender)}</tr>
       <tr>${cell('Prefered Language :-', data.preferredLanguage)}<td></td><td></td></tr>`;

  return `
    <div class="bar"><span>PERSONAL DETAILS (BLOCK LETTERS)</span><span>PART 1</span></div>
    <table class="role"><tr><td class="label strong">Role Type</td><td class="value strong">${e(data.roleType)}</td></tr></table>
    <div class="with-photo">
      <table class="grid">
        <tr>${cell('Application Date :-', data.applicationDate)}${cell('Application No :-', data.applicationNo)}</tr>
        ${rows.map((row) => `<tr>${row}<td></td><td></td></tr>`).join('')}
        ${identity}
      </table>
      <div class="photo-box">${photo}</div>
    </div>
    <table class="grid divided">
      ${birth}
      <tr>${cell('Mobile No. :-', data.mobile)}${cell('Alternate Phone No. :-', data.altPhone)}</tr>
      <tr>${cell('E-mail Address :-', data.email)}${cell('Alternate E-mail Address :-', data.altEmail)}</tr>
      ${tail}
    </table>`;
}

function addressBlock(label, address) {
  return `
    <table class="grid address">
      <tr><td class="label">${e(label)}</td><td class="value" colspan="3">${e(address.line)}</td></tr>
      <tr>${cell('City', address.city)}${cell('Pin/Zip Code', address.pincode)}</tr>
      <tr>${cell('State', address.state)}${cell('Country', address.country)}</tr>
    </table>`;
}

function addressPart(data) {
  return `
    ${bar('ADDRESS INFO', 3)}
    ${addressBlock(data.addresses.firstLabel, data.addresses.first)}
    ${addressBlock(data.addresses.secondLabel, data.addresses.second)}`;
}

function otherPart(data) {
  const company = data.variant === 'company';
  const rows = [
    ['Territory Applied For', data.other.territory],
    ['Whether Member of Other Overseas Society?', data.other.memberOfOverseasSociety],
    ['Name of the Other Overseas Society', data.other.overseasSocietyName],
    ['Internal Identification Name', data.other.internalIdentificationName],
    ...(company ? [] : [['IPI Number', data.other.ipiNumber]]),
    ['Whether Member of any Association in INDIA', data.other.indiaAssociation],
  ];
  return `
    ${bar('OTHER INFO', 4)}
    <table class="grid other">
      ${rows.map(([label, value]) => `<tr><td class="label wide">${e(label)}</td><td class="value">${e(value)}</td></tr>`).join('')}
    </table>`;
}

function bankPart(data) {
  const b = data.bank;
  return `
    ${bar('BANK INFO', 5)}
    <table class="grid bank">
      <tr>${cell('Bank Name', b.name)}${cell('Account No', b.accountNo)}</tr>
      <tr>${cell('Branch Name', b.branch)}${cell('IFSC Code', b.ifsc)}</tr>
      <tr>${cell('MICR Code', b.micr)}${cell('Currency Type', b.currency)}</tr>
      <tr>${cell('Account Name', b.accountName)}<td></td><td></td></tr>
    </table>`;
}

// IPRS's declaration wording, kept as their forms print it.
function declarationText(data) {
  if (data.isPublisher) {
    return `I hereby apply Membership of the society as a Publisher and agree, if selected and admitted to the membership of the Society(Company), to abide by the <u>Memorandum</u> and <u>Articles</u> of Association and the Rules of the Company for the time being in force or as amended from time to time and to execute an Assignment Deed to the Company of all the Public Performing and Mechanical Rights in the Literary &amp; Musical Works of which I am the Publisher of these Works as OWNER (including all future works to the exclusion of all other persons including myself) and undertake to execute, if so and whenever required, additional Assignments from time to time in respect of any future Literary &amp; Musical Works which I may compose, write or acquire the Copyrights therein. A list of the Literary &amp; Musical Works with which I am the my Company is / Partnership Firm is / Proprietorship is concerned is given in the Work Notification Form(s) submitted herewith. I state and confirm that I am an Owner Publisher and/ or Owner of Rights and that all the details given herewith are true and correct. I also hereby accept, declare and confirm that I shall not do any acts which would be against the interest of the Company and shall also adhere to the Memorandum of Association and Articles of Association and the Rules made there under during the course of my membership of the Association.`;
  }
  return `I hereby apply Membership of the society as a ${e(data.declarationRoles)} and agree, if selected and admitted to the membership of the Society(Company), to abide by the <u>Memorandum</u> and <u>Articles</u> of Association and the Rules of the Company for the time being in force or as amended from time to time and to execute an Assignment Deed to the Company of all the Public Performing and Mechanical Rights in the Literary &amp; Musical Works of which I am the Composer / Song Writer of these Works as OWNER (including all future works to the exclusion of all other persons including myself) and undertake to execute, if so and whenever required, additional Assignments from time to time in respect of any future Literary &amp; Musical Works which I may compose, write or acquire the Copyrights therein. A list of the Literary &amp; Musical Works with which I am the Author is concerned is given in the Work Notification Form(s) submitted herewith. I state and confirm that I am an Author / Composer and / or Owner of Rights and that all the details given herewith are true and correct. I also hereby accept, declare and confirm that I shall not do any acts which would be against the interest of the Company and shall also adhere to the Memorandum of Association and Articles of Association and the Rules made there under during the course of my membership of the Association.`;
}

function signingDetails(data) {
  const s = data.signing;
  return `
    <p>Macid : ${e(s.macid)}</p>
    <p>GUID : ${e(s.guid)}</p>
    <p>IP : ${e(s.ip)}</p>
    <p>Submitted Date : ${e(s.submittedDate)}</p>`;
}

function declarationPage(data) {
  const s = data.signing;
  return `
    <section class="page fixed">
      ${header()}
      <p class="declaration">${declarationText(data)}</p>
      <div class="date-place">
        <p>Date: ${e(s.date)}</p>
        <p>Place: ${e(s.place)}</p>
      </div>
      <div class="sign-box"><span class="anchor">${SIGNATURE_BOX.anchorText}</span></div>
      <div class="sign-meta under-box">${signingDetails(data)}</div>
      <div class="approval">Approving Director Signature</div>
    </section>`;
}

function worksTable(data) {
  if (!data.works.length) return '<p class="empty">No works submitted.</p>';
  const head = ['Song Name', 'Film Album Name', 'Language Names', 'Category', 'Artist Singers', 'Author Composer', 'Publisher', 'Author Lyricist', 'Digital Link', 'File Link', 'Release Year'];
  const rows = data.works
    .map(
      (w) => `<tr>
        <td>${e(w.songName)}</td><td>${e(w.album)}</td><td>${e(w.languages)}</td><td>${e(w.category)}</td>
        <td>${e(w.singers)}</td><td>${e(w.composer)}</td><td>${e(w.publisher)}</td><td>${e(w.lyricist)}</td>
        <td class="link">${link(w.digitalLink)}</td><td class="link">${link(w.fileLink)}</td><td>${e(w.releaseYear)}</td>
      </tr>`,
    )
    .join('');
  return `<table class="works"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

// A second signature spot above the signer's name on the Work Notification page, for DocuSign only.
// DocuSign puts a Sign Here tab on EVERY occurrence of the anchor text, so repeating the same
// invisible text here is all it needs - and the slot sits in the normal flow, so the tab follows the
// signer block wherever the works table pushes it. eMudhra places its one signature by coordinates on
// page 3 and never sees this slot (Indian members do not get it).
function workPageSignatureSlot(data) {
  if (!data.signing.workPageSignature) return '';
  return `<div class="sign-slot"><span class="anchor">${SIGNATURE_BOX.anchorText}</span></div>`;
}

// Who signed, above the signing details. A DocuSign signature stamp already prints the signer's full
// name, so it takes the name's place; without a signature here (eMudhra) the typed name stays.
function workPageSignerBlock(data) {
  return data.signing.workPageSignature
    ? workPageSignatureSlot(data)
    : `<p class="strong">${e(data.signing.signerName)}</p>`;
}

function worksPage(data) {
  return `
    <section class="page">
      ${header()}
      ${bar('WORK NOTIFICATION INFO', 7)}
      ${worksTable(data)}
      <div class="disclaimer">
        <p>Disclaimer</p>
        <ol>
          <li>I/We hereby declare the Works submitted here along with this form by me/us is/are owned / authored by me / us.</li>
          <li>This is the Form for the submission of Released Work only (subject to verification with the supporting for work).</li>
          <li>Member/Applicant filling up this Form will be solely responsible for the details provided &amp; hereby indemnify IPRS for any future inconsistency.</li>
          <li>In case of any discrepancy in the future observed IPRS has the right to HOLD &amp; put the same in the DISPUTE list (unless resolved).</li>
        </ol>
      </div>
      <div class="sign-row">
        <div><p>Date: ${e(data.signing.date)}</p></div>
        <div class="sign-meta">${workPageSignerBlock(data)}${signingDetails(data)}</div>
      </div>
    </section>`;
}

function documentsPage(data) {
  const rows = data.documents
    .map((doc, i) => `<tr><td class="sr">${i + 1}</td><td class="doc">${link(doc.url, doc.name)}</td></tr>`)
    .join('');
  return `
    <section class="page last">
      ${header()}
      ${bar('DOCUMENT INFO', 8)}
      <table class="documents"><thead><tr><th class="sr">Sr No.</th><th>Document</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
}

const STYLES = `
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { margin: 0; font-family: Arial, Helvetica, "Liberation Sans", sans-serif; font-size: 9.5pt; color: #000; }
  p { margin: 0; }
  a { color: #1a0dab; font-weight: bold; }
  .page { page-break-after: always; }
  .page.last { page-break-after: auto; }
  .page.fixed { height: ${CONTENT_HEIGHT}mm; position: relative; overflow: hidden; }
  .society { display: flex; align-items: flex-start; gap: 6mm; padding-bottom: 3mm; border-bottom: 1.5pt solid #000; margin-bottom: 3mm; }
  .society .logo { width: 22mm; height: auto; }
  .society-text { flex: 1; text-align: center; font-size: 8.5pt; line-height: 1.35; padding-right: 22mm; }
  .society h1 { font-size: 12.5pt; margin: 0 0 1mm; }
  .society .sub { font-weight: bold; font-size: 7.5pt; margin-bottom: 1.5mm; }
  .bar { display: flex; justify-content: space-between; background: #c4c4c4; font-weight: bold; padding: 1.6mm 2mm; margin-top: 2mm; }
  table { width: 100%; border-collapse: collapse; }
  .grid td { padding: 1.4mm 1mm 0.6mm; vertical-align: bottom; }
  .grid td.label { width: 22%; white-space: nowrap; }
  .grid td.label.wide { width: 50%; }
  .grid td.value { border-bottom: 0.6pt solid #000; width: 28%; }
  .grid.divided { border-top: 0.6pt solid #000; margin-top: 1mm; }
  .grid.address { border-bottom: 0.6pt solid #000; padding-bottom: 2mm; margin-bottom: 1mm; }
  .role td { padding: 1.6mm 1mm; }
  .role td.label { width: 22%; }
  .strong { font-weight: bold; }
  .with-photo { display: flex; gap: 3mm; }
  .with-photo .grid { flex: 1; }
  .photo-box { width: 30mm; padding-top: 1mm; }
  .photo { width: 30mm; max-height: 32mm; object-fit: cover; }
  .declaration { margin-top: 12mm; text-align: justify; line-height: 1.55; font-size: 10pt; }
  .sign-row { display: flex; justify-content: space-between; margin-top: 3mm; line-height: 1.8; }
  .sign-meta { text-align: right; }
  .sign-box { position: absolute; top: ${SIGN_BOX_MM.top}mm; left: ${SIGN_BOX_MM.left}mm; width: ${SIGN_BOX_MM.width}mm; height: ${SIGN_BOX_MM.height}mm; }
  .sign-box .anchor, .sign-slot .anchor { color: #fff; font-size: 1pt; }
  .sign-slot { width: ${SIGN_BOX_MM.width}mm; height: ${SIGN_BOX_MM.height + 10}mm; margin: 7mm 0 0 auto; text-align: left; }
  .sign-slot .anchor { display: block; padding-top: 25mm; }
  .date-place { position: absolute; top: ${SIGN_BOX_MM.top + 2}mm; left: 0; line-height: 1.8; }
  .sign-meta.under-box { position: absolute; top: ${SIGN_BOX_MM.top + SIGN_BOX_MM.height + 2}mm; right: 0; line-height: 1.8; }
  .approval { position: absolute; top: 205mm; left: 0; right: 0; text-align: center; font-weight: bold; }
  .works { margin-top: 1mm; font-size: 8pt; }
  .works { table-layout: auto; }
  .works th, .works td { border: 0.6pt solid #000; padding: 1mm; text-align: left; vertical-align: top; overflow-wrap: break-word; hyphens: none; }
  .works th { font-weight: normal; }
  .works td.link { max-width: 24mm; word-break: break-all; }
  .works td.link a { font-size: 7.5pt; }
  .disclaimer { margin-top: 30mm; font-size: 9pt; }
  .disclaimer ol { margin: 2mm 0 0 30mm; padding-left: 5mm; }
  .disclaimer li { margin-bottom: 1mm; }
  .empty { margin: 4mm 1mm; }
  .documents { margin-top: 4mm; }
  .documents th, .documents td { border: 0.6pt solid #000; padding: 1.2mm 2mm; text-align: left; }
  .documents th { font-weight: normal; }
  .documents .sr { width: 18mm; }
  .documents td.doc a { text-decoration: underline; }
`;

/** @param {ReturnType<typeof import('../services/applicationData.service.js').applicationDataService.buildApplicationData> extends Promise<infer T> ? T : never} data */
export function renderApplicationForm(data) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>IPRS Application ${e(data.applicationNo)}</title><style>${STYLES}</style></head>
<body>
  <section class="page">
    ${header()}
    ${personalPart(data)}
    ${addressPart(data)}
    ${otherPart(data)}
  </section>
  <section class="page">
    ${header()}
    ${bankPart(data)}
  </section>
  ${declarationPage(data)}
  ${worksPage(data)}
  ${documentsPage(data)}
</body>
</html>`;
}

// Puppeteer footer: member name, page x/n, application number - as on IPRS's own forms.
export function renderFooter(data) {
  return `<div style="width:100%; font-family: Arial, Helvetica, sans-serif; font-size:8pt; padding:0 ${PAGE_MARGIN.left}mm; display:flex; justify-content:space-between;">
    <span style="width:40%">${e(data.footerName)}</span>
    <span><span class="pageNumber"></span>/<span class="totalPages"></span></span>
    <span style="width:40%; text-align:right">${e(data.applicationNo)}</span>
  </div>`;
}
