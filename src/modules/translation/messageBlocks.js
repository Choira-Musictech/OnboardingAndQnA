// ==================================================================
// Translating a chat bubble as one message, not as loose fragments.
//
// Typebot splits a sentence across nodes wherever formatting changes, so
// "…proof of your " + bold "permanent " + "address:" arrives as three strings.
// Translated separately they produce nonsense, and they never match a
// dictionary keyed on whole sentences. So a bubble is joined back into the
// message a member actually reads, translated once, and rebuilt.
//
// Links survive. Rebuilding as plain paragraphs would drop the Privacy Notice
// and the "Click Here to Download" form links - the NRI paths depend on those -
// so any link in the original is re-appended below the translated text with its
// URL intact.
// ==================================================================

import { lookup } from './dictionary.js';

const isLink = (node) => node && typeof node === 'object' && node.type === 'a' && node.url;

// "Privacy Notice", "(Click Here to Download)" - the label is read, the URL is not.
function translateLink(link, language) {
  const children = (link.children ?? []).map((child) => {
    if (typeof child?.text !== 'string' || !child.text.trim()) return child;
    const hit = language ? lookup(child.text.trim(), language) : null;
    return hit ? { ...child, text: child.text.replace(child.text.trim(), hit) } : child;
  });
  return { ...link, children };
}

/** The message as a member reads it: paragraphs separated by newline. */
export function messageText(content) {
  const paragraphs = [];

  for (const node of content?.richText ?? []) {
    const parts = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== 'object') return;
      if (typeof n.text === 'string') parts.push(n.text);
      (n.children ?? []).forEach(walk);
    };
    walk(node);
    const line = parts.join('').trim();
    if (line) paragraphs.push(line);
  }

  return paragraphs.join('\n');
}

function collectLinks(content) {
  const links = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (isLink(n)) links.push(n);
    (n.children ?? []).forEach(walk);
  };
  walk(content?.richText ?? []);
  return links;
}

/** The bubble rewritten in `translated`, with the original links kept below it. */
export function rebuildMessage(content, translated, language) {
  const richText = translated
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => ({ type: 'p', children: [{ text: line }] }));

  const links = collectLinks(content);
  if (links.length) {
    const shown = links.map((link) => translateLink(link, language));
    richText.push({ type: 'p', children: shown.flatMap((link, i) => (i ? [{ text: '  ' }, link] : [link])) });
  }

  return { ...content, richText };
}
