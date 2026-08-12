# The field Trevra is standing in

Who else sells "an agent that runs your go-to-market", what they charge, what
they all have, and what none of them have. Companion to
[swan-parity.md](./swan-parity.md), which does the line-by-line against
[getswan.com](https://www.getswan.com).

Researched August 2026. Pricing and funding for vendors other than Swan and
Gojiberry come from vendor sites cross-checked against secondary trackers —
re-verify anything before it goes in a board deck.

---

## 1. Seven segments, and which one is actually ours

### 1.1 Agentic GTM builders — the lane Swan is in

| | Positioning | Entry price | Stage | Differentiator | Weakness |
|---|---|---|---|---|---|
| **Clay** | Spreadsheet-native GTM data engine | Free → $185 → $495/mo, Data+Action credits | $210M raised, **$5B val. Jan 2026** | The enrichment marketplace everyone else plugs into | You have to be good at Clay; cost curve is steep |
| **Cargo** | GTM data layer + RevOps agents | ~$0.14/credit, 20k min → ~$2.8k floor | $19.4M Series A, YC S23 | Structurally the closest thing to Swan | Still a builder UX; small brand |
| **Octave** | "Agentic GTM brain" — playbooks + agents | Free → $149 → $499/mo | $5.5M seed | Best messaging/context engine in the set | Thin on execution and writeback |
| **Unify** | Signal → sequence outbound, ~25 signal types | $1,740/mo annual, 1 user | $52M, $40M Series B Jul 2025 (Battery, OpenAI Startup Fund) | Deepest signal aggregation + managed send | High floor, configured not conversational |
| **Relevance AI** | Horizontal agent platform, GTM templates | Free → ~$234–349/mo | — | Flexible, not GTM-locked | GTM is a template layer |
| **Lindy** | No-code agent builder incl. sales | $50 → $100 → $200/mo | — | 2,300+ app library | GTM is one vertical of many |
| **Gumloop** | Visual builder, parallel sub-agents | Free → $37/mo | $70M+, $50M Series B (Benchmark) | Sub-agent parallelism | No revenue objects |
| **Bardeen** | Browser agent | Free → $10–15/mo | $25.3M (HubSpot Ventures) | Cheapest agentic entry | Extension-shaped, thin server side |
| **n8n** | Open-source automation + agent nodes | Free self-hosted | $240M, $180M Series C Oct 2025 | Self-hostable, huge templates | Zero packaged plays — the DIY pain Swan sells against |
| **Zapier Agents** | Agents over 7,000 apps | ~$50/mo | public-ish | The integration graph | Bolted on; costs scale badly |
| **Default** | AI revenue agent for routing/RevOps | from $500/mo | $20M+ Series A (8VC) | Lead routing done properly | Narrow |

### 1.2 AI SDR / "hire an agent" — same buyer, different pitch

| | Entry price | Stage | Note |
|---|---|---|---|
| **11x (Alice)** | list $36k/yr; street $5k–15k/mo + ~$3k implementation | well funded | The loudest brand, and the one taking the most reputational damage |
| **Artisan (Ava)** | ~$600–2,500/mo | $25M Series A Apr 2025 | 270M contact DB; "full self-driving" still marked *soon* |
| **Regie.ai** | $180/user, 10-seat min ($21.6k/yr floor) | $50M | Enterprise SDR orgs |
| **AiSDR** | $250 → $900 → $2,500/mo | $3M seed, YC S23 | Rare: publishes its pricing |
| **Lyzr / Jazon** | custom; platform $19–99/mo + $0.08/run | — | Only one offering VPC deployment |
| **Qualified / Piper** | ~$68k/yr list → $40–50k negotiated, Salesforce required | **acquired by Salesforce, Apr 2026** | Gone as an independent |
| **Agentforce SDR** | $2/conversation or $0.10/action; Agentforce 1 $550/user/mo | Salesforce | Default gravity for SFDC shops |
| **Alta** | not public | $25M Series A Jul 2026, ~$15M ARR | Multi-agent shared-context — philosophically closest to Swan |
| **Topo.io** | $900/mo for 1k leads | pre-seed, YC | Clean leads-contacted pricing |
| **Gojiberry** | **$99/mo**, 1,800 prospects, MCP included | YC P26 | The floor of the market. See [swan-parity.md](./swan-parity.md) |

### 1.3 Signals and visitor identification — the layer above us

| | Entry price | Note |
|---|---|---|
| **Common Room** | $1,700/mo + $5–20k onboarding | Broadest signal aggregation; closest to Swan's thesis |
| **Warmly** | free 500 visitors → $700–1,440/mo | Deanon + chat + trigger, SMB-friendly |
| **RB2B** | free 150/mo → $79–199/mo | US person-level only; bootstrapped, ~$7M ARR |
| **Vector** | $399 → $999/mo | Deanon → ad audiences, not sales execution |
| **Koala** | ~$350/mo → $2.5–8k | Deepest product-usage signal (PLG) |
| **UserGems** | $2,750/mo → $10k/mo | Created the job-change trigger category |
| **Trigify** | $40 → $199/mo | Cheapest social-signal entry, 30+ trigger types |
| **Factors.ai** | $399 → $2,149/mo | Attribution-first |
| **Dealfront / Leadfeeder** | free → $99/mo → quote | **The only GDPR/EU-hosting-native vendor in this entire map** |
| **HubSpot Breeze** (ex-Clearbit) | $45–50/mo credits atop HubSpot | Zero-friction for the HubSpot base |
| ~~Pocus~~ | — | **acquired by Apollo, Mar 2026** |

### 1.4 Data and enrichment — what we would buy, not compete with

| | Price | Note |
|---|---|---|
| **Apollo** | free → $119/user/mo | Biggest base; now owns Pocus |
| **ZoomInfo Copilot** | $14,995 → $39,995/yr | Enterprise data, analytics not execution |
| **Explorium** | ~$0.015/credit | **Ships a native MCP server** |
| **Ocean.io** | $0.071–0.081/credit | Lookalike company graph — the Doggo ingredient |
| **FullEnrich** | ~$29/mo | Waterfall over 20+ providers, **charges only on match** |
| **Prospeo** | $39/mo | Email find/verify |
| ~~Persana~~ | — | **folding into Rox, May 2026** |

### 1.5 LinkedIn execution — a commodity band on fire

| | Price | Note |
|---|---|---|
| **HeyReach** | $79/sender/mo | **Real public REST API + webhooks** (X-API-KEY, 300 req/min). LinkedIn removed its company page and three exec profiles on 25 Mar 2026 — per the CEO, customer automations unaffected and the product untouched. Blogs reporting "HeyReach banned" overstate it. |
| **Expandi** | $99/seat/mo ($79 annual) | 20+ outbound webhook event types + a narrow inbound "reversed webhook" (add lead to campaign, pause/resume). Best two-way surface in the band. |
| **Dripify** | $39–79/user/mo | **No public API.** Outbound webhooks on Pro+, one trigger per webhook per campaign, lead data only. **No custom CSV variables** — built-in tokens only. Import needs just a profile URL. The "27–34% restricted in 90 days" figure traces to a competitor's SEO page — unverified. |
| **Lemlist** | $79–109/user/mo | **$0 raised, $53M ARR**, bought Claap for $25M cash — the bootstrapped counterexample |
| **La Growth Machine** | $70–195/mo per identity | Broadest channel mix incl. X |
| **PhantomBuster** | $69–439/mo | Cookie sessions, same exposure |
| *Sales Navigator* | — | SNAP partner API **not accepting new applicants in 2026**. Every vendor above runs on revocable access. |

### 1.6 Pipeline and revenue intelligence — downstream

**Gong** ($1,400–3,000/user/yr + platform fee), **Clari** ($510M raised, $2.6B
val. — and **shipped an MCP server** exposing pipeline data to Claude/ChatGPT/
Copilot), **Attention** ($25k–200k+/yr), **Nooks** (~$4–5k/user/yr, phone),
**Momentum** (**acquired by Salesforce, Mar 2026**).

### 1.7 Warehouse-native GTM intelligence — the brain, not the hands

A distinct lane, and the one that argues most like us. It starts from the data
model rather than the workflow: score every account in the customer's own
warehouse, compute the next best action, hand it to whatever executes.

| | Positioning | Entry price | Stage | Executes? |
|---|---|---|---|---|
| **OpenGTM** | "The GTM computer your CEO has been asking for" — ontology over your warehouse, pre-computed next action | contact-only, no public price | launched ~Feb 2026; **funding undisclosed** | **No, on principle** |
| **Hightouch** | Composable CDP + RL-based AI Decisioning | $350/mo + usage | $322M; **Series D $150M Apr 2026 @ $2.75B** | Yes — and ships a documented read/write MCP |
| **Syncari** | "Agentic MDM" — governed GTM data layer | undisclosed | ~$27–44M, Series B Sep 2025; 2026 Gartner MQ Visionary | No — **GA MCP server since ~May 2025** |
| **MadKudu** | ML lead/PQL scoring | $1,999–2,499/mo | $29.1M | No |
| **HockeyStack** | Warehouse-native revenue intelligence + agents | ~$1,399/mo, ~$2,200/mo execution tier | $50M+ (Bessemer) | Yes, explicitly sells it as a tier |
| **Inflection.io** | Warehouse-native lifecycle marketing | from $36k/yr | $14M; **acquired Keyplay Apr 2026** | Yes |
| **Gradient Works** | Dynamic books, routing/assignment | per user + accounts | ~$2M | Yes (routing) |
| **Fullcast** | RevOps plan-to-pay | modular | $34M; bought Atrium + Copy.ai 2025 | Yes |
| **Endgame** | "Context graph for every GTM agent" | not public | $47.5M | No |
| **Breadcrumbs** | Lead scoring/routing | free → $99/mo | ~$5M | No |
| ~~Keyplay~~ | account scoring | — | **acquired by Inflection.io, Apr 2026** | — |
| ~~Census~~ | reverse ETL | — | **acquired by Fivetran, May 2025** | — |
| ~~Bluebirds~~ | buying-group AI agent | — | **acquired by Salesforce, Jul 2025** | — |
| ~~Falkon~~, ~~Correlated~~, ~~Calixa~~ | — | — | **all dead** | — |

**OpenGTM deserves its own paragraph** — it is the closest thing in this whole
document to Trevra's argument, arriving from the opposite direction.

Founded by Ben Salzman (Dogpatch Advisors → acquired by ZoomInfo; started
ZoomInfo Labs) with two co-CTOs out of Clearbit, Hightouch and HubSpot. Launched
around February 2026 with an invite-only dinner whose guest list read Vercel,
Anthropic, OpenAI, Canva, Harvey, Cognition, Snowflake. Funding undisclosed. No
public pricing. Snowflake only today, Databricks/BigQuery/Redshift on the
roadmap. Sister entity `opengtm.org` runs a research-lab/manifesto arm.

What they claim, and it is nearly our list: **zero data retention** (models run
against the warehouse at runtime, nothing persisted), the customer's warehouse
stays the single source of truth, **every score traces back to the signals that
produced it**, scoring models are versioned, RBAC + SAML + full audit logs, and
delivery **via MCP**, CRM and the warehouse itself. And — stated as a
philosophy, not a limitation — they compute the action your agent *should take
next*. **They never execute.**

What is not verifiable from outside: no public MCP docs or spec, no `/security`
page, no SOC 2 badge, no named customers (the account rows on the homepage read
as sample data), no disclosed round.

**Name-collision warning:** almost every Crunchbase/PitchBook/Tracxn hit for
"OpenGTM" — including a $2.4M seed — belongs to Patri Inc., which rebranded to
OpenGTM in 2023 and then renamed again to GTMx. Unrelated company. Do not cite.

---

## 2. Table stakes

Everything below is shipped by nearly everyone in §1.1–1.2. Absent any of it,
you are not in the conversation:

- Natural-language agent/workflow creation
- Waterfall enrichment across multiple providers
- Signal ingestion — job change, funding, hiring, intent, visitor ID
- Email **and** LinkedIn in one sequence
- CRM writeback to HubSpot/Salesforce objects
- Slack as the notification and approval surface
- Credit-metered consumption pricing

Trevra ships three of seven. See [swan-parity.md](./swan-parity.md) §2.

---

## 3. White space — what nobody in §1 is selling

1. **Approval-gated execution as the headline, not a settings checkbox.** Every
   vendor surveyed treats human review as a toggle. Swan shipped "reviewable
   email drafts" in June 2026. Nobody markets the boundary as the product.
2. **A compliance-grade action log.** Reported: ~74% of teams plan agent
   deployment inside two years, ~21% have a mature governance model — and the EU
   AI Act's human-oversight obligations bite this month. **Partly contested
   now:** OpenGTM markets zero-retention, versioned models, score-level lineage
   and audit logs; Syncari has governance intrinsic to the MDM category. But
   both trace *how a number was computed*. Neither logs **what an agent did and
   who signed it**, because neither lets an agent do anything. An evidence-bearing
   ledger of executed work is still unclaimed.
3. **BYO-agent over MCP.** Explorium, Clari, Hightouch (documented, read+write),
   Syncari (GA since ~May 2025) and Gojiberry expose real MCP surfaces; Swan
   added one on 9 July 2026; OpenGTM claims one with no public spec. Still rare
   — 3 confirmed out of ~16 in the warehouse lane — but the direction of travel
   is obvious. This was a moat six months ago and is becoming a checkbox: MCP
   SDK downloads went ~970× in 18 months and the final spec landed 28 July 2026.
4. **EU/GDPR-native posture.** Dealfront is the only vendor built that way.
   Person-level deanon is structurally US-only.
5. **The $99–500/mo cross-channel band.** Direct peers cluster $1,700–10,000/mo
   (Alta, Unify, Cargo, Common Room, UserGems) and usually add $3–20k
   onboarding; the cheap self-serve tier (RB2B, Trigify, AiSDR) doesn't
   orchestrate. Gojiberry is attacking exactly this gap at $99.
6. **LinkedIn execution without borrowed-session risk.** Every vendor here runs
   on revocable cloud or cookie access. HeyReach proves the tail risk is real,
   not theoretical.
7. **Contract → scope → milestone → deliverable → invoice.** Nobody in any of the
   six segments models the delivery half of the revenue graph. HubSpot stops at
   closed-won; accounting starts at the invoice. This remains Trevra's only
   completely uncontested ground.

---

## 4. Pricing norms

- **Credit consumption is the default.** Clay, Octave, Bardeen, Gumloop,
  FullEnrich, Ocean.io, Trigify, Apollo, ZoomInfo, Unify, Swan.
- **Per-seat survives** where the pitch is headcount replacement: Regie
  $180–499/user, Agentforce $550/user, Gong $1,400–3,000/user/yr.
- **Outcome pricing is talked about and not shipped.** Even 11x and Artisan,
  who gesture at per-meeting, bill flat.
- **Implementation fees of $3k–20k are standard above ~$1,700/mo** — which sits
  badly beside every "live in minutes" homepage in the category.
- **LinkedIn tools cluster at $39–199/seat/mo** — commodity pricing on top of
  existential platform risk.

---

## 5. Direction of travel

1. **MCP won.** Final spec 28 Jul 2026; ~97M monthly SDK downloads by Mar 2026.
   Clari and Explorium expose live data through it; Swan added it in July.
   Reported consolidation from $85k+ point-solution stacks to $15–35k
   MCP-linked ones. Being MCP-native stops being a differentiator this year and
   becomes an expectation.
2. **LinkedIn is closing — stated carefully.** LinkedIn removed HeyReach's
   company page and three exec profiles in Mar 2026 (the tool kept running);
   SNAP stopped accepting new partners. The widely-repeated Dripify
   restriction-rate figure is competitor-authored and unverified. The durable
   point stands without the exaggeration: anyone whose product *is* LinkedIn
   sending holds a revocable license they never signed, and the platform has
   shown it will act against the company even when it spares the software.
3. **Deliverability is shifting from volume to engagement quality.** DMARC/BIMI/
   MTA-STS are baseline; providers increasingly score reply depth and read time.
   Agentic senders must optimise relevance per send or trip agent detection.
4. **The point solutions are being eaten.** Pocus→Apollo, Qualified→Salesforce,
   Momentum→Salesforce within about six weeks in spring 2026; Persana→Rox in
   May; Keyplay→Inflection Apr 2026; Bluebirds→Salesforce Jul 2025;
   Census→Fivetran May 2025. *(A later pass also reported Common Room→Zoom and
   Warmly→HubSpot; that contradicts an earlier pass which found both trading
   independently — **unverified, check before citing**.)* And note **what** the
   acquirers wanted: Pocus, Keyplay and Census were each bought to become the
   scoring layer inside somebody else's execution platform. Anything in this
   space needs an answer to "why do you stay independent".
5. **Agent trust is becoming regulation, not marketing.** The governance gap
   (74% deploying / 21% governed) plus the EU AI Act's oversight requirements
   turn "a human signed this exact payload" from a design preference into a
   procurement question.
6. **Scoring and sending are bundling.** Hightouch, Inflection, Bluebirds, Tofu
   and HockeyStack all bolted execution onto what began as intelligence.
   Deliberate abstention from execution — OpenGTM's stance, and structurally
   ours — is a genuine minority position swimming against the segment. Worth
   knowing whether or not it changes the answer: the reason to hold it is trust,
   not fashion, and the market will not reward it automatically.

---

## 6. Where Trevra actually sits

**We are not in the agentic-GTM-builder lane yet.** No natural-language
authoring, no bought data, no branching engine, and LinkedIn exports rather than
sends. Against Swan's own feature list we are behind on authoring, signals and
data, and level on sequencing, inbox and email.

**We are the only vendor in any of the seven segments whose agent structurally
cannot execute — while still executing.** That distinction is the whole position
and it is worth stating precisely, because OpenGTM now occupies the half of it
next door:

| | OpenGTM | Trevra | Swan / Gojiberry / the AI-SDR lane |
|---|---|---|---|
| Computes what to do | yes | yes | yes |
| The work leaves the building | no — hands off to your agent | **yes, after a human signs the exact payload** | yes, on the agent's say-so |
| Nothing goes out unreviewed | by abstention | by architecture | by settings toggle |
| Buyer | enterprise with a Snowflake warehouse | founder / lean team, self-host or hosted | anyone with a credit card |

OpenGTM proves the trust argument sells — they built a launch list of Anthropic,
OpenAI, Vercel and Snowflake on it — but they bought it by never touching the
send. Everyone who *does* send treats human review as a checkbox over an agent
that could have sent anyway. **Trevra is the only one holding both ends:** no
send tool exists in the agent's surface at all, approvals are pinned to a
canonical payload hash, and a payload that changed after signing is rejected
rather than delivered. That is an architectural choice made early and it cannot
be retrofitted in a sprint — which is precisely why it is worth building the
marketing on.

**Two structural advantages nobody is contesting:** the delivery half of the
revenue graph, and self-host with BYO model key (no inference resale, no data
resale, keys sealed and never in model context). OpenGTM's zero-retention pitch
is the same instinct — *your data stays yours* — aimed at a Snowflake buyer
rather than a founder. It confirms the instinct sells; it does not reach our
customer.

**Two structural exposures:** we have no named compliance certification (nor
does Swan, nor Gojiberry — but the enterprise buyer asks all three), and we are
single-seat while every direct peer sells to teams and agencies.

The positioning that follows from all of it:

> **The GTM agent that cannot go rogue, and can prove what it did.**
> Bring your own agent, your own model key, your own LinkedIn session. Nothing
> leaves the building without a human signature on the exact payload, and every
> run is exportable evidence.

That is a sentence no vendor in §1 can currently say back.
