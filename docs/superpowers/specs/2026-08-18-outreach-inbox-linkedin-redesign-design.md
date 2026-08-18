# LinkedIn-native redesign of /outreach/inbox

Date: 2026-08-18
Status: approved, pending implementation plan

## Problem

`OutreachInbox` (`src/client/LinkedInInbox.tsx`, styled by the `.li-*` rules
in `src/client/styles.css`) is functionally complete but visually reads as a
generic two-panel dashboard: flat text rows for conversations, no avatars, a
select-heavy filter row, and a composer that is just a form stacked under the
message list. Pankaj wants it to look and feel like LinkedIn's own messaging
UI — the product it is literally a client for — without touching any of the
behavior the file's own header comment calls out as non-negotiable (queued-
not-sent, task vs. conversation as two different acts, 409s rendered
verbatim, screen shows only what the last sync stored).

This is a presentation-layer redesign of one screen. No API, no server
logic, no data model changes.

## Goals

- Thread list, conversation header, message bubbles and composer read like a
  native LinkedIn messaging pane: avatar-led rows, grouped bubbles with date
  dividers, a search box, a sticky composer bar.
- Every existing behavior is preserved exactly: filters (unread/has-reply/
  campaign/account), pagination ("Show older conversations"), sync buttons,
  task completion, reply queue/edit/cancel, refusal/queued/send-state
  semantics, `ConfidenceTag`, truncation copy, the responsive single-column
  collapse.
- Stays inside Trevra's existing design system (`--t-*` tokens in
  `styles.css`) — no new colors, no webfont, no new dependency.

## Non-goals

- No literal LinkedIn branding. Outgoing bubbles / active states keep
  Trevra's green (`--t-green-600` family), not LinkedIn's blue
  (`#0A66C2`) — explicit choice, see Decisions.
- No real profile photos. None exist in Trevra's data; avatars are
  initials-in-a-circle, the same pattern `.client-avatar` /
  `.workspace-avatar` already use elsewhere in the app.
- No change to any route, hook, or the shape of any state that drives a
  network call. The only new client state is a local, non-persisted search
  string.
- No typing indicators, read receipts, reactions, or other LinkedIn features
  Trevra has no data for.

## Decisions made during brainstorming

1. **Scope**: full inbox-shell rework, not a light restyle — thread rows,
   header, bubbles, and composer chrome are all in scope.
2. **Accent color**: keep Trevra green throughout; do not adopt LinkedIn
   blue anywhere on this screen.
3. **Avatars**: initials circles, deterministically tinted per person (same
   person → same tint across a session), not skipped.
4. **Search**: add a LinkedIn-style search input above the thread list,
   filtering the already-loaded threads/tasks client-side by name/snippet/
   suggested body. Additive — the existing Unread / Has-a-reply / Campaign /
   Account pill filters are unchanged and untouched.
5. **Tasks vs. conversations**: campaign "messages to write" fold into the
   *same* scrollable list as real conversations (one unified, recency-sorted
   list), rather than staying in their own boxed-off section above it. This
   is the one place this design pushes against the file's own documented
   invariant — "a task is drawn as a to-do, never as a received message" —
   and it is a deliberate, explicit choice, not an oversight. It is preserved
   by construction, not just by convention: see "Task rows" below.

## Architecture

Two files change. No new files, no new dependencies.

- `src/client/LinkedInInbox.tsx` — JSX restructuring inside `OutreachInbox`'s
  render, plus a handful of small pure helper functions colocated near the
  existing `messageTime`/`profileKey`/`replyStage` helpers. Every existing
  handler (`loadThreads`, `queueReply`, `completeTask`, `syncRail`, etc.) is
  untouched. One new local UI state: `const [search, setSearch] = useState('')`.
- `src/client/styles.css` — the `.li-inbox`, `.li-thread*`, `.li-convo*`,
  `.li-msg*`, `.li-composer*` rule groups (roughly L1580–L1635) are rewritten;
  shared primitives (`--t-*` tokens, `.primary-button`, `.secondary-button`,
  `.panel-footer`, `.li-chip`/`.li-status-*`, `.li-range`) are reused as-is,
  not duplicated. Unrelated `.li-*` rules elsewhere in the file (viz, tables,
  degraded/blocked banners, gate-refusal/queued panels) are untouched.

### 1. Thread list (left rail)

