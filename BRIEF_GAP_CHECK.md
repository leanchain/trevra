# Dripify brief vs Trevra — verified against code, 2026-08-14

Four read-only audits over the actual source (not `DRIPIFY_PARITY.md`). Each row cites where.

## HAVE — built and wired end to end

| Brief item | Where |
|---|---|
| Connect LinkedIn account (creds → login → OTP → challenge) | `app.ts:2176/2254`, `local-worker.ts:3542`, `LinkedInAccounts.tsx:794` |
| Anti-block: per-seat fingerprint, own profile dir, proxy, checkpoint→cooldown | `local-worker.ts:2669/3288/2847/1512` |
| Randomize + space invites / views / messages | `limits.ts:240` (30–120s gap), `pacing.ts:324`, `runner.ts:228`, `human.ts` |
| Working days + hours, no activity outside | `pacing.ts:198/222`, `guard.ts:707/719`, `LinkedInAccounts.tsx:1374` |
| Daily caps 30/25/25/20 with ranges 0–75 / 0–75 / 0–100 / 0–50 | `migrations/045:18-34`, `app.ts:5110`, `guard.ts:628` |
| Campaign warm-up 20/40/60/80/100% | `managed-campaigns.ts:128`, enforced in gate + planner |
| Lead in only 1 campaign | partial unique index `migrations/046:77` |
| All 6 workflow actions: invite ±note, withdraw after X days, profile view, message, manual message (halts), follow | `workflows.ts:70-75`, `runner.ts`, `driver*.ts` |
| A/B message test | `chooseMessageVariant`, sticky per member |
| Delay in hours or days between every step | `workflows.ts:53` (cap 2160h) |
| Merge vars first/last/company (+ email, phone, country) | `workflows.ts:23`, validated at save |
| Campaign = list + workflow + name; start/stop/pause/resume | `managed-campaigns.ts:160/340/390/402` |
| Inbox: receive + reply in-tool; manual tasks appear there | `jobs.ts:190`, `driver-inbox.ts:839`, `LinkedInInbox.tsx:491/684` |
| Remove lead / pause / continue a lead | `managed-campaigns.ts:527/417` |
| Import from basic search URL, Sales Navigator URL, CSV | `driver-scrape.ts:913/941`, `lead-lists.ts:234` |
| Field automatch (7 fields) + manual override mapper | `lead-import.ts:41-68`, `LinkedInManagerLeadConfig.tsx:509` |
| Scrubber — **all spec tokens present** (32 unique; brief lists `ms` twice), emoji + `.,?!`, case-insensitive whole-token | `lead-import.ts:52-135` |
| Analytics: invites sent, messages sent, profile views, replies + reply % | `managed-campaigns.ts:672-678` |
| Multiple accounts: add, per-seat creds (AES-GCM), per-seat profile/lease/proxy | `app.ts:3074`, `secrets/linkedin.ts:152` |
| Nice-to-have: leads from posts/comments by keyword, with post URL + interaction type + daily cap (0–1000) | `driver-scrape.ts:1344`, `leads.ts:467/962` |

## Closed on 2026-08-14 (verified: `npx tsc --noEmit` clean; `npx tsx scripts/test-with-postgres.ts` → 97 files, 2146 tests passed)

