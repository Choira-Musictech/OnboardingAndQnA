// ==================================================================
// Resolves the flow's free-text "mother tongue" answer to IPRS's own App_Language_Lookup.LanguageId
// (see prisma/schema.prisma and scripts/add-language-lookup-table.sql).
//
// WHY FREE TEXT AT ALL, when every other controlled column in this app (RollTypeIds, EntityType,
// AccountRegType) is deliberately fed from Typebot buttons, never typed text - the flow's question
// went in as a "text input" block, not choice buttons (confirmed against the published flow). Real
// prod data backs treating LanguageName as genuinely free text: App_Accounts.LanguageName holds
// values with native-script annotations no lookup row has verbatim, and LanguageId is null on most
// rows - so it isn't safe to assume the FK is always resolvable. What IS safe: never GUESS an id.
// A member's own words always land in LanguageName; LanguageId is set only on a real match, and
// left null otherwise rather than pointing at the wrong language.
//
// WHY NOT A DIRECT SQL "=" ON LanguageName: App_Language_Lookup's own entries are inconsistent
// (e.g. "Punjabi, Panjabi", "Catalan, Valencian") - a member who types "Punjabi" would never match
// with plain equality. Matching splits those on comma and compares each half.
// ==================================================================
import { prisma } from '../../../shared/prisma.js';

// Common alternate spellings this app has seen that don't appear anywhere in the lookup table's
// own name/comma-splits - kept small and explicit rather than guessed at scale.
const ALIASES = Object.freeze({
  odia: 'Oriya',
  bangla: 'Bengali',
  gujrati: 'Gujarati',
});

function normalize(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// A handful of lookup rows carry a trailing qualifier the frontend's own picker already strips
// before showing/submitting a name (e.g. row 193 is literally "Manipuri (Meitei)", but a member
// selects and sends plain "Manipuri") - match on both the qualifier and the bare name.
function stripQualifier(value) {
  return value.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

let cache = null; // [{ id, names: Set<normalized alias> }], loaded once - 218 static rows, never written by this app
async function loadLanguages() {
  if (cache) return cache;
  const rows = await prisma.appLanguageLookup.findMany({ select: { LanguageId: true, LanguageName: true } });
  cache = rows.map((row) => {
    const segments = (row.LanguageName ?? '').split(',').map(normalize).filter(Boolean);
    const withoutQualifiers = segments.map((s) => normalize(stripQualifier(s))).filter(Boolean);
    return { id: row.LanguageId, names: new Set([...segments, ...withoutQualifiers]) };
  });
  return cache;
}

// -> LanguageId (BigInt) for a confident match, else null. Never throws - a lookup failure should
// never block saving the member's own words in LanguageName.
async function resolveLanguageId(rawAnswer) {
  const key = normalize(ALIASES[normalize(rawAnswer)] ?? rawAnswer);
  if (!key) return null;

  try {
    const languages = await loadLanguages();
    const match = languages.find((lang) => lang.names.has(key));
    return match?.id ?? null;
  } catch {
    return null;
  }
}

export const languageLookupService = { resolveLanguageId };