- A search input (`Search` icon from `lucide-react`, already a dependency)
  sits above the pill filter row. It filters the in-memory `threads` and
  `visibleTasks` arrays by name / snippet / suggested-body substring, case-
  insensitive. It never triggers a network call and never changes what the
  empty-state or truncation copy says about what the *server* returned —
  those still describe the unfiltered server read.
- Tasks and conversations render as one combined, recency-sorted `<ul>`
  (task `createdAt` vs. thread `lastMessageAt`, descending), each row using
  the same avatar-led row shape.
- **A task row can never be mistaken for a received message, by
  construction**: it never renders `li-unread-dot` (that dot is driven
  exclusively by `thread.unread`, which a task literally does not have), it
  always carries the existing `To write` badge (`li-status-planned` chip, the
  same one already used elsewhere) in the slot a conversation uses for its
  "replied"/"campaign" chips, and its snippet line is sourced from
  `suggestedBody` with the existing "No draft was written…" fallback —
  never from message text, because there is none. The `unread`/`hasReply`
  server-side filters already only ever apply to `threads`; that is
  unchanged, so a task can never satisfy "Unread" either.
- Every row (task or thread) gets a leading avatar: a circle with the
  person's first initial, background tint chosen deterministically from a
  small hash of their name/profileUrl over a fixed small set of existing
  token-driven tints (same idea as `.client-avatar`, just keyed instead of
  singular).
- Row layout keeps its current three-line shape (name+time / snippet /
  meta chips) — this is a restyle of `li-thread-top/snippet/meta`, not a
  rebuild — but tightens spacing and adds the avatar gutter.
- The open row keeps its green tint and gains a left accent bar (2–3px,
  `--t-green-600`), the way native message UIs mark the active thread.

### 2. Conversation / task pane header

- Same initials-circle avatar next to the name/title. "View profile ↗"
  keeps using the existing `li-seat-vanity` link, restyled smaller/under the
  name to match a compact LinkedIn-style header. All existing header copy
  (sync button, "Last synced…", a task's "reached a step it will not do on
  its own…") is unchanged content, just laid out around the avatar.

### 3. Message thread

- Bubble direction logic (`li-msg-in` / `li-msg-out`) is unchanged. Consecutive
  messages from the same direction are grouped: the "Them"/"You" label and
  timestamp render once per group (last message), not once per bubble — a
  pure derived pass over `messages` computed in render, nothing persisted.
- Date dividers ("Today" / "Yesterday" / the date) are inserted between
  groups that cross a calendar day, parsed the same defensive way
  `messageTime` already does — a null/unparseable `sentAt` never invents a
  date or a divider.
- Bubble shape/radius is refined toward the tighter, more rounded LinkedIn
  look; the existing one-flat-corner treatment (`border-bottom-left/right-
  radius`) stays, just tuned.
- The "sent through Trevra by <name>" caption still exists, attached to the
  group's last message rather than duplicated on every bubble in it.

### 4. Composer

- The actual textarea + primary send button becomes a rounded, sticky bar
  pinned to the bottom of the conversation pane (`position: sticky; bottom:
  0`), so it stays visible while the message list scrolls above it —
  matching LinkedIn's fixed compose bar.
- Every existing informational block — refusal banner, queued confirmation
  with its checks `<details>`, the send-state strip with per-message edit/
  cancel controls, the long explanatory `panel-footer` copy — renders exactly
  as it does today, same content, same conditions, same order, positioned
  above the sticky input bar inside the same scrollable composer area.
  Nothing about the safety/queueing copy or controls is trimmed, reworded, or
  hidden; only the outer chrome changes.

## Explicitly unchanged

All data fetching and their loading/error states, all four filters, thread
pagination and its ceiling copy, both sync buttons and their 409 handling,
task completion, reply queue/edit/cancel and their guard copy, the degraded-
sync banner, `ConfidenceTag` placements, and the `<760px` responsive collapse
to a single column (`li-inbox`'s existing breakpoint in `styles.css`).

## Risks / open corners

- Folding tasks into the unified list is the one deliberate departure from
  the file's documented invariant about tasks never reading as received
  messages — addressed structurally (no unread dot ever, permanent "To
  write" badge, unaffected by the unread/hasReply filters) rather than left
  as a styling-only promise.
- The deterministic avatar-tint hash is new, small, and pure (name/profileUrl
  → index into an existing fixed tint set) — no library, no state, no
  network.
