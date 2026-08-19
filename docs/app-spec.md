# Trevra app specification

The decision record for what the product **is**, so the next change follows from
it instead of from whoever complained last. Written after a round of reactive
patching produced a patchwork.

---

## 1. The one sentence

> **Trevra is a workspace an agent operates and a human approves.**

Everything below is a consequence of that sentence. When a design question comes
up, answer it from here.

---

## 2. Who does what

| Actor                        | Job                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| **An agent** — the operator  | All the work: research, scoring, drafting, preparing, running jobs.                 |
| **Trevra** — the runtime     | Types the work, records every run, enforces the limits, executes what was approved. |
| **The human** — the approver | Three things only: connect an agent, connect the data, approve or reject.           |

**The human never does what the agent does better.** If a screen exists so a
person can hand-do the agent's job, it is not a primary screen.

### Two ways to be the operator

The operator is _an agent_. Which one is the operator's choice, not Trevra's.

|                                  | **Your agent** (BYO-agent)       | **Trevra's agent** (BYOK)                                                |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Runs on                          | Your laptop — Claude Code, Codex | Trevra's worker                                                          |
| Reaches Trevra via               | MCP, with an agent token         | In-process                                                               |
| Model paid for by                | Your Claude/Codex subscription   | Your API key, held by Trevra                                             |
| Works when your laptop is closed | No                               | Yes                                                                      |
| Status                           | **Shipped**                      | **Shipped** — see [byok-and-hosted-agent.md](./byok-and-hosted-agent.md) |

**Both get identical permissions.** A hosted agent is not more trusted for
living closer to the database. It holds the same scopes an agent token holds:
it may read and prepare, and it may never approve or execute. See §11.

---

## 3. Two first outcomes, one recurring job

A new user should not have to configure the whole product before any part becomes
useful. On Loop they choose the first outcome they want working:

1. **Win new business** — add a sending account, build a lead list, build a
   workflow, create a campaign.
2. **Get paid for work** — connect Claude Code/Codex, connect commercial data,
   bring in clients and agreements.

The choice is presentation, not truth. It can be remembered locally; every
completion mark still comes from a real object on the server.

After either outcome is live, the recurring human job is the same: **decide on
work Trevra prepared, and tend the exceptions that need a person.** Agents do the
research/drafting/routine work; Trevra enforces and records; the human approves,
pauses, replies where a workflow deliberately stops, or changes limits.

---

## 4. Information architecture

**Five nav items, one per stage of one loop.**

> **Amended.** This section used to read "**Three nav items.** Not six," over a
> table of Approvals / Activity / Setup. That table described an
> accounts-receivable product, it was written before the LinkedIn outreach
> engine existed, and it had already lost the argument in the code: the shell
> shipped a fourth item because the outreach seat is a thing an operator
> _tends_ rather than a thing they configure once. The founder's framing is
> that Trevra is one GTM loop with two ends — how you get paid and how you
> don't — and the outreach engine is the product, not an annex to the invoicing
> screens. Three items could not express that; five can. The rule the old
> number was protecting still stands and is restated below.

| Screen       | Hash        | The one question it answers                                                    | Default? |
| ------------ | ----------- | ------------------------------------------------------------------------------ | -------- |
| **Loop**     | `/loop`     | What is the loop doing, and where is it stuck?                                 | Yes      |
| **Outreach** | `/outreach` | What goes out, at what pace, and is the seat safe?                             |          |
| **Money**    | `/money`    | What was agreed, delivered, billed and paid — and what wasn't, and why?        |          |
| **Ledger**   | `/ledger`   | What did the agent actually do, with the evidence — and can I take it with me? |          |
| **Setup**    | `/setup`    | What can reach my workspace, what may it spend, what may it do?                |          |

**The rule the number was standing in for:** every item in the nav is a place a
founder goes _repeatedly_, and nothing else gets in. Sub-routes are not nav
items. A control that must always be reachable is shell chrome, not a
destination — which is why the stop control (`StopBar`) is on every route and
is not in this table.

### What moves, and why

