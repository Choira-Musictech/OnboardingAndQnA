// ==================================================================
// IPRS's own language list (App_Language_Lookup - see prisma/schema.prisma and
// scripts/add-language-lookup-table.sql) and the "mother tongue" chat answer built on it.
//
// The chat's picker is fed from listLanguages(): every choice reads `LanguageName(NativeName)`,
// e.g. `Hindi(हिन्दी)`, and that exact label is what the member sends back. resolveLanguage() turns
// it into the row's LanguageId and canonical label, which saveConversationField() stores in
// App_Accounts.LanguageName / LanguageId.
//
// Anything that is NOT a label (an older client, a typed answer) is still matched by name, so a
// plain "Hindi" resolves to the same row and is stored as the same label. What is never done is
// GUESSING: a member's words that match no row resolve to null, and nothing is invented.
//
// WHY NAME MATCHING SPLITS ON COMMAS: the table's own names are inconsistent (e.g. "Punjabi,
// Panjabi", "Catalan, Valencian") - a member who types "Punjabi" would never match with plain
// equality. Matching splits those on comma and compares each half.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

// Common alternate spellings this app has seen that don't appear anywhere in the lookup table's
// own name/comma-splits - kept small and explicit rather than guessed at scale.
const ALIASES = Object.freeze({
  odia: 'Oriya',
  bangla: 'Bengali',
  gujrati: 'Gujarati',
});

// "Bangla" for Bengali, "Odia" for Oriya...: other names members search by, offered to the picker.
const ALIASES_BY_NAME = Object.entries(ALIASES).reduce((byName, [alias, name]) => {
  const key = name.toLowerCase();
  (byName[key] ??= []).push(alias);
  return byName;
}, {});

function normalize(value) {
  return String(value ?? '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A handful of lookup rows carry a trailing qualifier the frontend's own picker already strips
// before showing/submitting a name (e.g. row 193 is literally "Manipuri (Meitei)", but a member
// selects and sends plain "Manipuri") - match on both the qualifier and the bare name.
function stripQualifier(value) {
  return value.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// NativeName holds every native name of a language ("हिन्दी, हिंदी"), sometimes with a note in
// brackets ("(Hausa) هَوُسَ", "中文 (Zhōngwén), 汉语"). The label shows the first real name only.
export function primaryNativeName(nativeName) {
  for (const part of String(nativeName ?? '').split(',')) {
    const cleaned = part.replace(/^\s*\([^)]*\)\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (cleaned) return cleaned;
  }
  return '';
}

// `Hindi(हिन्दी)`. A language whose native name is missing, or is just its English name
// ("English"), is shown by its name alone.
export function buildLanguageLabel({ LanguageName, NativeName }) {
  const name = String(LanguageName ?? '').trim();
  const native = primaryNativeName(NativeName);
  if (!native || normalize(native) === normalize(name)) return name;
  return `${name}(${native})`;
}

let cache = null; // { languages: [{ id, label, name, nativeName, names }], byLabel: Map } - loaded once, 218 static rows

async function loadLanguages() {
  if (cache) return cache;
  const rows = await prisma.appLanguageLookup.findMany({
    select: { LanguageId: true, LanguageName: true, NativeName: true },
    orderBy: { LanguageName: 'asc' },
  });

  const byLabel = new Map();
  const languages = rows.map((row) => {
    const label = buildLanguageLabel(row);
    const segments = (row.LanguageName ?? '').split(',').map(normalize).filter(Boolean);
    const withoutQualifiers = segments.map((s) => normalize(stripQualifier(s))).filter(Boolean);
    const language = {
      id: row.LanguageId,
      label,
      name: (row.LanguageName ?? '').trim(),
      nativeName: primaryNativeName(row.NativeName),
      aliases: segments.flatMap((segment) => ALIASES_BY_NAME[segment] ?? []),
      names: new Set([...segments, ...withoutQualifiers]),
    };
    const key = normalize(label);
    if (byLabel.has(key)) {
      // Two rows reading the same would make a member's choice ambiguous - fix the data.
      throw new Error(`App_Language_Lookup has two languages labelled "${label}"`);
    }
    byLabel.set(key, language);
    return language;
  });

  cache = { languages, byLabel };
  return cache;
}

// -> [{ id, label, name, nativeName, aliases }] for the picker, in alphabetical order.
async function listLanguages() {
  const { languages } = await loadLanguages();
  return languages.map(({ id, label, name, nativeName, aliases }) => ({ id: String(id), label, name, nativeName, aliases }));
}

// -> { id (BigInt), label } for a confident match, else null. Never throws - a lookup failure
// should never block saving the member's own words in LanguageName.
async function resolveLanguage(rawAnswer) {
  const key = normalize(ALIASES[normalize(rawAnswer)] ?? rawAnswer);
  if (!key) return null;

  try {
    const { languages, byLabel } = await loadLanguages();
    const match = byLabel.get(normalize(rawAnswer)) ?? languages.find((lang) => lang.names.has(key));
    return match ? { id: match.id, label: match.label } : null;
  } catch {
    return null;
  }
}

async function resolveLanguageId(rawAnswer) {
  return (await resolveLanguage(rawAnswer))?.id ?? null;
}

// For tests that swap the table's rows.
function resetLanguageCache() {
  cache = null;
}

export const languageLookupService = { listLanguages, resolveLanguage, resolveLanguageId, resetLanguageCache };
