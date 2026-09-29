// ==================================================================
// Work links - the songs a member claims as their own, collected during
// the Typebot conversation and stored one row per link in
// App_Accounts_WorkRegistration.
//
// Moved here from modules/spotify: links now arrive from Spotify *or*
// YouTube, so this is no longer Spotify's business.
//
// Only grounded metadata is written.
//
// Author_Composer and Author_Lyricist are filled directly from the
// role-labelled credits the credits service returns for the CONFIRMED
// song (Spotify's own contributor roles, or the credit block in a
// YouTube description) - see musicCredits.service.js. This runs only
// after the member has answered "Yes, this is my song" (registrationEngine.js
// gates saveWorkLink() behind confirmsSong()) and, separately, after the
// broader "is this genuinely your song" credits check - but the columns
// themselves are the song's own writer credit, not filtered by which
// specific role the confirming member holds in it. Each work link is its
// own row, so a member who adds several songs gets each row filled from
// that song's own credits independently.
//
// LanguageNames, WorkCategory, Film_AlbumName, Publisher, and ReleaseYear are asked from the member
// directly right after they confirm the song, whenever the resolved link didn't already supply them
// - see workDetailsGate.js's per-song follow-up in registrationEngine.js's saveAndOfferAnother().
// DocLink still stays null always - nothing we call can source it truthfully.
//
// CreatedBy/ModifedBy hold the member's own AccountName, set together at creation and never touched
// again - same pattern registration.service.js uses for App_Accounts.CreatedBy/ModifedBy.
// ==================================================================
import { workRepository } from '../repositories/work.repository.js';
import { appError } from '../../../shared/errors.js';

// How many links one member may add. Enforced here rather than only in the conversation gate so it
// holds even if the member re-enters the link step in a restarted conversation - the flow can ask
// again, but the cap still bites.
export const MAX_WORK_LINKS = 5;

// SQL Server column widths - a value that overflows fails the whole insert, so clip here. Exported
// so scripts/backfill-work-registration-credits.mjs and workDetailsGate.js build the same shape of
// update payload without duplicating these widths.
export const LIMITS = {
  SongName: 100,
  Film_AlbumName: 100,
  Artist_Singers: 500,
  Publisher: 100,
  DigitalLink: 500,
  Author_Composer: 100,
  Author_Lyricist: 100,
  LanguageNames: 100,
  CreatedBy: 100,
};

export function clip(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

// `resolved` is workLinkResolver's provider-agnostic shape.
// Returns the created row, or null when the member is already at the cap. Throws (errorCode
// WORK_LINK_DUPLICATE) when this exact link is already saved for this member - enforced here, not
// only in the conversation gate, for the same reason as the cap above: it must hold even if the
// member re-enters the link step in a restarted conversation.
async function saveWorkLink({ userId, resolved, accountName }) {
  const existing = await countWorkLinks(userId);
  if (existing >= MAX_WORK_LINKS) return null;

  const digitalLink = clip(resolved?.url, LIMITS.DigitalLink);
  if (digitalLink && await workRepository.existsByAccountIdAndDigitalLink(userId, digitalLink)) {
    throw appError("You've already added this song.", { statusCode: 409, errorCode: 'WORK_LINK_DUPLICATE' });
  }

  const artists = Array.isArray(resolved?.artists) ? resolved.artists.filter(Boolean) : [];
  const createdBy = clip(accountName, LIMITS.CreatedBy);

  return workRepository.createWorkRegistration({
    AccountId: BigInt(userId),
    SongName: clip(resolved?.songName, LIMITS.SongName),
    Film_AlbumName: clip(resolved?.filmOrAlbum, LIMITS.Film_AlbumName),
    Artist_Singers: clip(artists.join(', '), LIMITS.Artist_Singers),
    Publisher: clip(resolved?.publisher, LIMITS.Publisher),
    Author_Composer: clip(joinNames(resolved?.composers), LIMITS.Author_Composer),
    Author_Lyricist: clip(joinNames(resolved?.lyricists), LIMITS.Author_Lyricist),
    DigitalLink: digitalLink,
    ReleaseYear: Number.isInteger(resolved?.releaseYear) ? BigInt(resolved.releaseYear) : null,
    CreatedBy: createdBy,
    ModifedBy: createdBy,
  });
}

// Several people share one 100-character column, so join them and let clip() take the overflow.
// Returns null for an empty list, keeping "we had no credits" distinct from an empty string.
export function joinNames(value) {
  if (!Array.isArray(value)) return null;
  const list = [...new Set(value.filter((name) => typeof name === 'string' && name.trim()))];
  return list.length ? list.map((name) => name.trim()).join(', ') : null;
}

async function countWorkLinks(userId) {
  return workRepository.countByAccountId(userId);
}

// Oldest-first list of everything a member has saved so far - used by workDetailsGate.js's
// post-link-loop follow-up to find which rows are still missing WorkCategory/LanguageNames/ReleaseYear.
async function getWorkLinks(userId) {
  return workRepository.findByAccountId(userId);
}

// Writes one field to one already-saved row. Only ever called with a value the member just gave for
// a column that was null - never overwrites an existing answer, same write-once stance as saveWorkLink.
async function updateWorkDetails(workNotificationId, data) {
  return workRepository.updateWorkRegistration(workNotificationId, data);
}

// Called when a member explicitly starts the conversation over. Work links are the one piece of
// conversation-derived data this touches - unlike documents or account fields, they're an
// append-only list with a hard cap (MAX_WORK_LINKS), so a restart that doesn't clear them makes
// every song from a prior attempt count against that cap and reappear in later summaries, even
// though the member only added one link "this time". Documents and account fields are deliberately
// left alone - deleting an already-uploaded PAN card because someone tapped "Start over" would be
// a far worse failure than a stale song count.
async function clearWorkLinks(userId) {
  return workRepository.deleteByAccountId(userId);
}

export const workLinkService = {
  saveWorkLink,
  countWorkLinks,
  clearWorkLinks,
  getWorkLinks,
  updateWorkDetails,
  MAX_WORK_LINKS,
};
