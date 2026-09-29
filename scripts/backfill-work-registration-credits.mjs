// ==================================================================
// One-time maintenance script: re-resolves every already-saved work link whose
// Author_Composer/Author_Lyricist/ReleaseYear are still null, now that
// musicCredits.service.js has a YouTube Data API fallback (see YOUTUBE_API_KEY
// in .env) it didn't have when older rows were first saved.
//
// NEVER overwrites a column that already has a value - only fills what is
// currently null, same write-once caution as AccountName/CreatedBy elsewhere
// in this codebase. A row whose DigitalLink is dead/removed/rate-limited is
// logged and skipped, never aborts the run.
//
// Usage:
//   node scripts/backfill-work-registration-credits.mjs           (dry run - logs only)
//   node scripts/backfill-work-registration-credits.mjs --write   (writes to the DB)
// ==================================================================
import { prisma } from '../src/shared/prisma.js';
import { workLinkResolver } from '../src/modules/work/services/workLinkResolver.service.js';
import { clip, joinNames, LIMITS } from '../src/modules/work/services/workLink.service.js';

const WRITE = process.argv.includes('--write');
// Be polite to spotify.choira.in / YouTube's API - this is a background maintenance run, not a
// member waiting on a chat response.
const DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUpdate(row, resolved) {
  const update = {};

  if (row.Author_Composer == null) {
    const value = clip(joinNames(resolved?.composers), LIMITS.Author_Composer);
    if (value != null) update.Author_Composer = value;
  }
  if (row.Author_Lyricist == null) {
    const value = clip(joinNames(resolved?.lyricists), LIMITS.Author_Lyricist);
    if (value != null) update.Author_Lyricist = value;
  }
  if (row.ReleaseYear == null && Number.isInteger(resolved?.releaseYear)) {
    update.ReleaseYear = BigInt(resolved.releaseYear);
  }

  return update;
}

async function main() {
  const rows = await prisma.appAccountsWorkRegistration.findMany({
    where: {
      DigitalLink: { not: null },
      OR: [{ Author_Composer: null }, { Author_Lyricist: null }, { ReleaseYear: null }],
    },
  });

  console.log(`Found ${rows.length} row(s) with a link and something still missing.`);
  console.log(WRITE ? 'Mode: WRITE (updating the database)' : 'Mode: DRY RUN (no writes - pass --write to apply)');

  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    const id = row.WorkNotificationId;
    try {
      const resolved = await workLinkResolver.resolveWorkLink(row.DigitalLink);
      if (!resolved) {
        console.log(`  [${id}] ${row.DigitalLink} - no longer resolvable, skipped`);
        unchanged += 1;
        continue;
      }

      const update = buildUpdate(row, resolved);
      if (Object.keys(update).length === 0) {
        console.log(`  [${id}] ${row.DigitalLink} - still nothing new`);
        unchanged += 1;
        continue;
      }

      console.log(`  [${id}] ${row.DigitalLink} ->`, update);
      if (WRITE) {
        await prisma.appAccountsWorkRegistration.update({ where: { WorkNotificationId: id }, data: update });
      }
      updated += 1;
    } catch (err) {
      console.warn(`  [${id}] ${row.DigitalLink} - failed: ${err.message}`);
      failed += 1;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\nDone. ${updated} updated, ${unchanged} still empty, ${failed} failed. Scanned ${rows.length}.`);
  await prisma.$disconnect();
}

await main();
