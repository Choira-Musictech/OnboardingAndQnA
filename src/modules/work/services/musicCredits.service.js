// ==================================================================
// Role-labelled song credits, from the in-house credits service
// (MUSIC_CREDITS_API_BASE_URL, default https://spotify.choira.in).
//
// ONE ENDPOINT PER PLATFORM - the caller already knows which it has, so
// the provider-specific route is used rather than the auto-detecting
// /resolve:
//
//   Spotify  GET /credits?track=<url>   - structured. `contributors[]`,
//            each with a role ("Composer", "Lyricist", "Producer",
//            "Main Artist"), read server-side from Spotify's own credits.
//
//   YouTube  GET /youtube/raw?url=<url> - the RAW InnerTube response.
//            Nothing is structured for us here, so this module reads it:
//            the music header for title/artist/year, and the description
//            shelf for the label's own credit block, which is then
//            parsed by label ("Music:", "Lyrics:", "Singers:").
//
//            FALLBACK: a video not registered on YouTube Music has no
//            InnerTube music renderer at all (verified live: a real song,
//            "Jai Durga", answers this way), even though it has a normal
//            description on YouTube itself. fetchFromYoutubeDataApi()
//            reads that description via the real YouTube Data API
//            (env.YOUTUBE_API_KEY, optional) instead - same label parsing,
//            just a different, always-available description source.
//
// WHY THIS EXISTS: it is the first source this app has that says what a
// credited person actually *did*. The Spotify Web API returns one
// unlabelled bag of artists that mixes performers with writers, and a
// YouTube title is a sentence - which is why Author_Composer and
// Author_Lyricist were historically left null.
//
// NEVER THROWS. Every failure path returns null and the caller falls
// back to the Spotify Web API / oEmbed + Gemini pair. A member must
// never be blocked on the work-link step because a metadata service is
// down.
// ==================================================================
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { parseYoutubeVideoId } from './youtube.service.js';

export const CREDIT_PLATFORMS = Object.freeze({ SPOTIFY: 'spotify', YOUTUBE: 'youtube' });

// The Spotify path writes "N/A" where it has no value, so a plain truthiness check would store the
// literal string as a song name.
function text(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.toUpperCase() === 'N/A') return null;
  return trimmed;
}

function names(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map(text).filter(Boolean))];
}

// Roles are free text from the platform, so classify by substring rather than an exact set.
function hasRole(role, ...needles) {
  const lowered = String(role ?? '').toLowerCase();
  return needles.some((needle) => lowered.includes(needle));
}

// True when the service actually found a song, as opposed to answering 200 about a TED talk or an
// unknown track id.
//
// The test is deliberately CREDITED PEOPLE, not a song name: an unknown Spotify id answers with
// "N/A" and a non-music video echoes its own title, so only a real credit list separates a song
// from a lecture.
export function hasUsableCredits(normalized) {
  if (!normalized) return false;
  return Boolean(normalized.artists.length || normalized.composers.length || normalized.lyricists.length);
}

export function isMusicCreditsEnabled() {
  return env.MUSIC_CREDITS_ENABLED && Boolean(env.MUSIC_CREDITS_API_BASE_URL);
}

// Shared transport. Returns the parsed body, or null for every failure - unreachable, non-200
// (422 is the service's "not a Spotify or YouTube link"), or unparseable.
async function getJson(path, url) {
  if (!isMusicCreditsEnabled()) return null;

  const endpoint = `${env.MUSIC_CREDITS_API_BASE_URL.replace(/\/+$/, '')}${path}`;

  let response;
  try {
    response = await fetch(endpoint, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(env.MUSIC_CREDITS_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err, url }, 'Credits service unreachable, falling back to platform APIs');
    return null;
  }

  if (!response.ok) {
    logger.warn({ status: response.status, url }, 'Credits service returned no credits');
    return null;
  }

  return response.json().catch(() => null);
}

// --- Spotify: GET /credits?track= ------------------------------------------

function normalizeSpotify(payload) {
  const contributors = Array.isArray(payload?.contributors) ? payload.contributors : [];
  const byRole = (...needles) =>
    names(contributors.filter((e) => hasRole(e?.role, ...needles)).map((e) => e?.name));

  const artists = names(
    contributors
      .filter((e) => hasRole(e?.role, 'artist') || hasRole(e?.role_group, 'artist'))
      .map((e) => e?.name),
  );

  return {
    platform: CREDIT_PLATFORMS.SPOTIFY,
    songName: text(payload?.song_name),
    // `artist` is the pipe-joined summary; prefer the structured contributors and fall back to it.
    artists: artists.length ? artists : names(String(payload?.artist ?? '').split('|')),
    composers: byRole('composer', 'music'),
    lyricists: byRole('lyric', 'writer'),
    producers: byRole('producer'),
    // The label. Spotify's credits carry no album name or release date, so those stay null here and
    // the resolver fills them from the Spotify Web API instead.
    publisher: text(payload?.source) ?? names(payload?.sources)[0] ?? null,
    filmOrAlbum: null,
    releaseYear: null,
    creditText: null,
    channelName: null,
    allCredits: names(contributors.map((entry) => entry?.name)),
  };
}