| Was                         | Goes to                          | Reason                                                                                                                            |
| --------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Today                       | **Loop**                         | It is not "what am I owed"; it is where the loop is stuck. Six stages, one block sentence, four queues.                           |
| Approvals                   | **Money**                        | It is the paid end of the loop, grouped by loop stage rather than one flat list. The heading inside it is still _What needs you_. |
| Activity                    | **Ledger** (renamed)             | "Complete run ledger" is what the landing page sells and the app had no screen by that name.                                      |
| Clients                     | **Money**                        | Client state is a read about the paid end, not a workspace of its own.                                                            |
| Work (playbook launcher)    | **Out of the app**               | The agent starts jobs. A human doing it by hand is the exception, not the front door.                                             |
| Modules                     | **Out of the app**               | Reference material for a registry Setup no longer has a Skills screen to host.                                                    |
| Autopilot                   | **Setup → Limits**               | Set once, edited rarely.                                                                                                          |
| Connections                 | **Setup → Connections**          | Same.                                                                                                                             |
| LinkedIn tab strip (7 tabs) | **`/outreach/*` and `/setup/*`** | Five are the engine; Setup and Exclusions are configured once and moved to Setup.                                                 |
| Two kill switches           | **One `StopBar` in the shell**   | Two stop controls in two visual languages, neither admitting the other existed.                                                   |
| Publisher / SBOM / Ed25519  | **Out of the app**               | Developer tooling. Belongs in the CLI and docs, not a founder's nav.                                                              |

---

## 5. Screen contracts

Every screen states its purpose, its empty state, and its one primary action.
An empty state that does not tell you what to do next is a bug.

### Loop (default)

- **Purpose:** what is the loop doing, and where is it stuck. Not “what am I owed”.
- **Primary action:** the one button in the block sentence, pointing at the single stuck stage.
- **Empty, new workspace:** one selected, fully-verifiable first-outcome checklist; the user can switch between outreach and money without configuring both.
- **Empty, running workspace:** “Nothing needs you right now.”
- **Never:** draw a stage with no backend as a zero. It says “not connected yet”.

### Outreach

- **Purpose:** run the seat — what may go out today, why that number, where the variance is.
- **Primary action:** none on the seat screen; it is a read. The primary lives on Campaigns.
- **Campaigns:** `/outreach/manager` is the operating surface; `/outreach/manager/new` is the construction journey. Do not put lead-list/workflow editors back into the daily operating page.
- **Empty:** “No LinkedIn account is set up yet.” + one button to the canonical account manager at Outreach → LinkedIn accounts.
- **Never:** drop a `HARD FACT` / `REPORTED` tag on the way to the screen.

### Money

- **Purpose:** decide on prepared work at the paid end of the loop.
- **Primary action:** Review → approve or reject.
- **Empty, new workspace:** “Nothing here yet — connect a tool and your agent will start finding work.”
- **Empty, running workspace:** “You're all clear.”
- **Never:** claim work happened that did not.

### Ledger

- **Purpose:** show what the agent did, with the evidence, and let it be taken away.
- **Primary action:** Export.
- **Empty:** “No runs yet” + where to start one.

### Setup

- **Purpose:** what can reach the workspace, what may it spend, what may it do.
- **Primary action:** connect the agent.
- **Two screens.** `/setup` (**Access**) holds agent tokens and run-once, plus
  two disclosures collapsed by default — running it on Trevra's compute, and
  what it may spend — that open themselves when they already hold state.
  `/setup/workspace` (**Workspace**) holds Connections, Limits, LinkedIn
  exclusions and Team, plus an owner-only export/erase block, collapsed, at
  the foot.
- **Legacy subs redirect, not render.** `/setup/agent` and `/setup/spend` land
  on Access; `/setup/data`, `/setup/limits`, `/setup/team` and `/setup/skills`
  land on Workspace, the first three scrolled to their section; `/setup/reddit`
  and `/setup/research` go to Research; `/setup/seat` goes to Outreach.
  `/setup/team/:id` still renders the accept-invitation screen full-width, no
  tabs — the one address under Setup that is not one of the two screens.
- **One save per sitting:** a settings panel that asks for four separate saves is
  four round-trips and four toasts for one decision. Write only what changed,
  and name each part. The exceptions are the switches: an off switch that needs
  a second click to take effect is not an off switch.

## 8. First run, exactly

```
sign in
   └▶ Loop

      Get your first outcome working

      [ Win new business ]  [ Get paid for work ]

      Win new business
      ○ Add the LinkedIn account you will send from   [Add account]
      ○ Build one lead list                           [Build lead list]
      ○ Build one workflow                            [Build workflow]
      ○ Create your first campaign                    [Create campaign]

      — or —

      Get paid for work
      ○ Connect Claude Code or Codex                  [Connect agent]
      ○ Connect the source that knows what happened   [Connect data]
      ○ Bring in clients and agreements               [Bring in clients]
```

