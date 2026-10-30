// ==================================================================
// A copy of every uploaded document, kept in two folders shared by all
// members, named the IPRS way:
//   MEMBER_PHOTO_DIR/MPU_<AccountId>_<file name as uploaded>
//   MEMBER_DOCUMENT_DIR/MRU_<AccountId>_<DocumentLookupId>_<file name as uploaded>
//
// The real upload still goes to Typebot's storage - the flow needs that URL
// to advance - and Typebot decides its own S3 keys, so these folders can only
// exist in storage this app owns.
//
// DocumentLookupId is IPRS's fixed Doc_LookUp number for the document on the
// member's path (PAN 1, bank 2, ... - see documentLookupMap.js). A document
// with no number there is named by its docType instead, so it is never lost.
// The account id is numeric and the uploaded name has every character a file
// system treats specially replaced, so nothing can escape either folder.
// ==================================================================
import { readdir, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env.js';
import { registrationRepository } from '../repositories/registration.repository.js';
import { DOC_LOOKUP_ID_BY_PATH } from './documentLookupMap.js';
import { resolveDocPathKey } from './registration.service.js';

const PHOTO_DOC_TYPES = new Set(['PROFILE_PHOTO', 'COMPANY_PHOTO']);

// COMPANY_NOC shares Doc_LookUp id 95 with NOC on the Corporate path - numbered alike, a company NOC
// upload would replace the member's NOC file. Named by docType so the two stay apart.
const NAMED_BY_DOC_TYPE = new Set(['COMPANY_NOC']);

// A docType that is another one plus a suffix. Both named by docType, the shorter slot's prefix
// (MRU_<id>_COMM_ADDRESS_PROOF_) would also match the longer one's files on a re-upload.
const EXTENDED_DOC_TYPES = ['COMM_ADDRESS_PROOF_2'];

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

const MAX_FILE_NAME_LENGTH = 200;

// The member's own file name, kept as uploaded except for what no file system can hold.
function uploadedName(originalName, docType, mimeType) {
  const safe = path.basename(String(originalName ?? '').replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  if (safe && !/^\.+$/.test(safe)) return safe;
  return `${docType.toLowerCase()}.${EXTENSION_BY_MIME[mimeType] ?? 'bin'}`;
}

// Keeps the extension when a very long name has to be cut.
function fitLength(name) {
  if (name.length <= MAX_FILE_NAME_LENGTH) return name;
  const ext = path.extname(name);
  return name.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
}

export function createDocumentStorage({ photoDir, documentDir, findAccount }) {
  async function documentNumber(accountId, docType) {
    if (NAMED_BY_DOC_TYPE.has(docType)) return docType;
    const account = await findAccount(accountId);
    const pathKey = account ? resolveDocPathKey(account) : null;
    return (pathKey && DOC_LOOKUP_ID_BY_PATH[pathKey]?.[docType]) ?? docType;
  }

  async function saveMemberDocument({ accountId, docType, buffer, originalName, mimeType }) {
    if (!docType || !buffer) return null;
    if (!/^\d+$/.test(String(accountId))) throw new Error(`Refusing a non-numeric accountId: ${accountId}`);

    const isPhoto = PHOTO_DOC_TYPES.has(docType);
    const folder = isPhoto ? photoDir : documentDir;
    if (!folder?.trim()) return null;

    // The trailing underscore keeps MRU_10_1_ from matching MRU_104_... or MRU_10_11_...
    const slot = isPhoto ? `MPU_${accountId}_` : `MRU_${accountId}_${await documentNumber(accountId, docType)}_`;
    const otherSlots = EXTENDED_DOC_TYPES.map((type) => `MRU_${accountId}_${type}_`).filter((other) => other.length > slot.length);

    await mkdir(folder, { recursive: true });
    // Re-upload replaces: drop this slot's earlier file, whatever it was called.
    for (const entry of await readdir(folder)) {
      if (entry.startsWith(slot) && !otherSlots.some((other) => entry.startsWith(other))) await unlink(path.join(folder, entry));
    }

    const target = path.join(folder, fitLength(slot + uploadedName(originalName, docType, mimeType)));
    await writeFile(target, buffer);
    return target;
  }

  return { saveMemberDocument };
}

export const documentStorageService = createDocumentStorage({
  photoDir: env.MEMBER_PHOTO_DIR,
  documentDir: env.MEMBER_DOCUMENT_DIR,
  findAccount: (accountId) => registrationRepository.findByAccountId(accountId),
});
