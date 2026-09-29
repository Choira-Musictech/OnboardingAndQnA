// ==================================================================
// Turns a pasted work link into one provider-agnostic shape, so the
// conversation engine and the persistence layer never branch on where
// the song came from.
//
//   { provider, url, songName, artists[], filmOrAlbum, releaseYear,
//     publisher, composers[], lyricists[], producers[], credits[],
//     isMusicVideo }
//
// `credits` is what the member's name is matched against - every name
// the platform reported, whatever their role.
//
// WHERE EACH FIELD COMES FROM
//
// The in-house credits service (musicCredits.service.js) is the primary
// source for both platforms, because it is the only one that reports
// ROLES. Each platform has its own endpoint there. Spotify's Web API is
// still called alongside it, because Spotify credits carry no album or
// release date:
//
//   songName, artists, composers, lyricists, producers  - credits service
//   filmOrAlbum, releaseYear   - Spotify Web API on the Spotify path;
//                                the InnerTube music header on YouTube's
//   publisher                  - credits service `source`, else the
//                                album's P-line copyright
//
// Every credits-service field degrades: if it is disabled, unreachable,
// or has nothing for the link, the resolver falls back entirely to the
// old pair (Spotify Web API / oEmbed + Gemini-on-title) and simply
// returns no role-labelled credits. The chat step must never break
// because a metadata service is down.
//
// GROUNDED DATA ONLY still holds: every field above is read from an API
// response or copied out of a title/description. Nothing is inferred
// from what a model happens to know about the song. LanguageNames,
// WorkCategory and DocLink remain absent - nothing here can source them
// truthfully, and IPRS is a rights society. See AGENTS.md.
// ==================================================================
import { spotifyService } from '../../spotify/services/spotify.service.js';
import { fetchYoutubeVideo, isYoutubeUrl } from './youtube.service.js';
import { parseVideoTitle } from './gemini.service.js';
import { fetchSpotifyCredits, fetchYoutubeCredits } from './musicCredits.service.js';
import { logger } from '../../../utils/logger.js';

export const PROVIDERS = Object.freeze({ SPOTIFY: 'spotify', YOUTUBE: 'youtube' });