1. **Hosted execution built** — browser-provider abstraction (`src/server/browser/provider.ts:412`), remote CDP attach, per-seat `storageState` sealed AES-256-GCM (`session-state.ts`, `migrations/065`), refuses to run a seat with no proxy, per-workspace consent gate, server-side runner in `worker/index.ts:105`. Local worker still supported and unchanged.
2. **Caps trade-off is loud, not silent** — both numbers at the point of decision ("you set 30 · 18 will go out"), one-click `safety_band_override`; researched band still binds by default.
3. **Acceptance now detected automatically** — degree badge read on the profile (`driver.ts:695/719`), candidates from the pending-invite diff (`withdraw.ts:1347/1486`), budgeted as a profile view, unknown never coerced to accepted, human mark always wins (`campaigns.ts:109/755`); reply-on-pending-invite is also evidence (`inbox.ts:744`).
4. **Switcher re-scopes the product** — queue, campaigns (list + create), analytics, limits, inbox all filter server-side; shared `ActiveAccountBar`.
5. **Analytics window is real** — 7/30/90/all, "all" means all; copy generated from what was queried.
6. **A/B up to 4 arms** — weights renormalise, seeded assignment stable, stored 1-/2-arm workflows unchanged.
7. **Reply % can no longer exceed 100** — numerator is a strict subset of the denominator; every rate under 10 samples renders "not enough data".
8. **Proxy has DB + UI** per seat; env stays as fallback; password never serialised back.
9. **Lead sourcing default-on** for self-hosted; hosted refusal untouched.
10. **Legacy CSV scrubbed** — `app.ts:6399`; `Dr. Maya 🙂` → `Maya`, `Do` survives.
11. **Withdraw + manual message file ledger rows**, so both are budgeted and counted. **InMail retired explicitly** (`actions.ts:85`) — removed from builder, branches and message counters rather than reported as sendable.

## Still open

- Hosted execution is verified against fakes only — no real cloud-browser key, no real LinkedIn login. Needs a staging burn-in on a throwaway account before it carries a customer's.
- Two campaign surfaces still coexist (`/outreach/manager` vs legacy `/outreach/campaigns`).
- `secrets/custody.ts` does not re-seal stored sessions on key rotation (`lc-debt`) — a rotation costs every seat one re-login.
- Degree-badge selector and its non-English renderings are unproven against live markup (they route to "unknown", so they under-report rather than lie).
- "Who viewed my profile" is not built — out of brief scope (the brief's "profile views" means views you perform, which works).

## Original gap list (for the record)

## DON'T HAVE / not what the brief implies

1. **Nothing sends from the cloud.** Every real action needs the operator running `npm run linkedin:worker` on their own machine; hosted mode refuses credentials and login outright (`config.ts:113`, `app.ts:1932/2189`). Dripify is fully hosted. This is the single biggest gap.
2. **The brief's numbers are not what binds.** Trevra's researched bands (18 invites, 12 DMs) `min()` the operator's setting — set 30, get 18 — unless `safety_band_override` is turned on per account (`limits.ts:413`, `migrations/050`).
3. **Invites accepted / acceptance % is manual-entry only.** No automation ever marks an invite accepted; `writeActionStatus` refuses `accepted` from any non-human caller (`campaigns.ts:529`), and `jobs.ts:352` explicitly declines to infer it. The counter reads 0 until someone clicks. Three different denominators exist across screens.
4. **Account switching does not re-scope the product.** Honoured by Inbox and Safety only; ignored by Analytics (the route's `seatKey` never filters — `app.ts:3040`), Campaigns (falls back to owner — `app.ts:2624`) and the send queue. On-screen copy claims otherwise (`LinkedInAccounts.tsx:566`).
5. **Analytics "all time" is actually last 7 days** — screen says "every action ever filed", request sends `UNUSED_WINDOW = 7` and all three queries window on it (`LinkedInAnalyticsScreen.tsx:31/97`, `campaigns.ts:941`). Bug.
6. **A/B is capped at 2 variants** (`.max(2)`).
7. **Reply % can exceed 100%** — numerator counts replies to any action kind, denominator only messaged targets (`managed-campaigns.ts:704`).
8. **Proxy is env-var only** (`TREVRA_LINKEDIN_PROXY*`) — no DB column, no UI.
9. **Lead sourcing is off by default** (`TREVRA_LINKEDIN_LEAD_SOURCING=true`) and hard-off hosted.
10. **Two campaign surfaces coexist.** `/outreach/manager` is the Dripify-shaped one; legacy `/outreach/campaigns` uses no workflows, has no lead-list selector, and its CSV path bypasses the scrubber entirely (`app.ts:6108`) — `"Dr. Maya 🙂"` reaches an export as `first_name`.
11. **InMail counts in analytics but has no driver** (`local-worker.ts:112`); `manual_message` and `withdraw_pending` write no ledger row, so they are invisible to limits (`local-worker.ts:1177`).
12. **"Who viewed my profile"** — not built (outbound views only).
