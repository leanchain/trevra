import { id, type Db } from '../db.js';
import {
  openSecret,
  sealSecret,
  secretsConfigured,
  type SecretContext
} from '../secrets/crypto.js';
import { WARMUP_WEEKS } from './limits.js';

/**
 * The LinkedIn seat: the human account everything else is paced against.
 *
 * A WORKSPACE MAY HAVE SEVERAL, AND THE UNIT OF EVERYTHING IS
 * (workspace_id, seat_key). That is the change migration 045 opened and
 * migration 049 finished: `linkedin_seats` is primary-keyed on the pair, and
 * so is every fact derived from a seat -- its posture and warm-up clock (this
 * module), its due actions and batches (`local-worker.ts`), its stored
 * sign-in (`secrets/linkedin.ts`), its Chrome profile directory and its
 * browser context. A checkpoint, a limit wall or a pause on one account
 * therefore stops THAT account and leaves every other seat in the workspace
 * draining.
 *
 * `owner` is the seat every single-seat workspace already has and the default
 * every function here takes when no key is named, so a caller that predates
 * multi-seat still resolves the same row it always did. It is a default, not a
 * privilege: nothing below treats it as special.
 *
 * NOTHING SAFETY-CRITICAL READS A USER-DECLARED FIELD ANY MORE, and that is
 * the rule this module now enforces.
 *
 * The warm-up ramp used to key off `account_opened_on` -- a date typed into a
 * form, about a fact no LinkedIn API publishes (plan 1.1) and that Trevra
 * could never verify. It was a question competitors never ask (they ask for a
 * login and read the rest from the session) and, more importantly, THE WRONG
 * SIGNAL: the documented risk model (plan 1.3, "Slide and Spike") is about a
 * surge in AUTOMATED activity. That is a fact about this seat's use of Trevra,
 * and we own it -- it is `activated_at` plus the `linkedin_actions` ledger. An
 * account opened in 2011 whose automation started this morning is a week-1
 * risk whatever its birthday says.
 *
 * `account_opened_on` and `connections_count` survive as INFORMATIONAL
 * columns: still stored, still settable, still shown. Nothing derives a
 * ceiling, a band or a posture from either one.
 *
 * The fail-closed rule is unchanged, and it is still the point: an unknown
 * ramp clock is paced as week 1, never as an established seat -- the same rule
 * `outreach/safety.ts` applies to an undeclared account profile, for the same
 * reason. Unproven standing is not standing.
 */

export type SeatPosture = 'warmup' | 'steady' | 'paused' | 'cooldown';

/**
 * The seat key every workspace starts with, and the default of every function
 * in this module.
 *
 * NOT THE ONLY ONE ANY MORE, and nothing here may assume it is. It is the key
 * a single-seat workspace has always used, so defaulting to it keeps every
 * pre-multi-seat call site resolving the same row -- and it is the one value
 * `secrets/linkedin.ts` reads out of `workspace_secrets` rather than out of
 * `linkedin_seat_credentials`, which is the only place in the codebase where
 * the difference between this key and any other is load-bearing.
 */
export const OWNER_SEAT_KEY = 'owner';

