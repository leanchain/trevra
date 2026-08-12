# Community outreach — operator guide

For whoever is actually running this. No TypeScript required.

Engineering design notes and the reasoning behind each decision live in
[`docs/community-outreach.md`](../../../docs/community-outreach.md). This file is
how you run it.

---

## What it does, in 60 seconds

It searches eight developer communities for people complaining about what their
AI coding agent costs, ranks those threads, writes a reply to the best one, and
**stops** — waiting for you to read it and click approve.

```
scout ──▶ score ──▶ gate ──▶ draft ──▶  YOU  ──▶ post
                                        │
                        nothing happens until you approve
```

It is not a spam cannon. It replies to **one thread per run**, and on most
platforms it can't press the button at all — it hands you the text and the link.

### What it will never do

- Post anything you have not read and approved, byte for byte.
- Post the same reply twice, even if a retry or a crash makes it look unsent.
- Post to Reddit, Hacker News, Lobsters, dev.to, or Stack Overflow — **ever**, by
  design. Those are manual handoffs. See [Manual handoffs](#manual-handoffs).
- Touch LinkedIn at all.

---

## Setup — once, about 20 minutes

Copy `.env.marketing.example` to `.env.marketing` and fill in what you need.
**Nothing is required to start.** With an empty file it still searches Hacker
News, Lobsters, GitHub, dev.to, and Stack Overflow.

### Step 1 — declare your account standing (do this first)

Reddit and Hacker News have age and karma minimums. The gate **fails closed**:
if you don't declare your standing, it assumes you don't have it and blocks.

```bash
OUTREACH_ACCOUNT_PROFILES_JSON={"reddit":{"accountAgeDays":400,"karma":1200},"hackernews":{"accountAgeDays":900,"karma":500}}
```

| Platform | Minimum age | Minimum karma |
|---|---|---|
| Reddit | 30 days | 50 |
| Hacker News | 60 days | 100 |
| Everything else | — | — |

Where to find your numbers:

- **Reddit** — your profile page shows cake day and total karma.
- **Hacker News** — `news.ycombinator.com/user?id=YOURNAME` shows *created* and *karma*.

Be honest here. Overstating it doesn't unlock anything except a ban.

### Step 2 — add credentials for the platforms you want

| Want | Set |
|---|---|
| Reddit **discovery** | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` — all four ([create a "script" app](https://www.reddit.com/prefs/apps)) |
| **Post** GitHub replies | `GITHUB_TOKEN`, scope `public_repo` ([token settings](https://github.com/settings/tokens)) |
| Mastodon discovery **and** posting | `MASTODON_ACCESS_TOKEN`, scopes `read:search write:statuses`; `MASTODON_INSTANCE_URL` if not mastodon.social |
| Faster dev.to / Stack Overflow polling | `DEVTO_API_KEY`, `STACKEXCHANGE_KEY` — optional, rate limits only |

### Step 3 — check it's live

```bash
curl -s localhost:PORT/api/playbooks | jq '.playbooks[] | select(.id=="gtm.community-outreach")'
```

---

## Your first run

```bash
curl -X POST localhost:PORT/api/playbooks/gtm.community-outreach/runs \
  -H 'content-type: application/json' \
  -d '{
    "input": {
      "platforms": ["hackernews", "github"],
      "minScore": 6,
      "product": {
        "name": "Acme",
        "url": "https://github.com/acme/acme",
        "summary": "A local runtime that sits under your existing coding agent.",
        "mechanism": "it replaces grep loops with ranked symbol search, so each lookup returns the exact lines instead of whole files",
        "claims": [
          { "label": "SWE-bench cost", "value": "29.5% lower" },
          { "label": "output tokens", "value": "27.9% fewer" }
        ]
      }
    }
  }'
```

The run stops at `waiting_approval`. Fetch it:

```bash
curl -s localhost:PORT/api/playbook-runs | jq '.runs[] | select(.status=="waiting_approval")'
```

### Every input, explained

| Field | Default | What it does |
|---|---|---|
| `platforms` | all 8 | Which to search. Fewer = faster and fewer API calls. |
| `queries` | per-platform defaults | Override the search terms. Leave it out until you have a reason. |
| `limitPerPlatform` | 25 | Threads pulled per platform. Raise it to build up your ratio budget — see [the 10% rule](#the-10-rule-the-one-that-will-surprise-you). |
| `minScore` | 5 | Relevance floor, 0–10. Below this, nothing is drafted. |
| `product` | **required** | See [the product block](#the-product-block). |
| `account` | from env | Overrides your declared standing for one run. |

---

## Reading the approval

The approval payload carries the reply **and** everything you need to judge it:

| Field | What to look at |
|---|---|
| `body` | The actual comment. This is what posts, exactly. |
| `metadata.threadTitle` / `threadUrl` | **Open the thread.** Always. The scorer has never read the room. |
| `metadata.relevanceScore` | 0–10. Below 6, ask whether this is really worth a reply. |
| `metadata.safetyAllowed` | Must be `true`. If it's `false` the post will be refused anyway. |
| `metadata.safetyChecks` | All seven limits, each pass/fail with a reason. |
| `metadata.critiquePassed` | `false` means the copy reads like marketing — see [below](#why-a-draft-gets-flagged). |
| `metadata.automationMode` | `api-publish` = it posts. Anything else = **you** post it. |
| `metadata.submitUrl` | Where you go to post it by hand. |

**Approve:**

```bash
curl -X POST localhost:PORT/api/playbook-runs/RUN_ID/steps/approve-reply/decision \
  -H 'content-type: application/json' -d '{"decision":"approve"}'
