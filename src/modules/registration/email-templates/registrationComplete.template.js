// The two emails IPRS's own process sends when a registration completes - wording as IPRS supplied
// it. The name is read off a document by OCR, so every value is escaped before it goes into HTML.

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const orDash = (value) => (value == null || String(value).trim() === '' ? '-' : String(value).trim());

// IPRS's own signature block, as supplied, on both mails.
const SIGNATURE_HTML =
  'Regards,<br>Admin-Membership<br><br> <b>The Indian Performing Right Society Limited</b> <br>' +
  '<p2 style="font-size: 11px"><b>Regd.Office</b>: 208, Golden Chambers, 2nd Floor, New Andheri Link Road, ' +
  'Andheri (W), Mumbai-400053<br>Tel: (022) 2673 3748 / 49 / 50 / 6616, Fax: (022) 2673 6658, ' +
  'E-mail: membership@iprs.org, Visit us at: www.iprs.org</p2>';

const SIGNATURE_TEXT = `Regards,
Admin-Membership

The Indian Performing Right Society Limited
Regd.Office: 208, Golden Chambers, 2nd Floor, New Andheri Link Road, Andheri (W), Mumbai-400053
Tel: (022) 2673 3748 / 49 / 50 / 6616, Fax: (022) 2673 6658, E-mail: membership@iprs.org, Visit us at: www.iprs.org`;

export function buildIprsRegistrationNotice({ name, code, role, bookName }) {
  const fields = { name: orDash(name), code: orDash(code), role: orDash(role), bookName: orDash(bookName) };
  const html = (key) => escapeHtml(fields[key]);

  const subject = 'Successful Registration by Member';
  const text = [
    'Dear Sir,',
    '',
    'Successful Registration by New Member',
    '',
    `Name - ${fields.name}`,
    `Code - ${fields.code}`,
    `Role - ${fields.role}`,
    `Type - ${fields.bookName}`,
    '',
    'Click to View/Approve: https://lic.iprs.org/',
    '',
    SIGNATURE_TEXT,
  ].join('\n');
  const body = `Dear Sir,<br><br>
Successful Registration by New Member
<br>
<br>
Name - ${html('name')}
<br>
Code - ${html('code')}
<br>
Role - ${html('role')}
<br>
Type - ${html('bookName')}
<br>
<br>
<a href="https://lic.iprs.org/">Click to View/Approve</a><br><br>
${SIGNATURE_HTML}`;

  return { subject, text, html: body };
}

export function buildMemberApplicationReceived({ name } = {}) {
  const greetingName = orDash(name) === '-' ? 'Applicant' : orDash(name);
  const subject = 'Successful Submission of Application';
  const text = `Dear ${greetingName},

Thank you for completing the application process.

Once the verification process is completed at our end, you will receive:
1) the hardcopy of your application form and submitted documents (for self-attestation)
2) Assignment Deed
3) indemnity bond
4) other applicable documents

On receipt of above mentioned documents you are requested to sign and send back the entire set of documents to our registered address as below:

Kind Attention: Admin-Membership
The Indian Performing Right Society Limited
208, Golden Chambers 2nd Floor,
New Andheri Link Road,
Andheri (W),
MUMBAI-400053 , Maharashtra , India

To know the status of your application you may write to us at membership@iprs.org

${SIGNATURE_TEXT}`;

  const html = `Dear ${escapeHtml(greetingName)},<br><br>
<div>
Thank you for completing the application process.
</div>
<div>
<br>
</div>
<div>
Once the verification process is completed at our end, you will receive:
</div>
<div>1)
<span style="white-space:pre"> </span>
the hardcopy of your application form and submitted documents (for self-attestation)
</div>
<div>2)
<span style="white-space:pre"> </span>
Assignment Deed
</div>
<div>3)
<span style="white-space:pre"> </span>indemnity bond
</div>
<div>4)
<span style="white-space:pre"> </span>
other applicable documents
</div>
<div>
<br>
</div>
<div>On receipt of above mentioned documents you are requested to sign and send back the entire set of documents to our registered address as below:
</div>
<div>
<br>
</div>
<div>
Kind Attention: Admin-Membership
</div>
<div>
<b>The Indian Performing Right Society Limited</b></div><div>208, Golden Chambers 2nd Floor,
</div>
<div>New Andheri Link Road,
</div>
<div>Andheri (W),
</div>
<div>MUMBAI-400053 , Maharashtra , India
</div>
<div>
<br>
</div>
<div>
To know the status of your application you may write to us at
 <span style="color: #0000ff;">membership@iprs</span><font color="#0000ff">.org</font></div><div><br></div>
${SIGNATURE_HTML}`;

  return { subject, text, html };
}