export interface LinkedInSeat {
  workspaceId: string;
  seatKey: string;
  ownerUserId: string | null;
  ownerName: string | null;
  label: string;
  profileUrl: string | null;
  /** 'YYYY-MM-DD', or null. INFORMATIONAL -- nothing paces off it. */
  accountOpenedOn: string | null;
  /** INFORMATIONAL. Read from the live session when the local worker can. */
  connectionsCount: number | null;
  /** IANA name, validated on write. */
  timezone: string;
  /**
   * ISO-8601. THE RAMP CLOCK: when this workspace first had a seat at all.
   *
   * Written on the FIRST write and never overwritten (see `upsertSeat`), so it
   * measures how long this seat has been automated -- which is the thing plan
   * 1.3 is actually about. Null only for a row this schema never wrote.
   */
  activatedAt: string | null;
  /** ISO-8601. When the local worker last read this seat from the live session. */
  detectedAt: string | null;
  /**
   * ISO-8601. The last time we CONFIRMED the stored browser session was live --
   * by landing on the signed-in profile, not by signing in.
   *
   * It exists so the session gets REUSED. Re-authenticating on every run is
   * slower and a far stronger ban signal than a stable session, so logging in
   * is the fallback and a working session is the normal case. Null means
   * UNKNOWN, never "signed out": a seat nobody has checked is not a seat we
   * know is out.
   */
  sessionValidAt: string | null;
  /** As STORED. `effectivePosture` is what pacing and the guard read. */
  posture: SeatPosture;
  pausedReason: string | null;
  /** JS weekday numbers, Sunday=0. An empty list disables automated activity. */
  workingDays: number[];
  /** Minutes after local midnight. */
  workStartMinute: number;
  workEndMinute: number;
  /** Operator ceilings. Trevra's researched safety bands may be lower. */
  dailyInviteLimit: number;
  dailyMessageLimit: number;
  dailyProfileViewLimit: number;
  dailyFollowLimit: number;
  /**
   * THE INFORMED OPT-IN THAT MAKES THE FOUR NUMBERS ABOVE BINDING.
   *
   * The product brief gives the operator a daily ceiling per kind (invites
   * default 30, range 0-75; messages 25; profile views 25; follows 20), and
   * every ceiling in this subsystem is `min(band, operator)` -- Trevra's own
   * researched bands (`limits.ts`: 18 invites/day, 12 dm/day in the steady
   * band) are stricter than the defaults the form offers. An operator who
   * types 30 therefore gets 18, silently, with nothing anywhere saying why.
   *
   * False (the default) keeps that behaviour, which is the right one: the
   * bands are what the research says, and quietly obeying a bigger number is
   * how accounts get restricted. True says the operator has read what the
   * band is and is taking their own number instead, and it lifts the
   * steady/warm-up BAND cap only.
   *
   * WHAT IT DOES NOT LIFT, and this is the whole reason it is safe to offer:
   * both ramps still apply on top of it -- the per-seat warm-up week
   * (`warmupMultiplierFor`) and the per-campaign 20/40/60/80/100% day ramp
   * (`campaignActionLimit`) -- as do the rolling windows, the day-over-day
   * variance clamp, the working window, and posture. An override is a
   * different ceiling, never an absence of one.
   */
  safetyBandOverride: boolean;
  capabilities: {
    inmail: 'unknown' | 'available' | 'unavailable';
    premium: boolean;
    salesNavigator: boolean;
    recruiter: boolean;
  };
  /** Operator budget for InMail sends in one rolling month. Null uses the researched hard monthly ceiling. */
  inmailMonthlyBudget: number | null;
  /** Paid InMail credits this campaign automation may consume. Null means paid credits are not approved. */
  inmailPaidCreditCap: number | null;
  /**
   * This account's own outbound proxy, REDACTED. Null when it has none.
   *
   * The password is never on this type in any form, for the same reason
   * `LinkedInSeatAuth` has no password field: this object is serialised
   * straight onto the wire by three routes, and a credential that is rendered
   * back to a browser is a credential in a screenshot, a bug report and a
   * support thread. {@link seatProxyUrl} is the only reader of the stored
   * string and it is server-side only.
   */
  proxy: SeatProxyView | null;
}

/**
 * A seat's proxy as a screen may see it: enough to confirm WHICH proxy is
 * configured, never enough to use it.
 */
export interface SeatProxyView {
  /** `scheme://host:port`, credentials stripped. */
  server: string;
  /** The proxy account name, when the URL carries one. */
  username: string | null;
  /** Whether a password is stored with it. The password itself never leaves the server. */
  hasPassword: boolean;
}

/**
 * The stored proxy URL as a screen may see it, or null.
 *
 * DISPLAY ONLY, AND DELIBERATELY NOT THE AUTHORITY. `resolveSeatProxy` in
 * local-worker.ts is what decides whether a configured proxy is usable, and it
 * REFUSES TO OPEN A BROWSER when it is not -- that refusal is the safety
 * property, and a second copy of the rules here could only ever disagree with
 * it. A value this cannot even parse comes back null rather than throwing,
 * because a seat read must not fail over a display field; the launch still
 * refuses, and the write path (`upsertSeat`, via the route) validates through
 * the real resolver before anything is stored.
 */
export function describeSeatProxy(raw: string | null): SeatProxyView | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  return {
    server: `${url.protocol.replace(':', '')}://${url.host}`,
    username: url.username ? decodeURIComponent(url.username) : null,
    hasPassword: Boolean(url.password)
  };
}

/**
 * A seat edit.
 *
 * `activatedAt` is deliberately absent. The ramp clock is not editable by
 * anyone, through any path: a clock an operator can reset is not a clock, and
 * the whole reason the ramp moved off `account_opened_on` was to stop it being
 * a claim.
 */
export interface SeatPatch {
  ownerUserId?: string | null;
  label?: string;
  profileUrl?: string | null;
  accountOpenedOn?: string | null;
  connectionsCount?: number | null;
  timezone?: string;
  posture?: SeatPosture;
  /** ISO-8601, written by the detect path. Absent means unchanged. */
  detectedAt?: string | null;
  /** ISO-8601, written whenever a live session is confirmed. Absent means unchanged. */
  sessionValidAt?: string | null;
  workingDays?: number[];
  workStartMinute?: number;
  workEndMinute?: number;
  dailyInviteLimit?: number;
  dailyMessageLimit?: number;
  dailyProfileViewLimit?: number;
  dailyFollowLimit?: number;
  /** See {@link LinkedInSeat.safetyBandOverride}. Absent means unchanged; a first write defaults to false. */
  safetyBandOverride?: boolean;
  /**
   * This account's outbound proxy, as a full `scheme://user:pass@host:port`.
   *
   * WRITE-ONLY. Absent means unchanged, and null or an empty string removes
   * it; it is never read back out of {@link LinkedInSeat}, which carries the
   * redacted {@link SeatProxyView} instead.
   *
   * A STORED PROXY OUTRANKS EVERY `TREVRA_LINKEDIN_PROXY*` VARIABLE for this
   * seat, and setting one that cannot be used stops that seat rather than
   * letting it connect directly -- see `resolveSeatProxy`.
   */
  proxyUrl?: string | null;
}