function isSpotifyTrackUrl(value) {
  const cleaned = String(value ?? '').trim();
  if (/^spotify:track:[A-Za-z0-9]{22}$/i.test(cleaned)) return true;
  try {
    const url = new URL(cleaned);
    return (
      url.hostname.toLowerCase() === 'open.spotify.com' &&
      /^\/track\/[A-Za-z0-9]{22}$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function detectProvider(value) {
  if (isSpotifyTrackUrl(value)) return PROVIDERS.SPOTIFY;
  if (isYoutubeUrl(value)) return PROVIDERS.YOUTUBE;
  return null;
}

// The "℗ 2017 School Boy/Interscope Records" strings Spotify returns. Prefer the P line (the
// sound-recording copyright, i.e. the label) and strip the symbol+year prefix.
function toPublisher(copyrights) {
  if (!Array.isArray(copyrights) || copyrights.length === 0) return null;
  const preferred = copyrights.find((entry) => entry?.type === 'P') ?? copyrights[0];
  const text = typeof preferred?.text === 'string' ? preferred.text.trim() : '';
  if (!text) return null;
  return text.replace(/^[©℗(C)(P)\s]*\d{4}\s*/i, '').trim() || text;
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

// Role-labelled fields, or empty ones when the credits service had nothing. Kept in one place so
// both provider paths degrade identically.
function roleFields(credits) {
  return {
    composers: credits?.composers ?? [],
    lyricists: credits?.lyricists ?? [],
    producers: credits?.producers ?? [],
  };
}

// Runs the credits service without letting its failure take the resolve down with it.
async function creditsFor(fetchFn, url) {
  try {
    return await fetchFn(url);
  } catch (err) {
    logger.warn({ err, url }, 'Credits lookup failed, continuing without role-labelled credits');
    return null;
  }
}

async function resolveSpotify(url) {
  // Both are independent lookups of the same track - run them together rather than in series, so
  // adding credits doesn't add its latency to the member's wait.
  const [creditsResult, trackResult] = await Promise.allSettled([
    creditsFor(fetchSpotifyCredits, url),
    spotifyService.getTrackMetadata(url),
  ]);

  const credits = creditsResult.status === 'fulfilled' ? creditsResult.value : null;
  const track = trackResult.status === 'fulfilled' ? trackResult.value : null;

  // The Web API is the only source of album/year, but it is not the only source of the song: a
  // credits hit alone is still a usable answer. Only give up when neither responded.
  if (!track && !credits) throw trackResult.reason;
  if (!track) {
    // Expected and fully handled while the Spotify app's Premium entitlement is lapsed (403 on
    // every /v1/tracks call - see AGENTS.md). Logged at info, without the stack: the member's link
    // resolved fine from credits, only album/year are missing, and a warn-with-stack on every
    // Spotify link makes a working system look broken. The credits service itself never failed here.
    logger.info(
      { url, reason: trackResult.reason?.errorCode ?? trackResult.reason?.message },
      'Spotify Web API unavailable; resolved from credits alone (no album/year)',
    );
  }

  const webApiArtists = track ? track.artists.map((artist) => artist.name).filter(Boolean) : [];
  const artists = credits?.artists?.length ? credits.artists : webApiArtists;
  const year = /^(\d{4})/.exec(track?.album?.release_date ?? '')?.[1];

  return {
    provider: PROVIDERS.SPOTIFY,
    url: track?.external_urls?.spotify ?? url,
    songName: credits?.songName ?? track?.name ?? null,
    artists,
    // Credits carry no album or release date - these are the Web API's alone.
    filmOrAlbum: track?.album?.name ?? null,
    releaseYear: year ? Number(year) : null,
    publisher: credits?.publisher ?? toPublisher(track?.album?.copyrights),
    ...roleFields(credits),
    // Every credited name, not just the performers - a member credited only as the lyricist now
    // matches their own song, which the artist list alone would have missed.
    credits: unique([...(credits?.allCredits ?? []), ...artists, ...webApiArtists]),
    creditText: null, // Spotify's credits are already names; there's no free text to search
    isMusicVideo: true, // a Spotify track is a song by definition
  };
}

// Fallback path: oEmbed for the title/channel, Gemini to split that title. Used when the credits
// service is off, down, or has no credit block for this video - which is also how a lecture or a
// vlog is rejected, since Gemini is the only source of the isMusicVideo judgement.
async function resolveYoutubeFromTitle(url) {
  const video = await fetchYoutubeVideo(url);
  const parsed = await parseVideoTitle({ title: video.title, channelName: video.channelName });

  // With Gemini unconfigured or failing, the raw title is still a usable answer - the member sees
  // exactly what YouTube calls the video and can confirm or reject it. Only the split is lost.
  const artists = parsed?.artists?.length ? parsed.artists : [video.channelName].filter(Boolean);

  return {
    provider: PROVIDERS.YOUTUBE,
    url: video.url,
    songName: parsed?.songName ?? video.title,
    artists,
    filmOrAlbum: parsed?.filmOrAlbum ?? null,
    // oEmbed carries no publish date, and Gemini is not allowed to supply one.
    releaseYear: null,
    publisher: null,
    ...roleFields(null),
    // Name-like strings only. The raw title used to live in here too, which is what let a bare
    // "Singh" match: a sentence in a name list forces the matcher into substring mode. It now
    // travels separately as creditText and is searched under stricter rules - see
    // workMatch.service.js.
    credits: unique([...artists, video.channelName]),
    // Free text. An artist whose name sits in the title but not where Gemini read a credit still
    // matches, but only with a full two-token name.
    creditText: video.title,
    isMusicVideo: parsed ? parsed.isMusicVideo : true,
    channelName: video.channelName,
    thumbnailUrl: video.thumbnailUrl,
  };
}

async function resolveYoutube(url) {
  const credits = await creditsFor(fetchYoutubeCredits, url);

  // No music page. TEMPTING BUT WRONG to treat this as "not a song": /youtube/raw answers with an
  // ordinary watch page for a TED talk, but ALSO for real songs that simply aren't on YouTube Music
  // (verified: "Chaleya" comes back with no music renderer at all). Rejecting on this signal would
  // throw out members' genuine work. It only means "no credits from here" - so fall through to the
  // title path, which is also what runs when the service is disabled or down.
  if (!credits) return resolveYoutubeFromTitle(url);

  // The credits service found role-labelled names but no line labelled "Song:" (verified live: a
  // real "MAKHNA" video's description credits everyone but never names the song itself) - fall back
  // to the video's own oEmbed title, exactly like resolveYoutubeFromTitle()'s fallback, rather than
  // leaving SongName null. Only fetched when actually missing, so the common case (credits service
  // also gave a song name) pays no extra latency.
  let songName = credits.songName;
  if (!songName) {
    songName = await fetchYoutubeVideo(url)
      .then((video) => video.title)
      .catch(() => null);
  }

  return {
    provider: PROVIDERS.YOUTUBE,
    url,
    songName,
    artists: credits.artists,
    filmOrAlbum: credits.filmOrAlbum,
    // The InnerTube music header carries a publish date ("626M views - Nov 7, 2022"), which oEmbed
    // never did - so a YouTube link can now fill ReleaseYear too.
    releaseYear: credits.releaseYear,
    publisher: null,
    ...roleFields(credits),
    credits: credits.allCredits,
    // The video description, not the title - so a name in the credit block that the structuring
    // missed can still match, under the two-token rule in workMatch.service.js.
    creditText: credits.creditText,
    // The service only reports a credit list for music, so reaching here means it is a song.
    isMusicVideo: true,
    channelName: credits.channelName,
  };
}

// Returns null when the link is neither a Spotify track nor a YouTube video. Throws whatever the
// provider throws when the link *looks* right but can't be fetched (deleted video, bad track id).
export async function resolveWorkLink(url) {
  switch (detectProvider(url)) {
    case PROVIDERS.SPOTIFY:
      return resolveSpotify(url);
    case PROVIDERS.YOUTUBE:
      return resolveYoutube(url);
    default:
      return null;
  }
}

export const workLinkResolver = { detectProvider, resolveWorkLink, PROVIDERS };
