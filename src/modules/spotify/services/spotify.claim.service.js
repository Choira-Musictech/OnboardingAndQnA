import { badRequestError, appError } from '../../../shared/errors.js';
import { spotifyService } from './spotify.service.js';
import { spotifyRepository } from '../repositories/spotify.repository.js';
import { normalizeName } from '../../../utils/name.js';
import { registrationService } from '../../registration/services/registration.service.js';

// `actualName` and `stageName` are provided by the request payload; no hardcoded defaults.

function safeString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildArtistSingers(artists) {
  if (!Array.isArray(artists)) return null;

  const names = artists
    .map((artist) => safeString(artist.name))
    .filter(Boolean);

  if (names.length === 0) return null;

  const joined = names.join(', ');
  if (joined.length <= 500) return joined;

  const truncated = joined.slice(0, 500).replace(/,?[^,]*$/, '').trim();
  return truncated.length > 0 ? truncated : null;
}

function parseReleaseYear(releaseDate) {
  if (typeof releaseDate !== 'string') return null;
  const match = releaseDate.match(/^(\d{4})/);
  if (!match) return null;
  return BigInt(match[1]);
}

function buildWorkRegistrationData(track, user, accountName) {
  return {
    AccountId: user?.id ? BigInt(user.id) : null,
    SongName: safeString(track.name),
    Film_AlbumName: safeString(track.album?.name),
    LanguageNames: null,
    WorkCategory: null,
    Artist_Singers: buildArtistSingers(track.artists),
    Author_Composer: null,
    Publisher: null,
    Author_Lyricist: null,
    DigitalLink: safeString(track.external_urls?.spotify),
    DocLink: null,
    ReleaseYear: parseReleaseYear(track.album?.release_date),
    CreatedBy: accountName,
    ModifedBy: accountName,
  };
}

function getMatchedArtists(artists, normalizedTarget) {
  return artists.filter((artist) => normalizeName(artist.name) === normalizedTarget);
}

function extractRoles(artist) {
  if (Array.isArray(artist.roles) && artist.roles.length > 0) {
    return [...new Set(artist.roles.filter((role) => typeof role === 'string'))];
  }
  return [];
}

function buildMatchResult(matchedArtists, matchedAgainst) {
  if (matchedArtists.length === 0) return null;

  const roles = Array.from(
    new Set(matchedArtists.flatMap((artist) => extractRoles(artist))),
  );

  return {
    status: true,
    matchedCredit: {
      name: matchedArtists[0].name,
      matchedAgainst,
      roles,
    },
  };
}

export async function matchSpotifyClaim(reference, user, actualName, stageName) {
  if (!reference || typeof reference !== 'string') {
    throw badRequestError('Spotify track URL is required', { errorCode: 'MISSING_SPOTIFY_URL' });
  }

  const track = await spotifyService.getTrackMetadata(reference);
  if (!track || !Array.isArray(track.artists)) {
    throw badRequestError('Spotify track metadata does not contain artist information', {
      errorCode: 'SPOTIFY_ARTIST_DATA_MISSING',
    });
  }

  const normalizedActualName = normalizeName(actualName);
  const normalizedStageName = normalizeName(stageName);

  const actualMatches = getMatchedArtists(track.artists, normalizedActualName);
  const stageMatches = getMatchedArtists(track.artists, normalizedStageName);

  const matchResult = actualMatches.length
    ? buildMatchResult(actualMatches, 'actualName')
    : stageMatches.length
    ? buildMatchResult(stageMatches, 'stageName')
    : { status: false, matchedCredit: null };

  // Only a *matched* claim is written. This used to run unconditionally, so a track whose credits
  // didn't include the caller still landed in App_Accounts_WorkRegistration - i.e. the register
  // could be filled with songs that aren't the caller's while the response said status:false.
  let workRegistration = null;
  if (matchResult.status === true) {
    // The account's own confirmed name, not actualName/stageName - those are the name being
    // searched for in the credits, not necessarily who this account belongs to. Best-effort: this
    // route doesn't otherwise touch the DB, so a lookup failure (unknown/test account id) should
    // never block saving the actual claim - same "don't let a side lookup fail the main write"
    // reasoning as registration.service.js's BookId resolution.
    let accountName = null;
    try {
      accountName = user?.id ? (await registrationService.getIdentityNames(String(user.id))).accountName : null;
    } catch {
      accountName = null;
    }

    try {
      workRegistration = await spotifyRepository.createWorkRegistration(
        buildWorkRegistrationData(track, user, accountName),
      );
    } catch (err) {
      throw appError('Failed to save work registration', {
        errorCode: 'WORK_REGISTRATION_SAVE_FAILED',
        cause: err,
      });
    }
  }

  return {
    ...matchResult,
    track: {
      id: track.id,
      name: track.name,
      spotify_url: track.external_urls?.spotify ?? null,
      artists: track.artists.map((artist) => ({
        id: artist.id,
        name: artist.name,
        external_urls: artist.external_urls,
      })),
      album: {
        id: track.album?.id,
        name: track.album?.name,
        external_urls: track.album?.external_urls,
      },
    },
    workRegistration: workRegistration
      ? { WorkNotificationId: workRegistration.WorkNotificationId?.toString?.() ?? null }
      : null,
  };
}

export const spotifyClaimService = { matchSpotifyClaim };