interface SeatRow {
  workspace_id: string;
  seat_key: string;
  owner_user_id: string | null;
  owner_name: string | null;
  label: string;
  profile_url: string | null;
  account_opened_on: string | null;
  connections_count: number | null;
  timezone: string;
  activated_at: string | null;
  detected_at: string | null;
  session_valid_at: string | null;
  posture: string;
  paused_reason: string | null;
  working_days: unknown;
  work_start_minute: number;
  work_end_minute: number;
  daily_invite_limit: number;
  daily_message_limit: number;
  daily_profile_view_limit: number;
  daily_follow_limit: number;
  safety_band_override: boolean;
  capabilities_json: unknown;
  inmail_monthly_budget: number | null;
  inmail_paid_credit_cap: number | null;
  proxy_server: string | null;
  proxy_username: string | null;
  proxy_has_password: boolean;
}

/**
 * DATE and TIMESTAMPTZ are both formatted in SQL rather than parsed from what
 * the driver hands back -- the pool sets a pass-through parser for 1184, and
 * pg's default DATE parser would produce a Date at the SERVER process's local
 * midnight, which is a different day for half the planet. Same choice, same
 * reason, as `outreach/store.ts`.
 */
// `linkedin_seats.auth_mode` (migration 028) is no longer read or written here:
// the manual/zero-custody sign-in path was removed and every seat now signs
// itself in with stored credentials. The column and its CHECK constraint are
// left in the schema rather than dropped in this pass.
// lc-debt: auth_mode column left unused rather than dropped; upgrade path is a
// follow-up migration to remove it once nothing references migration 028.
const SEAT_COLUMNS = `
  workspace_id,
  seat_key,
  owner_user_id,
  (SELECT COALESCE(u.name,u.email) FROM users u WHERE u.id=linkedin_seats.owner_user_id) AS owner_name,
  label,
  profile_url,
  TO_CHAR(account_opened_on, 'YYYY-MM-DD') AS account_opened_on,
  connections_count,
  timezone,
  TO_CHAR(activated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS activated_at,
  TO_CHAR(detected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS detected_at,
  TO_CHAR(session_valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS session_valid_at,
  posture,
  paused_reason,
  working_days,
  work_start_minute,
  work_end_minute,
  daily_invite_limit,
  daily_message_limit,
  daily_profile_view_limit,
  daily_follow_limit,
  safety_band_override,
  capabilities_json,
  inmail_monthly_budget,
  inmail_paid_credit_cap,
  proxy_server,
  proxy_username,
  proxy_has_password
`;

function parsedWorkingDays(value: unknown): number[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  if (!Array.isArray(raw)) return [];
  return raw.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

function parsedCapabilities(value: unknown): LinkedInSeat['capabilities'] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return {};
          }
        })()
      : value;
  const object =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const inmail =
    object.inmail === 'available' || object.inmail === 'unavailable' ? object.inmail : 'unknown';
  return {
    inmail,
    premium: object.premium === true,
    salesNavigator: object.salesNavigator === true,
    recruiter: object.recruiter === true
  };
}

function toSeat(row: SeatRow): LinkedInSeat {
  return {
    workspaceId: row.workspace_id,
    seatKey: row.seat_key,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    label: row.label,
    profileUrl: row.profile_url,
    accountOpenedOn: row.account_opened_on,
    connectionsCount: row.connections_count,
    timezone: row.timezone,
    activatedAt: row.activated_at,
    detectedAt: row.detected_at,
    sessionValidAt: row.session_valid_at,
    posture: row.posture as SeatPosture,
    pausedReason: row.paused_reason,
    workingDays: parsedWorkingDays(row.working_days),
    workStartMinute: Number(row.work_start_minute),
    workEndMinute: Number(row.work_end_minute),
    dailyInviteLimit: Number(row.daily_invite_limit),
    dailyMessageLimit: Number(row.daily_message_limit),
    dailyProfileViewLimit: Number(row.daily_profile_view_limit),
    dailyFollowLimit: Number(row.daily_follow_limit),
    // Fails CLOSED on a row this schema never wrote: an absent flag is not an
    // override, it is a seat nobody has opted in for.
    safetyBandOverride: row.safety_band_override === true,
    capabilities: parsedCapabilities(row.capabilities_json),
    inmailMonthlyBudget:
      row.inmail_monthly_budget === null ? null : Number(row.inmail_monthly_budget),
    inmailPaidCreditCap:
      row.inmail_paid_credit_cap === null ? null : Number(row.inmail_paid_credit_cap),
    // Only non-secret metadata crosses the route boundary. The full URL lives
    // in linkedin_seat_proxy_secrets and is decrypted only by seatProxyUrl().
    proxy: row.proxy_server
      ? {
          server: row.proxy_server,
          username: row.proxy_username,
          hasPassword: row.proxy_has_password === true
        }
      : null
  };
}

