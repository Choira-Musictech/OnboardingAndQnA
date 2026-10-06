// ==================================================================
// A copy of every uploaded document, kept on this server's own disk, one
// folder per member: <DOCUMENT_STORAGE_DIR>/<NAME>_<AccountId>/pan_card.jpg.
//
// The real upload still goes to Typebot's storage - the flow needs that URL
// to advance - and Typebot decides its own S3 keys, so per-member folders
// can only exist in storage this app owns.
//
// The member's name usually isn't known at the first upload: AccountName is
// written once, from a PAN/Aadhaar/passport/GST OCR result. Until then the
// folder is just <AccountId>, and it is renamed the first time a name is on
// file. Every path segment is a numeric id, a fixed label or a strict slug,
// so nothing a member typed or OCR read can escape the base folder.
// ==================================================================
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env.js';
import { registrationRepository } from '../repositories/registration.repository.js';

// Only where the enum name alone wouldn't read as the document a person recognises.
const FILE_LABELS = {
  PAN: 'pan_card',
  COMPANY_PAN: 'company_pan_card',
  AADHAAR: 'aadhaar_card',
  BANK: 'bank_cheque_or_passbook',
};

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function slugify(name) {
  return String(name ?? '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
    .replace(/_+$/, '');
}

// Labels are [a-z0-9_] only, so the hyphen before an address-proof type can never be confused
// with part of another label - "comm_address_proof" stays distinct from "comm_address_proof_2".
function fileLabel(docType, addressProofType) {
  const label = FILE_LABELS[docType] ?? docType.toLowerCase();
  return addressProofType ? `${label}-${addressProofType.toLowerCase()}` : label;
}

function extensionOf(originalName, mimeType) {
  const fromName = path.extname(String(originalName ?? '')).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName;
  return EXTENSION_BY_MIME[mimeType] ?? 'bin';
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export function createDocumentStorage({ baseDir, findAccount }) {
  async function memberFolder(accountId) {
    const idFolder = path.join(baseDir, String(accountId));
    const account = await findAccount(accountId);
    const slug = slugify(account?.AccountName);
    if (!slug) {
      await mkdir(idFolder, { recursive: true });
      return idFolder;
    }

    const namedFolder = path.join(baseDir, `${slug}_${accountId}`);
    if (!(await exists(namedFolder)) && (await exists(idFolder))) {
      await rename(idFolder, namedFolder);
    }
    await mkdir(namedFolder, { recursive: true });
    return namedFolder;
  }

  async function saveMemberDocument({ accountId, docType, addressProofType, buffer, originalName, mimeType }) {
    if (!baseDir?.trim() || !docType || !buffer) return null;
    if (!/^\d+$/.test(String(accountId))) throw new Error(`Refusing a non-numeric accountId: ${accountId}`);

    const folder = await memberFolder(accountId);
    const baseLabel = FILE_LABELS[docType] ?? docType.toLowerCase();

    // Re-upload replaces: drop this slot's earlier copy, whatever its extension or address-proof type.
    for (const entry of await readdir(folder)) {
      const stem = path.parse(entry).name;
      if (stem === baseLabel || stem.startsWith(`${baseLabel}-`)) {
        await unlink(path.join(folder, entry));
      }
    }

    const target = path.join(folder, `${fileLabel(docType, addressProofType)}.${extensionOf(originalName, mimeType)}`);
    await writeFile(target, buffer);
    return target;
  }

  return { saveMemberDocument };
}

export const documentStorageService = createDocumentStorage({
  baseDir: env.DOCUMENT_STORAGE_DIR,
  findAccount: (accountId) => registrationRepository.findByAccountId(accountId),
});