```

**Reject** (use it freely — rejection costs nothing and consumes no cap):

```bash
... -d '{"decision":"reject","comment":"thread is a rant, not a question"}'
```

> You cannot edit the text and approve it. The approval is bound to the exact
> bytes. If the wording is wrong, reject and re-run with a better `product`
> block — that is the knob that changes the copy.

---

## The product block

This is the highest-leverage thing you write, and the only part of the copy that
is really yours. Four fields.

**`mechanism` is the one that matters.** It answers *why*, not *what*. Forums
punish a claim with no mechanism behind it, and this sentence is what gets
woven into the thread-specific opener.

| | |
|---|---|
| ❌ | `"it's 30% cheaper and much faster"` — a claim with nothing under it |
| ✅ | `"it replaces grep loops with ranked symbol search, so each lookup returns the exact lines instead of whole files"` — someone can argue with this, which is why it reads as real |

**`claims`** must be numbers you can defend if someone clicks through. Label and
value, up to eight; the first three are used. If you don't have real numbers,
send an empty array — a reply with no numbers beats a reply with soft ones.

**`summary`** — one line on what the thing is.
**`url`** — where it goes. It is always appended; you don't add it yourself.

### How the angle gets picked

You don't choose it; the thread does.

| Thread | Angle | Shape |
|---|---|---|
| >20 points or >10 comments | `technical_deepdive` | Mechanism + numbers |
| >5 points | `cost_comparison` | Direct answer + numbers |
| Mentions "alternative" / "instead of" | `alternative_suggestion` | Framed as the option you landed on |
| Everything else | `minimal_mention` | One line |

A long technical comment on a two-upvote thread reads as a plant. That's why
quiet threads get one line.

---

## Why a draft gets flagged

Every draft goes through an anti-slop critic before you see it. If
`critiquePassed` is `false`, `metadata.critiqueFindings` says why.

The check that catches the most is the **substitution test**: swap the thread for
another one — if a sentence still reads fine, it carried no information about
*this* thread, and it's filler. Every sentence has to name something real: the
thread's own words, your product name, a number.

Other tells it blocks: `hope this finds you well`, `I came across`, `just wanted
to`, `game-changer`, `synergy`, `circle back`, and a ~90-word ceiling. Real
notes between engineers are short.

**A flagged draft is not automatically bad** — you can still approve it. But read
it twice. Usually the fix is a sharper `mechanism`.

---

## The limits

Seven checks run on every thread, and **all seven always run** — you see every
problem at once, not one per run.

| Check | Rule |
|---|---|
| Blacklisted community | r/AskReddit, r/TIFU, r/AmItheAsshole |
| Blacklisted keyword | Thread text contains `spam`, `scam`, or `bot` |
| Daily cap | Per platform, rolling 24h — see table below |
| Account age | Reddit 30d, HN 60d |
| Account karma | Reddit 50, HN 100 |
| Community cooldown | 48h between posts in the same subreddit / repo / tag |
| Self-promotion ratio | Max 10% of threads you've discovered there |

**Daily caps:** GitHub 10 · dev.to 10 · Mastodon 10 · Reddit 5 · Lobsters 5 ·
Stack Overflow 5 · Hacker News 3.

Rolling 24 hours, not a calendar day — you can't reset the counter by waiting
for midnight.

### The 10% rule (the one that will surprise you)

You may have replied in at most **10% of the threads you have discovered** in a
community. To post one reply in `r/webdev`, you need **10 discovered `r/webdev`
threads** on record.

Practically: **run scouting broadly and often before you expect to post.** Narrow
queries and small `limitPerPlatform` values throttle you, because the denominator
only grows from threads you actually found. Rejected drafts don't count against
you; only posts and handoffs do.

> **Gotcha:** the keyword blacklist matches `bot` as a substring of the thread
> text. A thread titled *"my coding bot is burning $400/mo"* — a perfect target —
> gets blocked. That's a deliberately blunt instrument. If it's costing you good
> threads, that list is in `config.ts` and changing it is a code change.

All limits live in `src/server/outreach/config.ts`. They are code, not settings —
changing them is a pull request, on purpose.

---

## Manual handoffs

This is most of the daily work, and it is not a limitation to route around.

Only **GitHub** and **Mastodon** can be posted to programmatically. Everywhere
else, an approved reply is logged as a `manual_handoff` and you post it yourself
from your own account.

| Platform | Why |
|---|---|
| Reddit | Its API *can* post. Sitewide self-promo rules make unattended posting a shadowban risk, and a human has to judge whether the subreddit welcomes it. |
| Hacker News | No write API exists. |
| Lobsters | No write API exists. |
| dev.to | Publishes *your* articles; has no comment endpoint at all. |
| Stack Overflow | The write API doesn't cover answers. |
| LinkedIn | UA §8.2 forbids automated access. Disabled outright. |

**A handoff still consumes your daily cap and starts the 48h cooldown** — you
posting it costs the community exactly as much attention as a machine would.

Your workflow: approve → open `metadata.submitUrl` → paste `body` → post.

---

## Troubleshooting

| What you see | What it means | Do this |
|---|---|---|
| Run fails at `guard`, `thread: Required` | Nothing was found, or nothing cleared `minScore` | Normal on a quiet day. Lower `minScore`, widen `platforms`, or wait. |
| Run fails at `guard` with `Outreach blocked` | A limit said no | Read the failing checks in the error — it names all of them. |
| `Daily cap reached` when posting | You hit the cap between approving and posting | Wait for the window. The approval stays valid; re-run the action. |
| `Cooldown active` | You posted in that community <48h ago | Wait, or target a different community. |
| `does not carry a passing safety verdict` | Someone tried to post a blocked reply | Working as intended. Don't route around it. |
| **`is unresolved … settle post X by hand`** | A post's outcome is unknown — it may or may not be live | **Open the thread and look.** See below. |
| `needs-credential` in warnings | That platform has no token | Check `.env.marketing`. Others still ran. |
| `disabled by policy` | LinkedIn | Not fixable. Intentional. |

### When a post is "unresolved"

If the network dropped mid-post, we genuinely don't know whether your comment is
live. Rather than guess, it **holds** the record and refuses to retry — because a
duplicate reply cannot be unposted and is exactly what gets an account banned.

1. Open the thread and look for your comment.
2. If it's there: mark it posted.
   ```sql
   UPDATE outreach_posts SET status='posted', external_ref='<link>' WHERE id='<post id from the error>';
   ```
3. If it isn't: release it so it can be retried.
   ```sql
   UPDATE outreach_posts SET status='failed' WHERE id='<post id>';
   ```

---

## Checking your state

**What have I posted lately?**

```sql
SELECT created_at, platform, community, status, thread_url
FROM outreach_posts WHERE workspace_id = 'YOUR_WS'
ORDER BY created_at DESC LIMIT 20;
```

**Which communities am I on cooldown for?**

```sql
SELECT platform, community, MAX(created_at) AS last_post,
       ROUND(EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))/3600) AS hours_ago