/** The row identity used to bind a sealed proxy to one tenant + seat. */
export function seatProxySecretContext(workspaceId: string, seatKey: string): SecretContext {
  return { store: 'linkedin_seat_proxy_secrets', workspaceId, seatKey, kind: 'linkedin.proxy' };
}

interface SeatProxySecretRow {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  key_id: string | null;
}

/**
 * The seat's full proxy URL, decrypted at the browser-launch boundary only.
 * No route calls this. A legacy plaintext row is opportunistically converted
 * when a key exists; without a key it fails closed instead of continuing to
 * treat a database credential as ordinary configuration.
 */
export async function seatProxyUrl(
  db: Db,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const sealed = await db
    .prepare(
      `
    SELECT ciphertext,iv,auth_tag,key_version,key_id
    FROM linkedin_seat_proxy_secrets
    WHERE workspace_id=? AND seat_key=?
  `
    )
    .get<SeatProxySecretRow>(workspaceId, seatKey);
  if (sealed) {
    return openSecret(
      {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        authTag: sealed.auth_tag,
        keyVersion: Number(sealed.key_version),
        keyId: sealed.key_id
      },
      seatProxySecretContext(workspaceId, seatKey),
      env
    );
  }

  const legacy = await db
    .prepare('SELECT proxy_url FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
    .get<{ proxy_url: string | null }>(workspaceId, seatKey);
  const plaintext = legacy?.proxy_url?.trim() || null;
  if (!plaintext) return null;
  if (!secretsConfigured(env)) {
    throw new Error(
      'This LinkedIn account still has a legacy plaintext proxy credential, but TREVRA_SECRETS_KEY is not configured so Trevra cannot migrate it safely.'
    );
  }
  await putSeatProxySecret(db, workspaceId, seatKey, plaintext, env);
  return plaintext;
}

/**
 * Seal or clear one seat's full proxy URL. The seat row stores only metadata
 * the UI is already allowed to display; the legacy plaintext column is always
 * nulled in the same transaction as the secret write.
 */
export async function putSeatProxySecret(
  db: Db,
  workspaceId: string,
  seatKey: string,
  raw: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const value = raw?.trim() || null;
  if (!value) {
    await db.transaction(async (tx) => {
      await tx
        .prepare('DELETE FROM linkedin_seat_proxy_secrets WHERE workspace_id=? AND seat_key=?')
        .run(workspaceId, seatKey);
      await tx
        .prepare(
          `
        UPDATE linkedin_seats
        SET proxy_url=NULL, proxy_server=NULL, proxy_username=NULL, proxy_has_password=FALSE, updated_at=CURRENT_TIMESTAMP
        WHERE workspace_id=? AND seat_key=?
      `
        )
        .run(workspaceId, seatKey);
    });
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "This account's own proxy setting is not a URL. Use http://user:pass@host:port, https://... or socks5://host:port."
    );
  }
  const scheme = url.protocol.replace(':', '');
  if (!['http', 'https', 'socks5'].includes(scheme) || !url.hostname) {
    throw new Error(
      "This account's own proxy setting must use http, https or socks5 and name a proxy host."
    );
  }
  if (scheme === 'socks5' && (url.username || url.password)) {
    throw new Error(
      "This account's own proxy setting is a SOCKS proxy with credentials, which Chromium cannot authenticate. Use an http proxy, or a SOCKS proxy that authorises this machine by IP."
    );
  }

  const sealed = sealSecret(value, seatProxySecretContext(workspaceId, seatKey), env);
  const server = `${scheme}://${url.host}`;
  const username = url.username ? decodeURIComponent(url.username) : null;
  const hasPassword = Boolean(url.password);
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .prepare(
        `
      INSERT INTO linkedin_seat_proxy_secrets
        (id,workspace_id,seat_key,ciphertext,iv,auth_tag,key_version,key_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (workspace_id,seat_key) DO UPDATE SET
        ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv, auth_tag=EXCLUDED.auth_tag,
        key_version=EXCLUDED.key_version, key_id=EXCLUDED.key_id, updated_at=EXCLUDED.updated_at
    `
      )
      .run(
        id('lpxy'),
        workspaceId,
        seatKey,
        sealed.ciphertext,
        sealed.iv,
        sealed.authTag,
        sealed.keyVersion,
        sealed.keyId,
        now,
        now
      );
    await tx
      .prepare(
        `
      UPDATE linkedin_seats
      SET proxy_url=NULL, proxy_server=?, proxy_username=?, proxy_has_password=?, updated_at=?
      WHERE workspace_id=? AND seat_key=?
    `
      )
      .run(server, username, hasPassword, now, workspaceId, seatKey);
  });
}

