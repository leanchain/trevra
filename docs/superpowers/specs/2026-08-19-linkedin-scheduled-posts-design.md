# LinkedIn scheduled posts

Date: 2026-08-19
Scope: a new capability to compose LinkedIn feed posts with LinkedIn-native rich formatting, schedule them (explicit date/time or a recurring cadence queue), and have the existing companion-browser automation publish them unattended. New surface area only — does not touch the existing outreach campaign/sequence system (`LinkedInCampaigns.tsx`, `campaigns.ts`, `runner.ts`), which targets leads via invite/DM/follow/view and stays untouched.

## Why this is separate from campaigns, not an extension of them

Everything LinkedIn-automation-shaped in this codebase today (`driver.ts`, `driver-engage.ts`, `runner.ts`, `guard.ts`, `pacing.ts`) is built around one shape: a sequence of actions **against a lead**, paced to look human and staying under safety ceilings because outreach volume is what gets accounts restricted. Posting to your own feed is a different shape entirely — there's no lead, no per-target safety ledger, and steady/predictable cadence is normal creator behavior rather than a ban signal. Reusing the campaign/sequence engine would mean bending a lead-shaped system around a fundamentally different action. New tables, a new driver file, and a new worker job — sized correctly for what this action actually is — are simpler than force-fitting it into the existing one.

## Content model

A post body is stored as **structured runs**, not pre-rendered Unicode:

```ts
type PostRun =
  | { type: 'text'; text: string; bold?: boolean; italic?: boolean; underline?: boolean }
  | { type: 'mention'; displayText: string; entityKind: 'person' | 'page'; resolvedUrn?: string }
  | { type: 'break' }; // explicit line break

type PostBlock = { runs: PostRun[]; list?: 'bullet' | 'numbered' }; // one per line/paragraph
```

Storing runs (not final text) is required, not a nicety: once `bold` text is converted to `𝗯𝗼𝗹𝗱` Unicode there is no reliable inverse mapping back to "this span was bold" (needed to re-highlight the toolbar button when the cursor re-enters that span, and to let the user turn bold back off). Conversion to the LinkedIn-ready string happens at two points only: the live preview pane, and the driver call at publish time. Both call the same pure `renderPostBody(blocks: PostBlock[]): string` function (new module, `src/shared/linkedin-post-format.ts`, usable from client and server) — one implementation, no drift between what you previewed and what got posted.

### Unicode formatting (`renderPostBody`)

