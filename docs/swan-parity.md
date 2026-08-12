# Swan parity — what it would actually take

**Subject:** [getswan.com](https://www.getswan.com) ("AI GTM Engineer"), with
[gojiberry.ai](https://gojiberry.ai) (YC P26) as the same bet at a founder price
point. The field around them is in
[competitive-landscape.md](./competitive-landscape.md).

This document answers one question: *if "full parity with Swan" is the goal, what
is the actual list, and what does each line cost us?* It ends with six decisions
that are not engineering calls — each one contradicts something already written
down in [app-spec.md](./app-spec.md), [system-of-record.md](./system-of-record.md)
or [byok-and-hosted-agent.md](./byok-and-hosted-agent.md).

---

## 1. What Swan actually is

Three founders, ~200 customers in 2025, **$6M** announced Feb 2026 (Link
Ventures; Fresh Fund, Collider, Gandel Invest), zero SDRs, targeting 2,000
customers without adding headcount. Legal trail runs Shalosh Labs LTD (Tel Aviv)
→ Swan AI, Inc. (Delaware).

The pitch is a single sentence: **"Swan is Lovable for GTM."** Describe a
go-to-market process in English; Swan picks tools, configures a trigger, writes
instructions, and deploys an agent in minutes. Explicitly *not* a flowchart
builder — that's the competitor they name.

Six packaged agents, each a named animal, each a revenue moment:

| Agent | Play |
|---|---|
| Doggo | Closed-won → lookalike companies → multichannel campaign |
| Owly | LinkedIn engagement / job change → warm DM or connection request |
| Zebro | Closed-lost → loss-reason + competitor intel → share with team |
| Gatto | Website visitor → deanonymize → ICP-qualify → outreach |
| Craby | Meeting scheduled → research contact + history → brief the rep |
| Penguini | Pipeline health → flag stale deals → notify owners |

Underneath: HubSpot-native CRM writes (create/update contacts and companies,
merge duplicates, set properties, notes, tasks, associations), email + LinkedIn
sequencing, a Slack copilot with approval cards, multi-provider enrichment with
conflict resolution, visitor deanonymization (their own privacy policy calls
Swan "a website deanonymization service"; stated match rates 60–70% company-level,
30–40% person-level), and one credit per action split into Action vs Data credits.
Seats are $20/mo; alert recipients and dashboard viewers are free.

**Gojiberry** is the compressed version: enter your website URL, it reads your
business and builds the ICP, watches 15+ buying and social signals, enriches
through a 15-provider email waterfall, and runs email + social outreach —
**$99/mo**, 1,800 prospects contacted, unified inbox, "full auto or approve
before it sends", and an **MCP server so you drive the whole thing from Claude**.
That last one is the closest thing on the market to Trevra's BYO-agent bet, and
it is a $99 line item on a YC seed company's pricing page.

### What they charge

| Swan tier | Monthly | Annual | Credits/mo | Seats |
|---|---|---|---|---|
| Solo | $100 | $80 ($960/yr) | 200 | 1 |
| Starter | $200 | $160 ($1,920/yr) | 1,000 | 1 |
| Growth *(most popular)* | $419 — $99 platform fee + $0.16/credit | $336 — $80 fee + $0.128/credit | 2,000 | 5 |
| Scale | custom | custom | — | — |

$0.16/credit monthly, $0.128 annual; extra seats $20/mo; alert recipients and
read-only dashboard users are free. Rollover: 2× allocation on monthly, unlimited
within the term on annual. Top-ups at 150% of plan rate. Integrations are gated —
Slack/Gmail/LinkedIn/Calendar on every plan, **HubSpot and Attio from Growth up**,
Salesforce and Gong enterprise.

Worth staring at: **Solo is $100/mo for 200 actions.** One credit is one action —
one research, one enrichment, one DM, one CRM write — so a Solo customer gets
about seven agent actions a day. Gojiberry charges $99 for 1,800 prospects
contacted. Swan is not priced as an SDR replacement at the low end; it is priced
as a workflow tool with a metered runtime, and the cheap tier exists to get you
to Growth.

### What their changelog says about where they are

Ten entries, 20 May – 20 July 2026. **LinkedIn connection requests shipped
13 July 2026. Reviewable email drafts shipped 23 June 2026. "Connect Swan to your
other AI agents" — their MCP surface — shipped 9 July 2026.** So: the LinkedIn
channel is eight weeks old, human review of outbound email is six weeks old, and
their MCP story is a month old. Swan is further from finished than the homepage
reads, and the two things we have had longest — approval and MCP — are the two
they shipped most recently.

---

## 2. The scoreboard

`ahead` = Trevra is materially better. `parity` = we have it.
`partial` = we have a weaker or narrower version. `gap` = absent.
`refuse` = absent on purpose, and should stay absent.

### Authoring and workflow engine

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| English prompt → running workflow | yes, the whole pitch | partial (ICP auto-built) | no — playbooks are code in `playbooks/registry.ts` | **gap, the big one** |
| Workspace-owned workflows (no deploy) | yes | yes | no — 5 playbooks, ship with the binary | **gap** |
| Branching / conditional steps | yes | yes | no — linear DAG, 3 step types (`skill`/`approval`/`action`) | **gap** |
| Fan-out over N items | yes | yes | no — a run that finds nothing *fails* | **gap** |
| Iterate by talking to it | yes | — | no | **gap** |
| Packaged play library | 6 named agents | playbooks page | 5 playbooks, different shape | **partial** |
| Sub-agent delegation | claimed (changelog) | 2–3 agents/plan | no | gap, low value |

### Signals and triggers

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| Generic change-watch | yes | yes | `gtm.watch-signal`, snapshot-diff | **parity-ish** |
| Job change | yes | yes | no | gap |
| Funding / hiring / leadership change | yes | yes | no | gap |
| Tech-stack change | yes | — | partial — `gtm.enrich-company` fingerprints once, no diff | partial |
| Website visitor deanonymization | yes, first-party | no | no | **decision D4** |
| LinkedIn engagement / profile views | yes | yes | no — inbox sync only | gap |
| Deal stage / closed-won / closed-lost | yes | — | no — `opportunities` has no stage machine | gap |
| Meeting scheduled / ended | yes | — | no — Calendar connects and drops every record | gap |
| 3rd-party intent (6sense, RB2B, G2) | integrations | — | no | refuse (resale layer) |
| Composite signal thresholds | yes | scoring | partial — `gtm.score-lead`, `gtm.score-threads` | partial |
| Event-driven firing | yes | yes | no — one 60s `setInterval`, `domain_events` has no subscribers | **gap** |

### Data

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| Waterfall email/phone enrichment | yes, multi-provider | 15+ providers | no — `gtm.find-contact` crawls the customer's own site | **gap, deliberate today** |
| Company enrichment | yes | yes | `gtm.enrich-company` — JSON-LD, OG, tech fingerprint, Shopify | partial |
| Firmographics: headcount, revenue, funding | yes | yes | refused in code, on purpose | **decision D3** |
| Lookalike company search | yes (Doggo) | yes | no | gap |
| Lead sourcing without a list | yes | yes, the hook | `gtm.source-leads` via Exa; LinkedIn scraping off by default, self-host only | **partial** |
| Re-enrichment / staleness | yes | — | no | gap |
| Provider conflict resolution | yes | waterfall | n/a | gap |

### Execution

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| Email send | yes | yes | Gmail + Microsoft Graph, real, approval-gated | **parity** |
| Sending infra: domains, warmup, deliverability | via rails | yes | no — no SMTP/ESP path at all | gap |
| LinkedIn connection request + DM | yes | yes | **export-only** — CSV to Dripify/HeyReach/Expandi; the browser worker can do it, nothing queues it | **decision D2** |
| LinkedIn follow / like / endorse | yes | yes | yes, browser-driven, self-host only | partial |
| Multichannel sequences with branching | yes | yes | 4 templates, `accepted/replied/not_accepted/not_replied/always`, JSONB CHECK-enforced | **parity** |
| Account-safety pacing | undisclosed | claimed | per-kind warmup bands, ±35% day clamp, acceptance throttle, Tue/Wed scan capping, seeded jitter, every constant confidence-tagged | **ahead — by a distance** |
| Unified reply inbox | Slack + app | yes | LinkedIn inbox sync, two-pass, reply queue | **parity** |
| AI reply drafting | yes | yes, pre-written | `gtm.draft-reply` | parity |
| Meeting booking | moving toward | "demos land in your calendar" | no | gap |
| Invite withdrawal queue | — | — | yes, itself paced and gated | ahead |

### CRM and system of record

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| Log activity / note on a contact | yes | yes | HubSpot + Attio, real, idempotent | **parity** |
| Create/update contacts & companies | yes | yes | **refused in code** | **decision D5** |
| Merge duplicates, set properties, tasks | yes | — | no | decision D5 |
| Read pipeline / deals | yes | yes | `opportunities` projection, no stage semantics | partial |
| Contract → scope → milestone → deliverable | no | no | full model | **ahead — nobody else has it** |
| Invoice / payment reconciliation | no | no | model shipped; the write path delegates to Nango action scripts **that are not in this repo** | partial-but-broken |

### Surfaces

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| Chat over the whole product | yes, primary | yes | no — hosted agent has no chat UI | **gap** |
| Slack copilot + approval cards | yes, marquee | — | no | **gap, cheapest high-value one** |
| MCP server for external agents | changelog mention | **shipped, marketed** | shipped: HTTP + stdio, 11 tools + one per skill | **parity, and we were early** |
| Onboarding to first result | "minutes" | 3 min, URL only | 9-step derived checklist | **partial** |
| Multi-seat / agency | $20/seat | agency tier | one seat per workspace, `seat_key` always `'owner'` | **gap** |
| Self-host | no | no | yes | ahead |
| BYO model key | no (they resell) | no | AES-256-GCM, SSRF-gated, budget-capped | ahead |

### Trust — where the argument is actually ours

| Capability | Swan | Goji | Trevra | Verdict |
|---|---|---|---|---|
| Human-in-the-loop approval | settings toggle, in the FAQ | "full auto or approve" toggle | the product's spine | **ahead** |
| Agent structurally cannot execute | no | no | no send/approve tool exists; test-enforced | **ahead, and unique** |
| Hash-pinned payload approval | no | no | `canonicalPayloadHash`; a changed payload is rejected, not sent | **ahead, and unique** |
| Complete run ledger with evidence | "workflow monitoring" | weekly reports | per-node input/output/evidence/policy verdict/hash/timing | **ahead** |
| Take-your-data-out export | no | no | NDJSON + manifest, sha256 per file | ahead |
| Spend cap + kill switch | credits pause | — | pre-flight cap, unmetered-call floor, kill switch polled between turns | ahead |
| Named compliance (SOC 2 / ISO) | **none found** | none found | none | tie, all three exposed |
| Learning / benchmark loop | claimed | "better every week", industry benchmarks | no — the ledger has the data, nothing reads it | **gap** |

---

## 3. The honest summary

Three clusters, and they are not equally hard.

**A. Trevra is already ahead where the category is weakest.** Approval as a
structural property rather than a checkbox, a payload hash a human signs, a
ledger with evidence per node, an exportable audit trail, a pacing engine whose
every constant is tagged with its confidence. Swan has none of this; neither
does anyone in the landscape doc. With the EU AI Act's human-oversight
obligations live this month, that is not a nice-to-have any more.

**B. Four gaps are cheap and we should just close them.** Slack copilot, a chat
surface over the tools we already expose, URL→ICP onboarding, and an outcome
feedback loop over the ledger. None contradict anything. All four are what
prospects will notice in the first ten minutes.

**C. Everything else is blocked on a decision, not on engineering.** Six of
them, below. Until they are answered, "full parity" is not a work item — it is a
request to rewrite the product's premises. Which is a legitimate thing to want;
it just has to be said out loud.

---

## 4. The six decisions

### D1 — Does the workflow engine get to branch?

*Blocks:* NL workflow authoring, fan-out plays, per-item approval, every
discovery-shaped play (lookalike, closed-lost, pipeline health).

Today: linear DAG, three step types, and a run that discovers nothing **fails**
at the guard rather than skipping. "One approval per reply" is structural — you
cannot express *approve these 40 targets in one click*, which is exactly the
interaction Swan sells.

**Recommendation: yes, and it is the single highest-leverage build.** Add
`condition`, `foreach` and a batch-approval step; make playbooks a workspace-owned
row rather than a code registry. This is a prerequisite for D6 and there is no
way around it.

### D2 — Does Trevra ever send on LinkedIn?

Today: campaign invites and DMs are **exported** to a CSV and the operator runs
them in Dripify/HeyReach/Expandi, then reports outcomes back. Funnel numbers
depend on operator self-reporting. All LinkedIn automation is refused
unconditionally when `TREVRA_DEPLOYMENT_MODE=hosted`.

Platform risk is real but should be stated accurately, because an overstated
version is easy to dismiss. **What actually happened:** on 25 March 2026 LinkedIn
removed HeyReach's company page and the personal profiles of three of its
executives — per the CEO's own post, with no impact on running customer
automations and the product itself untouched. Third-party blogs inflated this
into "HeyReach banned"; that is wrong, and we should not repeat it. Separately,
Sales Navigator's SNAP partner programme stopped accepting new applicants, and a
widely-cited "27–34% of Dripify users restricted within 90 days" figure traces to
a competitor's SEO page with no primary corroboration — treat as unverified.

The sober version is still enough: every cloud LinkedIn vendor operates on
revocable access it never licensed, and LinkedIn is demonstrably willing to act
against the companies, if not yet the tools.

**Recommendation: never send from Trevra's *infrastructure* — and do send from
the operator's own machine.** Those are different sentences and the distinction
is the whole design. The local Playwright worker was specified, sanctioned and
built (`driver.ts`, `local-worker.ts`); the only thing missing is an API path
that queues an invite or a DM as `planned`. Finish it. The operator's machine,
the operator's logged-in profile, zero credential custody, and a real browser on
a residential IP — which is a *safer* fingerprint than the datacenter proxies
the cloud tools use, not merely a more defensible one.

What stays refused: shipping a browser extension, storing a LinkedIn password,
and running the automation on Trevra's own servers. `TREVRA_DEPLOYMENT_MODE=hosted`
keeps refusing until a signed local companion exists — **hosted brain, local
hands** is the only shape that lets the managed product exist without making
Trevra the automation operator. Costs and constraints:
[core-product.md](./core-product.md) §3.5.

### D3 — Do we buy data?

*Blocks:* lookalike outbound, job-change triggers, funding/hiring signals,
waterfall email discovery — i.e. four of Swan's six agents and Gojiberry's
entire hook.

Today: Exa search plus first-party scraping. Apollo is deliberately withheld with
a recorded ToS clause. Headcount/revenue/funding are refused in code.

There is no honest way to ship signal-triggered outbound without a data layer.
But we do not have to become a data reseller: one waterfall aggregator
(FullEnrich charges only on success; Prospeo from $39/mo) plus one company graph
(Ocean.io, ~$0.07/credit) covers the four plays, and both are pass-through
credentials the customer can bring themselves — which keeps the resale/GDPR
question on their side of the line.

**Recommendation: yes, BYO-key only.** Provider adapters behind the existing
`network-read` skill class, customer-supplied keys, never a Trevra-resold credit.

### D4 — Website visitor deanonymization?

Swan's own privacy policy calls the company a deanonymization service.
Person-level identification is US-only by construction; the only GDPR-native
vendor in the whole landscape is Dealfront, and it is company-level in the EU on
purpose.

**Recommendation: company-level only, or not at all.** Person-level deanon of EU
visitors is legally the most exposed thing in this category, and it is
irreconcilable with the trust posture that is our actual differentiator. Losing
Gatto is a smaller loss than losing the argument.

### D5 — Does CRM write-back widen?

[system-of-record.md](./system-of-record.md) says: a note on an **existing**
contact, matched by email only, never a record, never a deal, never a property —
because a second writer is how two systems start disagreeing, and inventing
contacts from forum handles is the one thing a CRM owner never forgives.

Swan does all of it, including merging duplicates.

**Recommendation: hold the line, with one narrow exception** — allow
`crm.create-contact` as an *approved action* (hash-pinned, human-signed,
never agent-initiated), because "the lead I approved outreach to doesn't exist in
HubSpot" is a real dead end. Deals, stages, amounts, owners and merges stay
refused.

### D6 — Prompt → workflow: build it, or refuse the category?

This is Swan's entire wedge and Trevra's largest single gap. It needs D1, plus
workspace-owned playbook rows, plus a synthesizer that turns English into a
validated playbook document, plus a preview a human approves before it runs.

Note the shape that fits *us*: the synthesizer is exactly the kind of job the
agent already does — and the approval boundary already exists to make it safe.
**A generated playbook is a payload a human signs before it can run.** That is a
better answer than Swan's, which deploys on the model's say-so.

**Recommendation: yes, after D1, and pitched as "describe it, review it, sign
it."**

---

## 5. What parity costs, in order

**Wave 1 — no decision required, ships now.**
1. Slack app: alerts, `/trevra` research, approval cards. Reuses the tool surface and the approval path; no new invariant.
2. Chat surface over the hosted agent, in-app. The loop exists; it has no window.
3. URL → ICP onboarding. Point `gtm.enrich-company` at the customer's own domain, derive the ICP, collapse the 9-step checklist to one field.
4. Outcome feedback loop: reply/acceptance rates by segment, template and time, read out of the ledger. Gojiberry ships this as "gets better every week"; we have the data and no reader.
5. Fix what's already broken: Calendar records are ingested and dropped; `EXA_API_KEY` is undocumented and disconnected from the Nango catalog entry; the Nango invoice/change-order action scripts do not exist in this repo, so `invoice.create` throws in any deployment that hasn't authored them.

**Wave 2 — engine (D1).** `condition`, `foreach`, batch approval; playbooks as
workspace rows; event subscribers on `domain_events` so triggers fire on facts
instead of a 60-second poll.

**Wave 3 — data (D3) + signals.** BYO-key waterfall enrichment and a company
graph; job-change, funding and hiring watchers on top of the existing
snapshot-diff signal; deal-stage semantics on `opportunities` so closed-won and
closed-lost become triggers.

**Wave 4 — the plays.** Lookalike outbound, closed-lost analysis, meeting prep,
pipeline health. All four are content once Waves 2 and 3 land; none are content
before.

**Wave 5 — authoring (D6).** Prompt → playbook → human signs it → it runs.

**Wave 6 — the multiplayer product.** Multi-seat outreach with per-seat
accounting, approval routing and assignment. [system-of-record.md](./system-of-record.md)
already names this: *the data model is ready for big teams; the product surface
is not.*

---

## 6. Parity we should refuse

- **Person-level EU visitor deanonymization** (D4).
- **Sending from our own LinkedIn infrastructure** (D2) — the category's live
  extinction risk.
- **A credit currency.** Action/Data credits are how Swan, Clay, Unify and
  Apollo monetize; they also mean every customer conversation is about credit
  burn. BYO-key model spend with a hard cap is a better story and already built.
- **Reselling inference.** Already out of scope in
  [byok-and-hosted-agent.md](./byok-and-hosted-agent.md) §8.
- **CRM record ownership** beyond the D5 exception.
- **"Full auto" as a marketed mode.** Gojiberry sells it as a toggle. It is the
  exact thing app-spec §11 exists to refuse, and refusing it is the product.

---

## 7. The call — trimmed scope

The strategic read first, because it decides the list: **we cannot win by
chasing Swan feature-for-feature.** They have $6M, ~200 customers and a shipping
cadence of one release a week; Gojiberry undercuts them at $99. Feature parity
reached in twelve months is parity with where they were. The asymmetry we
already own — approval as architecture, an evidence ledger, self-host with BYO
key, and the delivery half of the revenue graph — is the thing they cannot copy
in a sprint. Everything below either sharpens that or removes a reason to say no.

### Do, in this order

**0. Fix what currently lies.** `invoice.create` throws in any deployment that
hasn't hand-authored the missing Nango action scripts; Calendar connects and
silently drops every record; `EXA_API_KEY` is undocumented and disconnected from
the Nango catalog entry that appears to enable it. A product that claims work it
cannot do violates our own copy rule 3. Days, not weeks.

**1. Send it ourselves, from the operator's machine (D2).** Today we plan, pace
and guard, then hand over a CSV and ask the operator to *tell us* what happened.
The self-reporting is the defect, and it makes the only KPI unmeasurable. The
worker that fixes it is already built — wire an approved campaign to queue
invites and DMs as `planned` and the existing loop (claim → safety gate → driver
→ outcome → branch evaluation) does the rest. It also removes a $39–79/user/mo
subscription and unlocks the two things no bulk tool can do: a message
personalised per target, and a branch actually resolved. Budget for selector
maintenance; it is the real price. [core-product.md](./core-product.md) §3.5.

**2. The two surfaces the category interacts through.** An in-app chat over the
hosted agent (the loop exists; it has no window) and a Slack app carrying alerts
and approval cards. No invariant is touched by either, and their absence is what
a prospect notices in the first ten minutes.

**3. URL → ICP onboarding.** Point `gtm.enrich-company` at the customer's own
domain, derive the ICP, collapse the nine-step checklist to one field.
Gojiberry's entire hook is that this takes three minutes.

**4. The feedback loop.** Acceptance and reply rates by segment, template and
send time, read out of the ledger. We are the only vendor with node-level
evidence and the only one not reading it. "Gets better every week" is a claim we
can actually substantiate.

**5. The engine (D1).** `condition`, `foreach`, batch approval; playbooks as
workspace rows. Do it because *approve these 40 in one signature* is the
interaction our approval model currently makes impossible — not because Swan has
branching. Everything in Wave 4 is blocked on it.

**6. Enrichment, BYO-key only (D3).** One waterfall (FullEnrich charges only on
match) plus one company graph (Ocean.io). Customer-supplied credentials, behind
the existing `network-read` skill class. Never a Trevra-resold credit.

**7. Two plays, not six.** Pipeline health and closed-lost analysis run on data
we already hold. Lookalike outbound needs step 6; meeting prep needs Calendar
alive. Skip Gatto entirely (D4).

**8. Publish the security posture.** Not SOC 2 — too slow and too expensive for
where we are, and neither Swan nor Gojiberry nor OpenGTM has it either. A
`/security` page stating the invariant, the threat model, the SSRF and key
handling, and the export guarantee. Free, and it is the sales asset.

### Don't

| | Why not |
|---|---|
| **Prompt → workflow authoring (D6)** | Swan's wedge and their brand. Our version needs the engine first, and "describe it, review it, sign it" is a better story told *later* from strength than a worse Lovable-for-GTM told now. Revisit after step 5. |
| **Person-level visitor deanonymization (D4)** | Legally the most exposed thing in the category, US-only in practice, and irreconcilable with the posture that is our actual product. |
| **Sending from Trevra's own servers, or shipping a browser extension** | Both put us inside User Agreement §8.2 as the automation operator; LinkedIn removed HeyReach's company page and three exec profiles in Mar 2026 — the tool survived, the company got hit. Sending from the *operator's* machine is a different position and is the one we take. |
| **CRM record ownership (D5)** | Hold the line in [system-of-record.md](./system-of-record.md). Even the narrow approved `crm.create-contact` exception waits until a customer is actually blocked by it. |
| **A credit currency** | It makes every renewal conversation about credit burn. BYO-key spend with a hard cap is a better story and is already built. |
| **Multi-seat / agency** | Real gap, wrong time. Build it when someone is holding a cheque for it. |
| **The other four named plays** | Content without the data layer. Building them early produces demos that fail on real accounts. |
| **Feature-parity marketing** | The homepage should say the one sentence nobody else can say, not list Swan's features with our logo on them. |

### The one sentence to build the marketing on

> **The GTM agent that cannot go rogue, and can prove what it did.**

Bring your own agent, your own model key, your own LinkedIn session. Nothing
leaves the building without a human signature on the exact payload, and every
run is exportable evidence. No vendor in
[competitive-landscape.md](./competitive-landscape.md) can currently say that
back — OpenGTM gets closest, and only by never sending anything.

---

## 8. Sources

getswan.com (home, pricing, about, changelog, /roles/*, /use-cases/*,
/solutions/website-visitor-identification, legal/privacy-policy, terms);
agent.getswan.com (login-walled); gojiberry.ai (home, faq,
how-to-do-outreach-claude-linkedin-mcp, pricing); CTech/Calcalist Feb 2026
funding coverage; salesforge.ai Swan review (competitor-authored, Feb 2026);
G2 4.7/5 over 61 reviews (search snippet only — G2 is JS-gated and the figure is
unverified against the primary source).

**Caution:** several aggregators (Dealroom, StartupHub.ai, one Crunchbase hit)
carry materially wrong facts for "Swan" — wrong founders, wrong city, wrong
founding year. They are describing a different company. Do not cite them.

Trevra statuses in §2 were read out of the codebase, not out of these docs, and
are current as of this commit.
