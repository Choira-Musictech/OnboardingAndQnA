// ==================================================================
// YouTube metadata via the public oEmbed endpoint - the key-free path used by
// resolveYoutubeFromTitle()'s title/channel fallback (see workLinkResolver.service.js). The
// Google OAuth client id/secret on file cannot fetch video metadata by themselves - Google rejects
// `grant_type=client_credentials` ("unsupported_grant_type") and the client id is not a valid API
// key ("API_KEY_INVALID") - but a real YouTube Data API v3 key (env.YOUTUBE_API_KEY, optional) IS
// now wired in, as a fallback description/publish-date source inside musicCredits.service.js's
// fetchYoutubeCredits() - not here, since this file's own job stays the key-free path.
//
// oEmbed needs no key at all, answers in ~0.4s, and handles every URL form members paste
// (watch?v=, youtu.be, /shorts/, music.youtube.com, and extra &list=/&index= params).
//
// What it gives: the video title, the channel name (`author_name`) and a thumbnail. What it does
// NOT give: publish date, description, tags or category.
// ==================================================================
import { appError } from '../../../shared/errors.js';
import { env } from '../../../config/env.js';

const OEMBED_URL = 'https://www.youtube.com/oembed';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

// Returns the 11-character video id, or null when this isn't a YouTube video URL.
export function parseYoutubeVideoId(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }

  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const candidate =
    url.hostname.toLowerCase().endsWith('youtu.be')
      ? segments[0]
      : url.searchParams.get('v') ??
        (['shorts', 'embed', 'live', 'v'].includes(segments[0]) ? segments[1] : null);

  return /^[A-Za-z0-9_-]{11}$/.test(candidate ?? '') ? candidate : null;
}

export function isYoutubeUrl(value) {
  return parseYoutubeVideoId(value) !== null;
}

// { videoId, title, channelName, thumbnailUrl, url } - throws on anything that isn't a
// fetchable public video (private, deleted, or a bad id all come back non-200).
export async function fetchYoutubeVideo(value) {
  const videoId = parseYoutubeVideoId(value);
  if (!videoId) {
    throw appError('Not a YouTube video URL', { statusCode: 400, errorCode: 'INVALID_YOUTUBE_URL' });
  }

  // Rebuild the URL from the parsed id rather than forwarding what the member typed - keeps
  // playlist/tracking params out of the request and out of what we store.
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  let response;
  try {
    response = await fetch(`${OEMBED_URL}?url=${encodeURIComponent(watchUrl)}&format=json`, {
      signal: AbortSignal.timeout(env.YOUTUBE_REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw appError('YouTube is unreachable', { statusCode: 502, errorCode: 'YOUTUBE_UNREACHABLE', cause });
  }

  if (!response.ok) {
    throw appError('That YouTube video could not be found', {
      statusCode: 404,
      errorCode: 'YOUTUBE_VIDEO_NOT_FOUND',
      details: { status: response.status },
    });
  }

  const body = await response.json().catch(() => null);
  if (!body?.title) {
    throw appError('YouTube returned no video details', { statusCode: 502, errorCode: 'YOUTUBE_BAD_RESPONSE' });
  }

  return {
    videoId,
    url: watchUrl,
    title: body.title,
    channelName: body.author_name ?? null,
    thumbnailUrl: body.thumbnail_url ?? null,
  };
}

export const youtubeService = { parseYoutubeVideoId, isYoutubeUrl, fetchYoutubeVideo };