export async function fetchSpotifyCredits(url) {
  const payload = await getJson(`/credits?track=${encodeURIComponent(url)}`, url);
  if (!payload) return null;
  const normalized = normalizeSpotify(payload);
  return hasUsableCredits(normalized) ? normalized : null;
}

// --- YouTube: GET /youtube/raw?url= ----------------------------------------

// InnerTube nests its renderers differently for music and non-music pages, and the exact path
// shifts between builds. Searching by renderer name survives that; a hardcoded path does not.
function findRenderer(node, name) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRenderer(item, name);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    if (node[name]) return node[name];
    for (const value of Object.values(node)) {
      const found = findRenderer(value, name);
      if (found) return found;
    }
  }
  return null;
}

function runsText(node) {
  if (!Array.isArray(node?.runs)) return null;
  return text(node.runs.map((run) => run?.text ?? '').join(''));
}

// Which description labels may fill a legally meaningful column. Deliberately narrow: these end up
// in Author_Composer / Author_Lyricist, so only labels that unambiguously name a SONG credit
// qualify. "Written by" is excluded on purpose - in a film description it is the screenwriter
// ("Written by: Niren Bhatt" alongside "Directed by"), not the lyricist.
const CREDIT_LABELS = [
  { field: 'composers', patterns: [/^music$/, /^music by$/, /^composers?$/, /^composed by$/, /^music composed by$/, /^music composers?$/] },
  { field: 'lyricists', patterns: [/^lyrics$/, /^lyrics by$/, /^lyricists?$/, /^lyrics written by$/] },
  { field: 'artists', patterns: [/^singers?$/, /^singer[s]? *\(.*\)$/, /^vocals$/, /^sung by$/, /^featuring$/] },
  { field: 'producers', patterns: [/^music producer$/, /^produced by$/, /^producers?$/] },
  { field: 'songName', patterns: [/^song$/, /^song name$/, /^track$/], single: true },
  { field: 'filmOrAlbum', patterns: [/^album$/, /^movie$/, /^film$/, /^from the movie$/], single: true },
];

