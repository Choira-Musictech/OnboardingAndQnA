// ==================================================================
// Maps a Typebot text/choice-input block's variableId (input.options.
// variableId from a startChat/continueChat response) to an AppAccounts
// column, so a plain-text answer (GST number, alias/stage name, email)
// can be persisted the same way documentTypeMap.js persists uploads.
//
// variableIds come from the flow's own "variables" list in Typebot
// Studio (Settings/export) - update this map whenever one of these
// blocks' variable is added/renamed there.
// ==================================================================
export const ACCOUNT_FIELD_BY_VARIABLE_ID = {
  // GST no. Stored in Detail1 - a column IPRS's real schema already has, so no new column is
  // needed for it (this app used to add its own GSTNo column and write both).
  vqpmuqooo8wn2ktrfx9uf4l1j: 'Detail1',
  vixob6tfcj9w3m44slwh3p1kq: 'AccountAlias', // alias / stage name
  virpfcnue17syf7ua2hbuj5d1: 'AccountEmail', // email input
  vy80zc5eoveac6euqlurki58o: 'PlaceOfBirth', // place of birth
  // Role: Lyricist / Composer / Both. Stored as the numeric MemberRoleType_LookUp ids IPRS's own
  // database uses ("2", "1", "2,1", and the NRI equivalents) - see memberRoleCodes.js.
  vcf06ka3xjtg0u940pk0qd7os: 'RollTypeIds',
  // The 4-way "(Individual) Author / Composer" / "(NRI) Author / Composer" / "Owner/Publisher" /
  // "(NRI) Owner/Publisher" fork (Group #3). Originally had NO variable assigned - a pure
  // navigation choice, same failure mode Territory hit before it got one (see below) - so the
  // answer was never persisted and payu/feeSchedule.js's lookup against RollTypeIds (which
  // actually holds the Lyricist/Composer/Both answer above, a different question) always missed.
  // Fixed the same way Territory was: assigned this variable in Studio and republished.
  // Stored as IPRS's own registration-type code (I/NI/C/NC) in the column their system already
  // uses for exactly this, rather than a column of ours - see memberRoleCodes.js.
  vjxwoc559admtu01nvecsfrbe: 'AccountRegType',
  // territory applied for (INDIA/WORLD) - variableId changed when the new "all flow fanished"
  // typebot was published (was vufrpq6qr5rpcbewbffajjb73 in the old, individual-only flow).
  vn91tusicqaolw34d4zq2id33: 'TeritoryAppFor',
  // (NRI) Author/Composer path additions - confirmed via the new flow's builder API export.
  vjr9nq2se33oprxviskhjl9vu: 'Nationality', // nationality (chat answer; OCR from a passport upload writes the same column - last-write-wins, same pattern as DOB/Gender)
  vrfp3jhv7r7c6uby7ntrnzl7k: 'AssociationName_India', // assosiation_name
  vp6zf37qhj80ifijkakyn2skl: 'DualNationality', // dual_nationality (Yes/No -> 1/0, special-cased in saveConversationField)
  vrgv6c1wd25wpfmlmhj9oldfq: 'AccountAddress', // P_address - manual "Type your address" entry for the permanent-address slot
  vfbkx77quv9pdg4ot7ko6eiid: 'AccountAddress_PR', // c_address - manual "Type your address" entry for the current-address slot
  // (NRI) Owner/Publisher path additions - confirmed via the new flow's builder API export.
  vytw76yddrr3dh8zy82dq2hll: 'ChanlDesc', // chanel_desc
  vknu81teyb5mr1zsrzggz6wzb: 'AccountAlias', // traderName - company path's trade name reuses the
  // same column the individual path uses for a stage name (the two paths are mutually exclusive).
  vqexarbwxbco7g0kwjermqjr3: 'KindAttention1', // designation (signatory's)
  vsa8t0hiliqcntol02f3aja0y: 'AccountAddress', // registered_address_type - manual "Type registered address" entry
  vwl4gde0bw4a5vqvpp1szcpci: 'AccountAddress_PR', // comm_address2_type - manual "Type communication address" entry
  // Owner/Publisher path's entity-type fork, stored as IPRS's own CP/PR/SP code (their team
  // confirmed these mean Company / Partnership / Sole Proprietor) - see memberRoleCodes.js.
  vdrt7gflf0w9rwhkdwbk27mhf: 'EntityType',
  // "What is your mother tongue?" - free text (a text input block, not choice buttons), asked on
  // all four paths under the same variable. Special-cased in saveConversationField: the answer is
  // stored as-is in LanguageName and, on a confident match, also resolved to IPRS's own
  // App_Language_Lookup.LanguageId - see languageLookup.service.js.
  vh4f2w089zbn113mboiqtm37f: 'LanguageName',
  // "Please enter your Tax Residency Certificate (TRC) Number" - both NRI paths (Author/Composer
  // and Owner/Publisher), asked right after the "Upload TRC" document step. Stored in TRCNo, a
  // column IPRS's real schema already has (confirmed against mraai_uat) - no new column needed.
  vub86kj2279m4imj3ri46ex4m: 'TRCNo',
  // "I Accept" consent, single-choice, no reject option - the very first two questions in the
  // flow. consent2 (this one) is only ever reachable after consent1 has already fired (traced the
  // live flow's edges to confirm - one info text block sits between them, nothing else), so
  // answering consent2 already means both were accepted. consent1's own variableId
  // (vt7ywg1z4czezaywzpg8i1zo4) is deliberately left unmapped - it has nothing of its own to
  // persist, see saveConversationField's Consent branch.
  vrzmegndwvon5zs0ieyarz0jz: 'Consent',
};

export function resolveConversationField(variableId) {
  return ACCOUNT_FIELD_BY_VARIABLE_ID[variableId] ?? null;
}