Only the selected outcome is expanded. Exactly one incomplete step gets the
primary action. Later steps remain visible so the sequence is understandable,
but the screen does not make seven things look equally urgent.

Every check mark is **derived from real data**: configured LinkedIn account,
saved lead list, saved workflow, campaign, live agent token, live non-demo data
connection, imported client. No `onboarding_completed` flag exists.

A recommendation is deliberately not a setup step. A system that found nothing
requiring a human decision is allowed to be healthy.

The user's selected first outcome may be stored as a local UI preference because
it asserts nothing about the business. It never completes a step.

The standing LinkedIn risk note is not a step either: there is no fake
"acknowledged" checkbox. The account screen continues to show the actual limits
and their evidence.
sign up
└▶ Loop, empty, with:

      Let's get you set up                        0 of 9

      Before anything goes out: read what you are betting →

      Start sending
      ○ Name your seat                   [Set it up]
      ○ Connect the seat                  [Connect]
      ○ Build one campaign               [Build one]
      ○ Preview the plan                  [Preview]
      ○ Approve and send            [Open the queue]

      Get paid for it
      ○ Connect Claude Code or Codex      [Connect]   ← first on this side, always
      ○ Connect your email or accounting  [Connect]
      ○ Bring in your clients              [Import]
      ○ Review what your agent found

```

Every step is **derived from real data** — a live seat, a live token, a live
connection, a real action in the ledger. No `onboarding_completed` flag, because
a stored flag drifts from reality and then lies. The card removes itself when the
work is genuinely done.

**Which half shows is derived too.** A seat exists → the outreach path. A
connection or a client exists → the money path. Neither → both, outreach first,
because the outreach engine is the product and somebody who signed up to send
LinkedIn messages should not be handed a checklist about accounting software.

One line in that card is **not** a step: *“read what you are betting”*. There is
nothing in the data to derive an acknowledgement from, and adding a stored
“acknowledged” flag is exactly what the paragraph above forbids. It is a
standing line, and it is first.

---

## 11. The invariant that does not bend

**No agent approves its own work.** Not the one on your laptop, not the one
Trevra hosts, not a future one that is very convincing.

`actions:prepare` is an agent scope. `approve` and `execute` deliberately are
not, and adding them is not a feature request — it is a redesign of the product’s
only real promise. Every external write goes through the hash-pinned approval
path: a human signs an exact payload, and a payload that changed afterwards is
rejected rather than sent.

This is the sentence to quote back at any proposal that would relax it.

---

## 9. Agent access is the most important button

The operator is an agent, so a workspace no agent can reach does nothing.

- One click mints the token **and** builds the exact command, host and secret
  already in it.
- Tabs for Claude Code and Codex. No hand-assembly from docs.
- Token names are generated. Never ask a human to invent one.
- Shown once, stored hashed — so the command is assembled in the browser at the
  only moment the secret exists.

---

## 10. Definition of done

- [x] Five nav items, one per loop stage, and nothing else in the nav.
- [x] A help entry point on every screen, and a keyboard shortcut sheet behind `?`.
- [x] A skip link, because five nav items and a sign-out precede the content.
- [x] One stop control, in the shell, naming every actor that can still act.
- [x] Agent access is the first thing in Setup and the first checklist step.
- [x] No raw JSON input anywhere a human goes. *(Three violations were found and
      removed: the policy conditions textarea, the playbook launcher's “Edit as
      JSON”, and the approval gate's payload dump.)*
- [x] Every screen has an empty state naming the next action.
- [x] No banned word in any human-facing string.
- [x] Developer tooling is out of the founder's nav. *(Publisher identity and
      release signing live in `npm run module` and the docs.)*
- [ ] A new workspace can reach “agent connected + tool connected” in under two
      minutes without reading documentation. **Not re-timed since the changes —
      the only box here still taken on faith.**

### Also true now, and worth stating

- Every run is inspectable to the node: input, output, evidence, the policy
  verdict in plain words, the signed payload hash, timing, and the error.
- One tool surface, three consumers — HTTP MCP, the stdio bridge, and the hosted
  loop all read `src/server/agent/tools.ts`. There is no second list to drift.
```
