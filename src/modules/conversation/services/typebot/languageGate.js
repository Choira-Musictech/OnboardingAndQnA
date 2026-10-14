// ==================================================================
// Gates the Typebot conversation's "What is your mother tongue?" step: the member must choose a
// language from IPRS's own list (App_Language_Lookup, served to the chat's picker by
// GET /conversation/languages) rather than type anything. Recognised by variableId, like
// emailOtpGate.js, so it does not care where the question sits in the flow.
// ==================================================================

// The mother-tongue text-input block's variableId in the current Typebot flow - the same id
// conversationFieldMap.js maps to App_Accounts.LanguageName. Update both if that block's variable is
// re-created in Studio.
export const MOTHER_TONGUE_VARIABLE_ID = 'vh4f2w089zbn113mboiqtm37f';

export function isMotherTongueStep(variableId) {
  return variableId === MOTHER_TONGUE_VARIABLE_ID;
}
