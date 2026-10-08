// ==================================================================
// Translates the flow's three classification questions into the codes IPRS's own database
// actually uses, instead of storing the answer text verbatim. None of this is guessed - the
// mappings were read off the live mraai_uat database (MemberRoleType_LookUp + real App_Accounts
// rows) and confirmed by IPRS's own team, who describe their six member categories as
// Individual / Sole Proprietor / Partnership / Company / NRI Individual / NRI Company - i.e.
// AccountRegType and EntityType together:
//
//   App_Accounts.AccountRegType  I = Individual, NI = NRI Individual,
//                                C = Corporate/Publisher, NC = NRI Corporate/Publisher
//   App_Accounts.EntityType      CP = Company, PR = Partnership, SP = Sole Proprietor
//                                (only meaningful on the C/NC paths)
//   App_Accounts.RollTypeIds     comma-separated MemberRoleType_LookUp.MemberRoleTypeId values:
//                                1 = Author (Music Composer), 2 = Author (Lyricist),
//                                5/6 = the same two on the NRI side, 4 = Publisher,
//                                11 = NRI Publisher. "2,1" (lyricist first) is how prod stores
//                                "both", so that ordering is kept.
//
// The answer strings come from the published Typebot flow's own choice items - Group #3 for the
// path, Group #5 for the role, Group #31 for the entity type - so they must match those items
// exactly.
// ==================================================================

export const REG_TYPES = Object.freeze({
  INDIVIDUAL: 'I',
  NRI_INDIVIDUAL: 'NI',
  PUBLISHER: 'C',
  NRI_PUBLISHER: 'NC',
});

const REG_TYPE_BY_ANSWER = Object.freeze({
  '(Individual) Author / Composer': REG_TYPES.INDIVIDUAL,
  '(NRI) Author / Composer': REG_TYPES.NRI_INDIVIDUAL,
  'Owner/Publisher': REG_TYPES.PUBLISHER,
  '(NRI) Owner/Publisher': REG_TYPES.NRI_PUBLISHER,
});

const ANSWER_BY_REG_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(REG_TYPE_BY_ANSWER).map(([answer, code]) => [code, answer])),
);

// Only the two Author/Composer paths ever reach the role question; the publisher paths get their
// RollTypeIds from the path choice itself (see PUBLISHER_ROLL_TYPE_ID_BY_REG_TYPE).
const ROLL_TYPE_IDS_BY_REG_TYPE = Object.freeze({
  [REG_TYPES.INDIVIDUAL]: Object.freeze({ Lyricist: '2', Composer: '1', Both: '2,1' }),
  [REG_TYPES.NRI_INDIVIDUAL]: Object.freeze({ Lyricist: '6', Composer: '5', Both: '6,5' }),
});

// Group #31, asked only on the Owner/Publisher paths.
const ENTITY_TYPE_BY_ANSWER = Object.freeze({
  'Corporate (Pvt Ltd/Ltd Company)': 'CP',
  Partnership: 'PR',
  'Sole Proprietary Concern': 'SP',
});

const ANSWER_BY_ENTITY_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(ENTITY_TYPE_BY_ANSWER).map(([answer, code]) => [code, answer])),
);

export const PUBLISHER_ROLL_TYPE_ID_BY_REG_TYPE = Object.freeze({
  [REG_TYPES.PUBLISHER]: '4',
  [REG_TYPES.NRI_PUBLISHER]: '11',
});

// What each id means on its own, for turning a stored value back into something a member reads.
const ROLE_LABEL_BY_ID = Object.freeze({
  1: 'Composer',
  2: 'Lyricist',
  4: 'Publisher',
  5: 'Composer',
  6: 'Lyricist',
  11: 'Publisher',
});

/** @param {string} pathAnswer the Group #3 choice, verbatim @returns {string|null} */
export function resolveRegType(pathAnswer) {
  const key = typeof pathAnswer === 'string' ? pathAnswer.trim() : '';
  return REG_TYPE_BY_ANSWER[key] ?? null;
}

/** @param {string} regType @param {string} roleAnswer the Group #5 choice @returns {string|null} */
export function resolveRollTypeIds(regType, roleAnswer) {
  const byRole = ROLL_TYPE_IDS_BY_REG_TYPE[regType];
  if (!byRole) return null;
  const key = typeof roleAnswer === 'string' ? roleAnswer.trim() : '';
  return byRole[key] ?? null;
}

/** @param {string} entityAnswer the Group #31 choice, verbatim @returns {string|null} */
export function resolveEntityType(entityAnswer) {
  const key = typeof entityAnswer === 'string' ? entityAnswer.trim() : '';
  return ENTITY_TYPE_BY_ANSWER[key] ?? null;
}

/** Stored code -> the wording the member themselves picked. */
export function describeRegType(regType) {
  return ANSWER_BY_REG_TYPE[String(regType ?? '').trim()] ?? null;
}

/** Stored CP/PR/SP -> the wording the member picked. */
export function describeEntityType(entityType) {
  return ANSWER_BY_ENTITY_TYPE[String(entityType ?? '').trim()] ?? null;
}

/** Stored ids -> each role's name, de-duplicated ("2,1" -> ["Lyricist", "Composer"]). */
export function listRoleLabels(rollTypeIds) {
  const ids = String(rollTypeIds ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return [...new Set(ids.map((id) => ROLE_LABEL_BY_ID[id]).filter(Boolean))];
}

/**
 * Stored ids -> the wording the member picked ("Lyricist"/"Composer"/"Both"/"Publisher").
 * A member must never be shown the raw "2,1".
 */
export function describeRollTypeIds(rollTypeIds) {
  const labels = listRoleLabels(rollTypeIds);
  if (!labels.length) return null;
  // Lyricist + Composer together is the flow's own "Both" answer - say it the way they said it.
  if (labels.includes('Lyricist') && labels.includes('Composer')) return 'Both';
  return labels.join(', ');
}

export { REG_TYPE_BY_ANSWER };