LinkedIn's composer is a plain contenteditable div with no real bold/italic/list support — every "formatted" LinkedIn post you've ever seen is plain Unicode characters that happen to render bold/italic in any font. Mapping (Mathematical Alphanumeric Symbols block, sans-serif variant — matches LinkedIn's UI typeface better than the serif variant most generators default to):

| Style       | Range (A-Z / a-z)                            | Digits                                      |
| ----------- | -------------------------------------------- | ------------------------------------------- |
| bold        | U+1D5D4–U+1D5ED / U+1D5EE–U+1D607            | U+1D7EC–U+1D7F5 (sans bold)                 |
| italic      | U+1D608–U+1D621 / U+1D622–U+1D63B            | (no italic digits — pass through)           |
| bold+italic | U+1D63C–U+1D655 / U+1D656–U+1D66F            | U+1D7EC–U+1D7F5 (falls back to bold digits) |
| underline   | append combining U+0332 after each character | —                                           |

Rules:

- Only `A–Za–z0–9` map; everything else (spaces, punctuation, emoji, non-Latin scripts) passes through unstyled even inside a styled run — silently, no error.
- Must iterate by Unicode **code point** (`[...text]` / `Array.from`), never by UTF-16 code unit — every target character is in the astral plane (surrogate pair). Indexing by `.length`/`[i]` will corrupt output.
- `bold+underline`/`italic+underline`/`bold+italic+underline` compose: pick the bold/italic glyph, then append the combining underline mark after it.
- Underline on non-ASCII runs (emoji, accented/non-Latin text) is allowed but the composer shows a small inline warning — combining marks are known to render inconsistently there.
- Accessibility note shown once (dismissible), not a blocker: stylized Unicode text is read character-by-character or skipped by screen readers.

### Lists

No real list markup exists to use. The toolbar's bullet/numbered buttons just manage line prefixes as plain text (`• ` per bulleted block; `1. `, `2. `, … recomputed per numbered block on reorder/delete) — modeled as the `list` field on `PostBlock`, rendered by `renderPostBody` joining blocks with real `\n`.

### Hashtags & links

No special run type — plain text. LinkedIn auto-linkifies `#word` (letters/digits/underscore only, no internal spaces) and `https://…` URLs client-side once posted; nothing to encode ahead of time. The composer validates hashtags as you type (space inside a `#tag` just means the `#` wasn't a hashtag) but does not hard-cap count. A **"link goes in a comment, not the post"** toggle is offered next to any URL detected in the body: LinkedIn's feed algorithm is widely observed to suppress reach on posts with outbound links in the body, so many creators post the link as the first comment instead. When on, the URL is stripped from the body at publish time and the driver posts the top comment immediately after the post succeeds.

### Mentions

A real LinkedIn mention is a resolved entity link + notification to that person/page — **typing `@Jane Doe` as plain text does not create one.** LinkedIn only creates it when you pick a suggestion from its live autocomplete dropdown while composing. Consequences for automation:

- **Resolve-on-add**: when the user inserts a mention run in the composer, the server drives the paired companion browser to open LinkedIn's mention typeahead (feed compose box, type `@` + query, read the suggestion list, close without posting) and returns candidates. The UI shows "✅ matched — Jane Doe, VP Sales @ Acme" or "⚠️ no match — will post as plain text" inline, so surprises surface at compose time, not 2am when the post fires.
- **Re-resolve at publish**: the cached match from compose time is _not_ trusted at publish time (days may have passed; connections/pages change) — the driver repeats the same typeahead-and-pick flow live, mid-insert, as part of publishing.
- **Degrade, don't block**: if publish-time resolution fails, the run posts as plain display text (no link, no notification) and the post still goes out; the post's history records `mention_unresolved` for that run rather than failing the whole scheduled post.
- Mention typeahead scope is a LinkedIn limitation, not this app's: it mostly surfaces 1st-degree connections and pages, not arbitrary members. Composer copy sets this expectation ("works best for people you're connected to, and pages").

### Media

v1 supports **image attachments only**, up to LinkedIn's real per-post cap of 9. Documents and video are explicitly deferred (different upload/processing/preview flow in LinkedIn's UI, not a small delta on top of images) — see Explicitly out of scope.

## Scheduling

Two ways to place a post on the calendar, usable interchangeably per post:

1. **Explicit date + time** — picked directly, in the seat's existing timezone (`linkedin_seats.timezone`, already present).
2. **Cadence queue** — a per-seat recurring slot template (`{weekday, minuteOfDay}[]`, e.g. Mon/Wed/Fri 09:00) plus a `sequence_position` integer. Posts added without an explicit time take the next open slot ≥ now, in `sequence_position` order, skipping slots already spoken for by another post (cadence-assigned or explicit) on that seat. Same "find the next open instant" shape as `runner.ts`'s `nextOpenInstant`/`scheduleSlot`, deliberately **not shared code** with it — that function's whole job is human-mimicry jitter for anti-detection pacing, which is actively wrong here (consistent posting times are desirable, not a tell). New, much simpler slot-fill function local to posts.
3. Dragging a queued (cadence-slot) post re-numbers `sequence_position` for the affected range; explicit-dated posts sit outside the queue entirely and don't reflow when the queue changes.

**Missed posts**: the worker publishes a due post slightly late if it was briefly down (companion offline, deploy, etc.) — within a **6 hour grace window** from `scheduled_at`. Past that window, status becomes `missed` (not published, not silently retried) since firing something stale and out of context ("Happy Monday" on Wednesday) is worse than not firing it; the user reschedules or discards from the UI.

## Driver automation — `src/server/linkedin/driver-post.ts`

Mirrors the existing `driver-engage.ts` shape (same `LinkedInDriverResult`/`LinkedInFailureKind` types from `driver.ts`, same `hoverClick`/`settle` human-pacing helpers from `human.ts` for clicks/waits — but **not** `typeLike` for the body):

1. Navigate to feed, open "Start a post".
2. Insert the rendered body via a single bulk insert (Playwright keyboard `insertText`—equivalent), not character-by-character `typeLike` — a 3000-character post typed with human-jitter delay would take minutes per post and provides no anti-detection benefit for content the account owner is intentionally publishing. `typeLike` stays reserved for short outreach fields (invite notes, DMs) where it already is.
3. For each mention run encountered while inserting: pause the bulk insert at that point, type `@` + query, wait for the suggestion list, fuzzy-match the target, click it (or fall through to plain-text + `mention_unresolved` per above), resume inserting the remaining runs.
4. If images are attached: click "Add media", set the hidden file input to the fetched attachment(s), wait for LinkedIn's upload/processing state per image before continuing.
5. If a URL is present and "link in comment" is off: leave LinkedIn's auto-generated preview card as-is (default — most authentic-looking post). If on: the URL was already stripped from the body in step 2, so there's no card to handle.
6. Click Post, wait for the composer to close / the post to appear, and best-effort capture the resulting activity URL from the DOM for the history view (not required for success — posting succeeds even if the URL can't be scraped).
7. If "link in comment" was on: immediately post the stripped URL as the first comment on the just-published post.

New failure kinds added to the existing `LinkedInFailureKind` union: `compose_unavailable`, `media_upload_failed`. (`mention_unresolved` is recorded per-run in post history, not returned as a whole-action failure — see Mentions above. `selector_drift`, `challenge`, `unknown` are reused as-is.)

## Worker integration

`src/worker/index.ts`'s existing `linkedinCycle` gains a sibling tick, `runLinkedInPostTick` (new function in `src/server/linkedin/jobs.ts`, same file/pattern as `runLinkedInCampaignTick`): per workspace, find seats with a `linkedin_posts` row `status = 'scheduled'` and `scheduled_at <= now`, oldest first, capped per tick like the existing `CAMPAIGN_WORKSPACES_PER_TICK`/`SIDE_TASK_SEATS_PER_TICK` constants. Uses the same DB-lease pattern as `runner.ts`'s `RUNNER_LEASE_NAMESPACE` so multiple worker replicas never double-publish the same post.

## Safety

- **Companion required**: publishing requires the same active paired companion session other automated actions already require (`companionWorkspaceReady`). If offline at publish time, the post is held (not failed) and retried on the next tick, same as a missed-post catch-up, within the 6-hour grace window.
- **Soft daily cap**: a new, much smaller guard than `guard.ts`'s full rolling-window machinery (that machinery exists because _outreach volume_ directly risks the account; a handful of posts a day does not, to nearly the same degree). Default: **warn, don't block**, if a seat already has a post scheduled the same local day — shown in the composer at schedule time ("you already have a post queued for {time} that day—post anyway?"), not enforced by the worker. Configurable per seat, same place seat-level settings already live (`LinkedInAccounts.tsx`).

## Data model (new migration, `083_linkedin_posts.sql`)

```sql
linkedin_posts (
  id, workspace_id, seat_key,
  status text check in ('draft','scheduled','publishing','posted','failed','missed','canceled'),
  blocks jsonb,               -- PostBlock[]
  media jsonb,                 -- attachment refs, ordered, ≤ 9
  link_in_comment boolean,
  scheduled_at timestamptz null,      -- explicit scheduling
  sequence_position integer null,     -- cadence-queue scheduling (mutually exclusive-ish with scheduled_at: explicit wins if both set)
  published_at timestamptz null,
  posted_url text null,
  error jsonb null,             -- {kind, detail} on failed/missed
  mention_warnings jsonb null,  -- per-run resolution outcomes, for history display
  created_by, created_at, updated_at
)

linkedin_post_cadences (
  workspace_id, seat_key, slots jsonb,  -- [{weekday, minuteOfDay}]
  primary key (workspace_id, seat_key)
)
```

## API surface (new routes in `src/server/app.ts`, mirroring existing LinkedIn route conventions)

- `GET/POST /linkedin/posts` — list (filterable by seat/status), create (draft or scheduled).
- `PATCH/DELETE /linkedin/posts/:id` — edit (only while `draft`/`scheduled`), cancel.
- `POST /linkedin/posts/:id/publish-now` — manual immediate publish (milestone 1, bypasses scheduling entirely).
- `POST /linkedin/posts/reorder` — batch `sequence_position` update for the cadence queue.
- `GET/PUT /linkedin/post-cadences/:seatKey` — cadence slot template.
- `POST /linkedin/mentions/resolve` — compose-time resolve-on-add (drives the companion browser's typeahead, returns candidates).

## UI

New `LinkedInPosts.tsx` tab alongside Campaigns/Leads/Accounts/Analytics/Safety in `LinkedInScreen.tsx`'s nav.

- **Composer**: contenteditable body with a formatting toolbar (Bold/Italic/Underline/Bullet/Numbered/Mention/Emoji picker/Image attach), operating on the `PostBlock[]` model directly (selection → toggle style on the runs under it — the same shape any basic rich-text toolbar uses, just targeting this app's own small model instead of a library). Live preview pane styled like an actual LinkedIn post card (avatar/name placeholder, rendered body via `renderPostBody`, and LinkedIn's real ~3-line "…see more" truncation) so what you see is what ships. Character counter against LinkedIn's 3000 cap. Account (seat) picker. Schedule control: explicit date/time picker, or "add to queue" (cadence slot).
- **Queue/calendar list**: upcoming posts ordered by effective time, drag-reorder for cadence-slot posts (explicit-dated posts shown but not draggable among them), status badges, edit/cancel/duplicate.
- **Cadence settings**: per-seat slot editor (weekday + time chips), reusing the existing timezone display pattern from `LinkedInAccounts.tsx`.
- **History**: posted items link out to `posted_url` when captured; failed/missed show the recorded reason; mention warnings shown inline on the specific post.

## Explicitly out of scope (v1)

- Documents and video attachments — images only.
- Company Page posting (posting _as_ a Page rather than the seat's personal profile) — personal profile only.
- Analytics on published posts (impressions/reactions/comments) — `posted_url` is captured for manual follow-up; pulling engagement metrics back in is a separate feature.
- Any reuse of `pacing.ts`'s anti-detection jitter for post timing — deliberately not applicable here (see Scheduling).
- Editing a post after it enters `publishing` status (mid-flight) — only `draft`/`scheduled` are editable.

## Testing

- `linkedin-post-format.test.ts`: every style combination (bold/italic/underline, singly and composed) round-trips through known Unicode fixtures; non-A-Za-z0-9 characters pass through unstyled inside a styled run; surrogate-pair iteration doesn't corrupt multi-run bodies; list blocks number/bullet correctly across insert/delete/reorder; hashtag validation rejects internal spaces without mutating the run.
- `driver-post.test.ts` (same fixture-driven style as `driver-engage.test.ts`): mention resolve-and-click, mention-not-found degrades to plain text without failing the action, media upload wait, link-in-comment strips body URL and posts the follow-up comment, each new failure kind triggers on its corresponding DOM state.
- `jobs.test.ts` / worker-tick test: due post publishes once even with concurrent tick invocations (lease correctness); a post past the 6h grace window is marked `missed`, not published; a post is held (not failed) while the companion is offline and retried within the grace window.
- API tests: reorder only touches `sequence_position` for cadence-queued posts; explicit `scheduled_at` and `sequence_position` are mutually exclusive on write; edit/cancel rejected once `publishing`/`posted`.
