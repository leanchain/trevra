-- devto was dropped from WATCH_PLATFORMS and the server platform enum (it
-- has no sitewide keyword search -- devtoScout.search always loops the four
-- hardcoded DEVTO_TAGS and never reads ScoutQuery.communities the way
-- github/reddit do, so `communities: []` is a silent no-op for it -- see the
-- module comment on src/server/watch/skill.ts). That change only stopped new
-- and edited watches from selecting it; nothing touched rows that already
-- stored it. Left alone, the worker keeps sweeping them: getScout('devto')
-- resolves, availability reports 'ready', and the scout searches four tags
-- unrelated to the watch's actual keywords -- a confident "nothing found"
-- from a platform that never looked, with no warning anywhere.
--
-- A watch whose ONLY platform was devto would be left with platforms = '{}'
-- by a plain array_remove -- legal against the NOT NULL column, but a watch
-- that can never run again (`watchMentions` requires at least one platform)
-- while still occupying a worker sweep slot on every cadence tick and
-- reading, to the founder, like an error they did nothing to cause. Decided
-- to disable those watches outright instead, with a one-time last_error
-- explaining why, rather than leave them silently re-erroring forever.
--
-- Order matters: the disable pass below reads `platforms` BEFORE devto is
-- removed from it, so `cardinality(platforms) = 1` only matches a watch that
-- had devto and nothing else.
UPDATE brand_watches
   SET enabled = FALSE,
       last_error = 'Disabled automatically: devto was this watch''s only platform, and devto was removed as a watch source because it cannot search sitewide (see gtm.watch-mentions). Add a different platform and re-enable this watch to resume.'
 WHERE 'devto' = ANY(platforms)
   AND cardinality(platforms) = 1;

UPDATE brand_watches
   SET platforms = array_remove(platforms, 'devto')
 WHERE 'devto' = ANY(platforms);
