// ==================================================================
// Which strings in a conversation payload a member actually reads.
//
// The payload is Typebot's own shape, so the text is scattered: bubble
// copy lives in content.richText as nested nodes, choice labels in
// input.items[].content, and hints in input.options.labels. Everything
// else in there - block ids, variable ids, types, URLs - must survive
// untouched, or the frontend stops recognising its own payload and the
// member's answer no longer matches the flow.
//
// Collect and apply share one traversal on purpose: a key translated on
// the way out is guaranteed to be the same key replaced on the way back.
// ==================================================================

// Keys whose STRING values are member-facing copy. `content` is in here for
// choice items (a string); on a message it is an object and so is walked, not
// translated - the type check below is what separates the two.
const TRANSLATABLE_KEYS = new Set(['text', 'content', 'placeholder', 'button', 'title']);

// Subtrees never to descend into. `url` is the link target (translating it
// breaks the link) and `variableId`/`blockId`/`id` are flow identity.
const SKIP_KEYS = new Set(['url', 'variableId', 'blockId', 'id', 'type', 'sessionId']);

function isTranslatable(key, value) {
  return typeof value === 'string' && TRANSLATABLE_KEYS.has(key) && value.trim().length > 0;
}

function walk(node, onString) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, onString);
    return;
  }
  if (!node || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (isTranslatable(key, value)) {
      onString(value);
      continue;
    }
    if (value && typeof value === 'object') walk(value, onString);
  }
}

/** Every distinct member-facing string in the payload, in first-seen order. */
export function collectTranslatable(payload) {
  const seen = new Set();
  walk(payload, (text) => seen.add(text));
  return [...seen];
}

/**
 * A copy of the payload with every member-facing string replaced from `map`.
 * A string missing from the map keeps its original wording, so a partial
 * translation degrades to mixed language rather than to blanks.
 */
export function applyTranslations(payload, map) {
  if (Array.isArray(payload)) return payload.map((item) => applyTranslations(item, map));
  if (!payload || typeof payload !== 'object') return payload;

  const out = Array.isArray(payload) ? [] : {};

  for (const [key, value] of Object.entries(payload)) {
    if (SKIP_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    if (isTranslatable(key, value)) {
      out[key] = map.get(value) ?? value;
      continue;
    }
    out[key] = value && typeof value === 'object' ? applyTranslations(value, map) : value;
  }

  return out;
}