// "Arijit Singh & Sachin-Jigar" / "A, B & C" -> individual names. The " at FSOB Studios" suffix
// that engineers' credits carry is dropped so a studio name never becomes a person.
function splitNames(value) {
  return names(
    String(value ?? '')
      .split(/\s*(?:,|&|＆|\sand\s|\/|\|)\s*/i)
      .map((part) => part.replace(/\s+at\s+.*$/i, '').replace(/["'‘’“”]/g, '').trim()),
  ).filter((name) => name.length > 1 && /[a-z]/i.test(name));
}

// Reads the label's own credit block: lines shaped "Label: names". Copying labelled lines is
// grounded - nothing here infers a credit that the description did not spell out.
function parseDescription(description) {
  const found = { composers: [], lyricists: [], artists: [], producers: [], songName: null, filmOrAlbum: null };
  const everyone = [];
  if (!description) return { ...found, allNames: [] };

  for (const line of description.split(/\r?\n/)) {
    // Many labels (verified live: a real "MAKHNA" video's own description) are bulleted with a
    // leading symbol - "♪ Music: ...", "♪ Lyrics: ..." - which the label group must skip over, or
    // every credit line in that description block fails to match at all.
    const match = /^\s*[^\p{L}\n]{0,3}\s*([A-Za-z][A-Za-z0-9 &'/().-]{1,40}?)\s*[:–-]\s*(.+?)\s*$/u.exec(line);
    if (!match) continue;

    const label = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const value = match[2].trim();
    // A URL line ("Spotify - https://...") is not a credit.
    if (/https?:\/\//i.test(value)) continue;

    const parts = splitNames(value);
    if (parts.length === 0) continue;

    // Every labelled name is matchable, even from labels too ambiguous to fill a column - that only
    // decides whether the member is asked for an alias, never what is written to the register.
    everyone.push(...parts);

    const rule = CREDIT_LABELS.find((entry) => entry.patterns.some((pattern) => pattern.test(label)));
    if (!rule) continue;

    if (rule.single) {
      found[rule.field] ??= null;
      found[rule.field] ||= text(value);
    } else {
      found[rule.field].push(...parts);
    }
  }

  return {
    composers: names(found.composers),
    lyricists: names(found.lyricists),
    artists: names(found.artists),
    producers: names(found.producers),
    songName: found.songName,
    filmOrAlbum: found.filmOrAlbum,
    allNames: names(everyone),
  };
}

function normalizeYoutube(payload) {
  // A music video answers with a YouTube Music browse page; a lecture or a vlog answers with an
  // ordinary watch page carrying no music renderer.
  //
  // That is NOT a reliable "this isn't a song" test, though - a real song that isn't on YouTube
  // Music answers the same way (verified: "Chaleya"). So returning null here means only "no
  // credits available from this source", and the caller falls back to the title path rather than
  // rejecting the member's link.
  const header = findRenderer(payload, 'musicResponsiveHeaderRenderer');
  const shelf = findRenderer(payload, 'musicDescriptionShelfRenderer');
  if (!header && !shelf) return null;

  const description = runsText(shelf?.description);
  const parsed = parseDescription(description);

  const headerTitle = runsText(header?.title);
  const headerArtist = runsText(header?.straplineTextOne);
  // "626M views . Nov 7, 2022" - the only release date YouTube gives us. oEmbed carries none.
  const subtitle = runsText(header?.subtitle);
  const year = /\b(19|20)\d{2}\b/.exec(subtitle ?? '')?.[0];

  const artists = parsed.artists.length ? parsed.artists : names([headerArtist]);

  return {
    platform: CREDIT_PLATFORMS.YOUTUBE,
    // The music header's title is the clean song name; the video title is the marketing string.
    songName: headerTitle ?? parsed.songName,
    artists,
    composers: parsed.composers,
    lyricists: parsed.lyricists,
    producers: parsed.producers,
    publisher: null,
    filmOrAlbum: parsed.filmOrAlbum,
    releaseYear: year ? Number(year) : null,
    // The full description - free text the matcher searches under its stricter two-token rule.
    creditText: description,
    channelName: headerArtist,
    allCredits: names([...artists, ...parsed.allNames, headerArtist]),
  };
}

// Fallback for videos with no InnerTube music renderer at all (not registered on YouTube Music -
// verified live: a real song, "Jai Durga", answers this way) - the video still has an ordinary
// description on YouTube itself, just not exposed through the music-specific shelf renderer
// /youtube/raw reads. The official Data API's videos.list?part=snippet gives that same description
// text (parsed with the exact same parseDescription() label rules - no separate parsing logic) plus
// a real publishedAt date, for any public video regardless of YouTube Music registration.
async function fetchFromYoutubeDataApi(url) {
  if (!env.YOUTUBE_API_KEY) return null;

  const videoId = parseYoutubeVideoId(url);
  if (!videoId) return null;

  let response;
  try {
    response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${env.YOUTUBE_API_KEY}`,
      { signal: AbortSignal.timeout(env.YOUTUBE_REQUEST_TIMEOUT_MS) },
    );
  } catch (err) {
    logger.warn({ err, url }, 'YouTube Data API unreachable, continuing without it');
    return null;
  }

  if (!response.ok) {
    logger.warn({ status: response.status, url }, 'YouTube Data API returned no snippet');
    return null;
  }

  const snippet = (await response.json().catch(() => null))?.items?.[0]?.snippet;
  if (!snippet) return null;

  const parsed = parseDescription(snippet.description);
  const year = /^(\d{4})/.exec(snippet.publishedAt ?? '')?.[1];

  return {
    platform: CREDIT_PLATFORMS.YOUTUBE,
    songName: parsed.songName,
    artists: parsed.artists,
    composers: parsed.composers,
    lyricists: parsed.lyricists,
    producers: parsed.producers,
    publisher: null,
    filmOrAlbum: parsed.filmOrAlbum,
    releaseYear: year ? Number(year) : null,
    creditText: text(snippet.description),
    channelName: text(snippet.channelTitle),
    allCredits: parsed.allNames,
  };
}

export async function fetchYoutubeCredits(url) {
  const payload = await getJson(`/youtube/raw?url=${encodeURIComponent(url)}`, url);
  // A music page with an empty description still identifies the song via its header, so the
  // usability test is applied to what the header gave us.
  const fromInnerTube = payload ? normalizeYoutube(payload) : null;
  if (fromInnerTube && hasUsableCredits(fromInnerTube)) return fromInnerTube;

  const fromDataApi = await fetchFromYoutubeDataApi(url);
  return fromDataApi && hasUsableCredits(fromDataApi) ? fromDataApi : null;
}

export const musicCreditsService = {
  fetchSpotifyCredits,
  fetchYoutubeCredits,
  hasUsableCredits,
  isMusicCreditsEnabled,
  CREDIT_PLATFORMS,
};