FROM outreach_posts
WHERE workspace_id = 'YOUR_WS' AND status <> 'failed' AND community IS NOT NULL
GROUP BY platform, community
HAVING MAX(created_at) > NOW() - INTERVAL '48 hours';
```

**How much ratio headroom do I have?**

```sql
SELECT t.platform, t.community,
       COUNT(DISTINCT t.external_id) AS discovered,
       COUNT(DISTINCT p.id) AS posted,
       ROUND(COUNT(DISTINCT t.external_id) * 0.1) AS budget
FROM outreach_threads t
LEFT JOIN outreach_posts p
  ON p.workspace_id = t.workspace_id AND p.platform = t.platform
  AND LOWER(p.community) = LOWER(t.community) AND p.status <> 'failed'
WHERE t.workspace_id = 'YOUR_WS' AND t.community IS NOT NULL
GROUP BY t.platform, t.community ORDER BY discovered DESC;
```

**Used today, per platform:**

```sql
SELECT platform, COUNT(*) AS used_24h FROM outreach_posts
WHERE workspace_id = 'YOUR_WS' AND status <> 'failed'
  AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY platform;
```

---

## What actually gets you banned

The limits exist because of these. Don't engineer around them.

1. **Replying to threads you didn't read.** The scorer matches keywords. It cannot
   tell a genuine question from a rant, a joke, or a competitor's launch thread.
   Open every link.
2. **Posting in the same subreddit repeatedly.** That's the cooldown and the 10%
   ratio. Both exist because it's the single fastest route to a shadowban.
3. **A new account with a link.** That's the age and karma floor. Build standing
   first — comment as a human for a month.
4. **The same comment in several threads.** Each reply is drafted for its thread.
   Don't copy a handoff into a second thread.
5. **Automating Reddit anyway.** Its API can post. That is not permission.

A useful test before approving: *if a moderator read only this comment, with no
context, would it look like someone helping or someone advertising?* If you
hesitate, reject it.

---

## Getting more out of it

- **Scout wider than you post.** Run discovery daily across all platforms with a
  high `limitPerPlatform`; approve selectively. This builds ratio headroom.
- **Raise `minScore` before lowering it.** At 7+ you get fewer, better threads.
  Volume is not the win here.
- **GitHub is the best starting platform.** No account minimums, a 10/day cap, and
  it's the only one where an approved reply posts itself.
- **Tune `mechanism` first.** Nearly every weak draft traces back to a vague one.
- **Rejecting is free.** It consumes no cap and starts no cooldown. Be picky.