/** Seal every pre-076 plaintext proxy; used by the release migration job. */
export async function migrateLegacySeatProxies(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const rows = await db
    .prepare(
      `
    SELECT workspace_id,seat_key,proxy_url
    FROM linkedin_seats
    WHERE proxy_url IS NOT NULL AND btrim(proxy_url) <> ''
    ORDER BY workspace_id,seat_key
  `
    )
    .all<{ workspace_id: string; seat_key: string; proxy_url: string }>();
  if (rows.length > 0 && !secretsConfigured(env)) {
    throw new Error(
      `Cannot migrate ${rows.length} legacy LinkedIn proxy credential(s): TREVRA_SECRETS_KEY is not configured.`
    );
  }
  for (const row of rows)
    await putSeatProxySecret(db, row.workspace_id, row.seat_key, row.proxy_url, env);
  return rows.length;
}

/** Hosted startup invariant: no proxy credential may remain in plaintext. */
export async function assertNoLegacySeatProxyPlaintext(
  db: Db,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (env.TREVRA_DEPLOYMENT_MODE !== 'hosted') return;
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS total FROM linkedin_seats WHERE proxy_url IS NOT NULL AND btrim(proxy_url) <> ''`
    )
    .get<{ total: number }>();
  if ((row?.total ?? 0) > 0) {
    throw new Error(
      `Hosted startup refused: ${row!.total} LinkedIn seat proxy credential(s) are still stored in the legacy plaintext proxy_url column. Run the migration job before serving traffic.`
    );
  }
}

/** The workspace's seat, or undefined when none is configured. */
export async function getSeat(
  db: Db,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInSeat | undefined> {
  const row = await db
    .prepare(`SELECT ${SEAT_COLUMNS} FROM linkedin_seats WHERE workspace_id=? AND seat_key=?`)
    .get<SeatRow>(workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Every seat in the workspace: today, zero or one.
 *
 * Plural because the caller's shape must not change when the agency case
 * lands, and because a UI that lists seats should not be rewritten to list
 * one.
 */
/**
 * Every workspace with a LinkedIn seat, for a worker deciding whose turn it is.
 *
 * DRIVEN OFF THE SEAT AND NOT OFF DUE ACTIONS, which is the difference between
 * this and `workspacesWithDueActions`. That one answers "who has something
 * scheduled"; this answers "who has a LinkedIn account Trevra acts for". The
 * periodic work -- reading the inbox, reconciling LinkedIn's pending-invite
 * list, draining the withdrawal queue -- is exactly what a workspace with an
 * EMPTY send queue needs, and keying it off due actions would skip the
 * workspaces it exists to help.
 *
 * Paused and cooling seats are included: every job re-reads the posture and
 * refuses for itself, and filtering here would put that rule in two places.
 */
export async function linkedinWorkspaceIds(db: Db): Promise<string[]> {
  const rows = await db
    .prepare(
      `
    SELECT DISTINCT workspace_id FROM linkedin_seats ORDER BY workspace_id
  `
    )
    .all<{ workspace_id: string }>();
  return rows.map((row) => row.workspace_id);
}

/** One configured LinkedIn account, named the way every execution path keys on it. */
export interface SeatRef {
  workspaceId: string;
  seatKey: string;
}

/**
 * EVERY seat on this deployment, as the pair everything downstream is keyed by.
 *
 * The multi-seat replacement for iterating {@link linkedinWorkspaceIds} and
 * assuming one account behind each id. A worker doing the periodic work --
 * reading the inbox, reconciling pending invites, draining withdrawals,
 * walking a lead source -- has to do it once per ACCOUNT, because every one of
 * those reads a different signed-in session; doing it once per workspace would
 * silently serve only whichever seat came first.
 *
 * Paused and cooling seats are included, for the same reason
 * `linkedinWorkspaceIds` includes them: every job re-reads the posture and
 * refuses for itself, and filtering here would put that rule in two places.
 */
export async function linkedinSeatRefs(db: Db): Promise<SeatRef[]> {
  const rows = await db
    .prepare(
      `
    SELECT workspace_id, seat_key FROM linkedin_seats ORDER BY workspace_id, seat_key
  `
    )
    .all<{ workspace_id: string; seat_key: string }>();
  return rows.map((row) => ({ workspaceId: row.workspace_id, seatKey: row.seat_key }));
}

export async function listSeats(db: Db, workspaceId: string): Promise<LinkedInSeat[]> {
  const rows = await db
    .prepare(
      `SELECT ${SEAT_COLUMNS} FROM linkedin_seats WHERE workspace_id=? ORDER BY created_at ASC, seat_key ASC`
    )
    .all<SeatRow>(workspaceId);
  return rows.map(toSeat);
}

/**
 * Throw unless `timezone` is a name this runtime's ICU actually knows.
 *
 * Validated on write and never on read: a bad name stored once would fail
 * every plan afterwards, at a point where the operator has no idea which field
 * was wrong. Exported because a detect request is QUEUED here and executed on
 * another machine minutes later -- a timezone the caller could have been told
 * about immediately must not surface as a worker-side failure instead.
 */
export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(
      `'${timezone}' is not an IANA timezone name. Use something like 'Europe/Zurich' or 'America/New_York'.`
    );
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Create or update the seat.
 *
 * Absent patch fields mean UNCHANGED, never cleared: an operator turning a
 * seat's timezone into something correct must not silently wipe the rest of
 * it. Explicit `null` does clear a nullable field, which is how a mistaken
 * profile URL is removed.
 *
 * `label` and `timezone` have no defaults to fall back to, so the first write
 * must supply both, and the error says so rather than surfacing a NOT NULL
 * violation.
 *
 * THE FIRST WRITE STARTS THE RAMP, AND ONLY THE FIRST WRITE. `activated_at` is
 * set from `now` on insert and COALESCEd on conflict, so it survives every
 * later edit -- including this function's own, including a re-detect, and
 * including a `resumeSeat` cycle. That is not a nicety: it is the difference
 * between a ramp and a suggestion. Anything an operator could reset by saving
 * a form again is exactly the property that made `account_opened_on` the wrong
 * signal to pace on.
 */
export async function upsertSeat(
  db: Db,
  workspaceId: string,
  patch: SeatPatch,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY,
  env: NodeJS.ProcessEnv = process.env
): Promise<LinkedInSeat> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(seatKey))
    throw new Error('seat_key must be 1-64 letters, numbers, underscores or dashes.');
  if (patch.proxyUrl?.trim() && !secretsConfigured(env)) {
    throw new Error(
      'TREVRA_SECRETS_KEY is required to store a LinkedIn proxy credential; Trevra will not write it in plaintext.'
    );
  }
  const existing = await getSeat(db, workspaceId, seatKey);

  const label = patch.label ?? existing?.label;
  if (!label?.trim()) throw new Error('A LinkedIn seat needs a label, e.g. "Pankaj (founder)".');
  const timezone = patch.timezone ?? existing?.timezone;
  if (!timezone?.trim())
    throw new Error(
      'A LinkedIn seat needs an IANA timezone; it decides which 08:00-18:00 the plan spreads across.'
    );
  assertTimezone(timezone);

  const accountOpenedOn =
    patch.accountOpenedOn === undefined
      ? (existing?.accountOpenedOn ?? null)
      : patch.accountOpenedOn;
  if (accountOpenedOn !== null && !ISO_DATE.test(accountOpenedOn)) {
    throw new Error(`account_opened_on must be a 'YYYY-MM-DD' date; got '${accountOpenedOn}'.`);
  }

  const posture = patch.posture ?? existing?.posture ?? 'warmup';
  // A seat that is no longer paused has no pause reason. Keeping the old
  // string around would leave the UI explaining a stop that is over.
  const pausedReason = posture === 'paused' ? (existing?.pausedReason ?? null) : null;
  const detectedAt =
    patch.detectedAt === undefined ? (existing?.detectedAt ?? null) : patch.detectedAt;
  const sessionValidAt =
    patch.sessionValidAt === undefined ? (existing?.sessionValidAt ?? null) : patch.sessionValidAt;
  const workingDays = patch.workingDays ?? existing?.workingDays ?? [1, 2, 3, 4, 5];
  if (
    !Array.isArray(workingDays) ||
    workingDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error('working_days must contain only weekday numbers 0-6.');
  }
  const workStartMinute = patch.workStartMinute ?? existing?.workStartMinute ?? 480;
  const workEndMinute = patch.workEndMinute ?? existing?.workEndMinute ?? 1080;
  if (
    !Number.isInteger(workStartMinute) ||
    !Number.isInteger(workEndMinute) ||
    workStartMinute < 0 ||
    workEndMinute > 1440 ||
    workEndMinute <= workStartMinute
  ) {
    throw new Error(
      'Working hours must be whole minutes in one local day, with the end after the start.'
    );
  }
  const resolveLimit = (
    value: number | undefined,
    fallback: number,
    max: number,
    name: string
  ): number => {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 0 || resolved > max)
      throw new Error(`${name} must be a whole number from 0 to ${max}.`);
    return resolved;
  };
  const dailyInviteLimit = resolveLimit(
    patch.dailyInviteLimit,
    existing?.dailyInviteLimit ?? 30,
    75,
    'daily_invite_limit'
  );
  const dailyMessageLimit = resolveLimit(
    patch.dailyMessageLimit,
    existing?.dailyMessageLimit ?? 25,
    75,
    'daily_message_limit'
  );
  const dailyProfileViewLimit = resolveLimit(
    patch.dailyProfileViewLimit,
    existing?.dailyProfileViewLimit ?? 25,
    100,
    'daily_profile_view_limit'
  );
  const dailyFollowLimit = resolveLimit(
    patch.dailyFollowLimit,
    existing?.dailyFollowLimit ?? 20,
    50,
    'daily_follow_limit'
  );
  // Absent means UNCHANGED, like every other field here; a seat that has never
  // been opted in is false. There is no path that turns this on by inference.
  const safetyBandOverride = patch.safetyBandOverride ?? existing?.safetyBandOverride ?? false;
  const timestamp = now.toISOString();

  await db
    .prepare(
      `
    INSERT INTO linkedin_seats (
      workspace_id, seat_key, owner_user_id, label, profile_url, account_opened_on, connections_count,
      timezone, activated_at, detected_at, session_valid_at, posture, paused_reason,
      working_days, work_start_minute, work_end_minute, daily_invite_limit,
      daily_message_limit, daily_profile_view_limit, daily_follow_limit, safety_band_override, created_at, updated_at
    ) VALUES (?,?,?,?, ?,?::date,?::int,?,?::timestamptz,?::timestamptz,?::timestamptz,?,?,?::jsonb,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (workspace_id, seat_key) DO UPDATE SET
      owner_user_id = COALESCE(excluded.owner_user_id, linkedin_seats.owner_user_id),
      label = excluded.label,
      profile_url = excluded.profile_url,
      account_opened_on = excluded.account_opened_on,
      connections_count = excluded.connections_count,
      timezone = excluded.timezone,
      -- WRITE-ONCE, and the COALESCE is the enforcement. Every other column
      -- here takes the incoming value; this one keeps the one already stored.
      activated_at = COALESCE(linkedin_seats.activated_at, excluded.activated_at),
      detected_at = excluded.detected_at,
      session_valid_at = excluded.session_valid_at,
      posture = excluded.posture,
      paused_reason = excluded.paused_reason,
      working_days = excluded.working_days,
      work_start_minute = excluded.work_start_minute,
      work_end_minute = excluded.work_end_minute,
      daily_invite_limit = excluded.daily_invite_limit,
      daily_message_limit = excluded.daily_message_limit,
      daily_profile_view_limit = excluded.daily_profile_view_limit,
      daily_follow_limit = excluded.daily_follow_limit,
      safety_band_override = excluded.safety_band_override,
      updated_at = excluded.updated_at
    RETURNING workspace_id
  `
    )
    .run(
      workspaceId,
      seatKey,
      patch.ownerUserId === undefined ? (existing?.ownerUserId ?? null) : patch.ownerUserId,
      label.trim(),
      patch.profileUrl === undefined ? (existing?.profileUrl ?? null) : patch.profileUrl,
      accountOpenedOn,
      patch.connectionsCount === undefined
        ? (existing?.connectionsCount ?? null)
        : patch.connectionsCount,
      timezone.trim(),
      timestamp,
      detectedAt,
      sessionValidAt,
      posture,
      pausedReason,
      JSON.stringify([...new Set(workingDays)]),
      workStartMinute,
      workEndMinute,
      dailyInviteLimit,
      dailyMessageLimit,
      dailyProfileViewLimit,
      dailyFollowLimit,
      safetyBandOverride,
      timestamp,
      timestamp
    );

  // Proxy writes are separate from the seat UPSERT because the full credential
  // belongs to the encrypted vault, not to the seat row. Absent means leave the
  // existing secret alone; explicit null/blank deletes it.
  if (patch.proxyUrl !== undefined) {
    await putSeatProxySecret(db, workspaceId, seatKey, patch.proxyUrl, env);
  }
  const row = await getSeat(db, workspaceId, seatKey);
  if (!row) throw new Error('LinkedIn seat was not persisted');
  return row;
}

/**
 * Record that this seat's stored browser session was seen to be LIVE.
 *
 * Written only where that was actually observed -- a signed-in profile page
 * loaded, or a sign-in that just succeeded -- and never on an attempt. The
 * column's whole job is to let the next run REUSE a session instead of
 * re-authenticating, and a timestamp written on hope would defeat it.
 */
export async function setSeatCapabilities(
  db: Db,
  workspaceId: string,
  seatKey: string,
  input: {
    inmail: 'unknown' | 'available' | 'unavailable';
    premium?: boolean;
    salesNavigator?: boolean;
    recruiter?: boolean;
    inmailMonthlyBudget?: number | null;
    inmailPaidCreditCap?: number | null;
  },
  now: Date = new Date()
): Promise<LinkedInSeat> {
  const monthly = input.inmailMonthlyBudget;
  const paid = input.inmailPaidCreditCap;
  if (monthly != null && (!Number.isInteger(monthly) || monthly < 0 || monthly > 10000))
    throw new Error('InMail monthly budget must be a whole number from 0 to 10000.');
  if (paid != null && (!Number.isInteger(paid) || paid < 0 || paid > 10000))
    throw new Error('InMail paid credit cap must be a whole number from 0 to 10000.');
  const result = await db
    .prepare(
      `
    UPDATE linkedin_seats SET capabilities_json=?::jsonb,inmail_monthly_budget=?,inmail_paid_credit_cap=?,updated_at=?
    WHERE workspace_id=? AND seat_key=?
  `
    )
    .run(
      JSON.stringify({
        inmail: input.inmail,
        premium: input.premium === true,
        salesNavigator: input.salesNavigator === true,
        recruiter: input.recruiter === true
      }),
      monthly ?? null,
      paid ?? null,
      now.toISOString(),
      workspaceId,
      seatKey
    );
  if (!result.changes) throw new Error(`LinkedIn account '${seatKey}' is not configured.`);
  return (await getSeat(db, workspaceId, seatKey)) as LinkedInSeat;
}

export async function stampSeatSessionValid(
  db: Db,
  workspaceId: string,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInSeat | undefined> {
  const row = await db
    .prepare(
      `
    UPDATE linkedin_seats SET session_valid_at=?, updated_at=?
    WHERE workspace_id=? AND seat_key=?
    RETURNING ${SEAT_COLUMNS}
  `
    )
    .get<SeatRow>(now.toISOString(), now.toISOString(), workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Stop the seat, with a reason an operator will read later.
 *
 * The reason is not decoration: `pauseSeat` is what gets called when LinkedIn
 * restricts an account, and "why is this stopped" three weeks later is the
 * question the column answers.
 */
export async function pauseSeat(
  db: Db,
  workspaceId: string,
  reason: string,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInSeat | undefined> {
  const row = await db
    .prepare(
      `
    UPDATE linkedin_seats SET posture='paused', paused_reason=?, updated_at=?
    WHERE workspace_id=? AND seat_key=?
    RETURNING ${SEAT_COLUMNS}
  `
    )
    .get<SeatRow>(reason, now.toISOString(), workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Restart the seat.
 *
 * Stores 'warmup', which is the conservative value and not necessarily the one
 * that takes effect: `effectivePosture` re-derives warmup-vs-steady from the
 * ramp clock on the next read. Resuming a seat that has been automated for a
 * year does not put it back through the ramp, and resuming a three-week-old
 * one does not let it out. The clock itself is untouched here -- a pause is
 * not a reason to restart a ramp, and being able to earn one back by pausing
 * would be an incentive pointing the wrong way.
 */
export async function resumeSeat(
  db: Db,
  workspaceId: string,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY
): Promise<LinkedInSeat | undefined> {
  const row = await db
    .prepare(
      `
    UPDATE linkedin_seats SET posture='warmup', paused_reason=NULL, updated_at=?
    WHERE workspace_id=? AND seat_key=?
    RETURNING ${SEAT_COLUMNS}
  `
    )
    .get<SeatRow>(now.toISOString(), workspaceId, seatKey);
  return row ? toSeat(row) : undefined;
}

/**
 * Forget this workspace ever had a seat.
 *
 * THIS RESETS THE RAMP CLOCK, ON PURPOSE, AND THAT IS THE ONE THING TO KNOW
 * BEFORE CALLING IT. `activatedAt` is write-once everywhere else in this
 * module -- no patch, no re-detect, no pause/resume cycle can touch it -- and
 * this function is the sole exception, because deleting the row is the one
 * operator action that legitimately means "start over": the next seat this
 * workspace gets, however it gets one, is a brand new week-1 account by the
 * same rule an undeclared seat already is. It is not a rule this function
 * bends; it is the one path that was always meant to end the ramp instead of
 * pausing it.
 *
 * Leaves `linkedin_actions` (the send ledger), `linkedin_seat_detect_requests`
 * and any stored credentials untouched -- none of those are "the seat", and a
 * delete here must not quietly erase send history or a password the operator
 * did not ask to remove.
 */
export async function deleteSeat(
  db: Db,
  workspaceId: string,
  seatKey: string = OWNER_SEAT_KEY
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM linkedin_seats WHERE workspace_id=? AND seat_key=?')
    .run(workspaceId, seatKey);
  return result.changes > 0;
}

/**
 * The 1-based warm-up week for a seat's ramp clock.
 *
 * `activatedAt` is an ISO-8601 instant: the moment this workspace first had a
 * seat, and therefore the moment its automated activity could first exist.
 * Days 0-6 are week 1. An absent, unparseable, or future instant is week 1 --
 * the most restrictive answer, and the one that is right when we do not know.
 */
export function warmupWeekOf(activatedAt: string | null, now: Date): number {
  if (!activatedAt) return 1;
  const activated = Date.parse(activatedAt);
  if (Number.isNaN(activated)) return 1;
  const days = Math.floor((now.getTime() - activated) / 86_400_000);
  if (days < 0) return 1;
  return Math.floor(days / 7) + 1;
}

/**
 * The posture that actually applies.
 *
 * Operator state wins where it is real: 'paused' and 'cooldown' are decisions
 * a human made and nothing here overrides them. Everything else is derived
 * from the ramp clock, because warmup-vs-steady is a fact about how long this
 * seat has been automated and not a preference about it -- a stored 'steady'
 * on a two-week-old seat is a mistake, and honouring it would be the expensive
 * kind.
 */
export function effectivePosture(seat: LinkedInSeat, now: Date): SeatPosture {
  if (seat.posture === 'paused' || seat.posture === 'cooldown') return seat.posture;
  return warmupWeekOf(seat.activatedAt, now) > WARMUP_WEEKS ? 'steady' : 'warmup';
}

/** The effective posture for the workspace's seat, or null when it has none. */
export async function getSeatPosture(
  db: Db,
  workspaceId: string,
  now: Date,
  seatKey: string = OWNER_SEAT_KEY
): Promise<SeatPosture | null> {
  const seat = await getSeat(db, workspaceId, seatKey);
  return seat ? effectivePosture(seat, now) : null;
}
