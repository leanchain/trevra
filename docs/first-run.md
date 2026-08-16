# First run: choose one outcome, get to value

This is the current first-run contract for Trevra. It replaces the older lead-spine
plan that predated the shipped account scorer, managed LinkedIn campaigns, inbox,
agent access, hosted workspaces, and the five-screen GTM shell.

The rule is simple: **a new user chooses one outcome first. Trevra never asks them
to configure both halves of the product before either half becomes useful.**
Completion is derived from real server state. The choice of which outcome to work
on first is only a presentation preference.

## Step 0 — sign in

Hosted production uses Google OAuth. Self-hosted deployments may also enable
email/password auth. Authentication creates or resolves the workspace and lands on
`/loop`.

No provider connection, model key, LinkedIn password, campaign, or import is
required on the auth screen.

## Step 1 — choose the first outcome

The Loop asks one question:

- **Win new business** — get one outbound campaign ready.
- **Get paid for work** — connect commercial evidence and surface the first thing
  that needs a decision.

Only the selected checklist is expanded. The other outcome remains one click away.
The preference is remembered locally; it is not business state and it never marks a
step complete.

## Outcome A — win new business

Four verifiable steps, in order:

1. **Add the LinkedIn account you will send from** → `/outreach`
   - name the sending account;
   - set timezone, working days/hours and operator ceilings;
   - connect/sign in when the deployment supports browser execution.
2. **Build one lead list** → `/outreach/manager`
   - import people directly, or use `/outreach/leads` to turn a LinkedIn source
     into a reviewed list.
3. **Build one workflow** → `/outreach/manager`
   - view, invite, message, follow, wait, or stop for a manual message.
4. **Create the campaign** → `/outreach/manager`
   - pick one sending account, one lead list and one workflow;
   - creation sends nothing; Start is a separate decision.

The campaign screen repeats these prerequisites when there is no campaign yet and
highlights exactly one next step. This is deliberate redundancy: Loop answers
"what should I do next?" and Campaigns answers "what does this campaign still need?"
without requiring the user to remember the route they came from.

Every check mark is derived from stored objects: configured LinkedIn account, lead
list, workflow, campaign. There are no permanently-untracked circles.

### Related prospecting routes

- `/outreach/accounts` — **Target accounts**: ranked companies and the evidence
  behind their score. This used to be a sixth primary nav destination at `/leads`.
  `/leads` remains a compatibility alias and is replaced with this route.
- `/outreach/leads` — **Find people**: turn LinkedIn searches, posts or keyword
  sources into people, then save reviewed results into lead lists.

These are ways to produce campaign inputs, not primary app destinations.

## Outcome B — get paid for work

Three verifiable steps, in order:

1. **Connect Claude Code or Codex** → `/setup/agent`
   - Trevra creates the scoped token and the exact MCP command;
   - the agent may read and prepare but cannot approve or execute.
2. **Connect the source that knows what happened** → `/setup/data`
   - email/accounting through Nango, or another supported source.
3. **Bring in clients and agreements** → `/setup/data`
   - connected sync, agreement upload, marketplace CSV, or generic import.

Once these exist, setup is complete. Recommendations are an outcome of the system,
not an onboarding checkbox: a healthy workspace is allowed to have nothing that
needs approval.

## The recurring journey

After first run, the five primary destinations are stable:

1. **Loop** — where is the GTM loop stuck and what is the one next action?
2. **Outreach** — sending accounts, prospect inputs, campaigns and replies.
3. **Money** — prepared work at the paid end: agree, deliver, bill, collect.
4. **Ledger** — what agents and workflows actually did, with evidence.
5. **Setup** — access, integrations and limits that are changed occasionally.

A separate sixth nav item is a regression. A one-time configuration surface in
primary navigation is a regression.

## Failure and recovery rules

- A loading request gets a bounded stall state and a retry; no infinite spinner.
- A missing prerequisite says what is missing and links to the canonical screen
  that fixes it.
- A safety refusal is a decision with a reason, not a generic red error.
- Destructive operations explain what survives before confirmation.
- A legacy route is replaced, not duplicated into a second information
  architecture.
- Hosted capabilities that are not configured fail closed rather than presenting
  controls that can never work.

## What first run deliberately does not require

- Both product outcomes at once.
- A hosted model API key; BYO-agent remains the safer/default operator path.
- LinkedIn server-side automation on hosted deployments that do not have a remote
  browser provider.
- A recommendation to exist before setup can be considered complete.
- Raw IDs, token names, JSON, provider internals, or mechanics a machine can fill.

The implementation lives primarily in `src/client/views/LoopView.tsx`, the route
contract in `src/client/ui/route.ts`, and the local campaign prerequisite flow in
`src/client/LinkedInManagerRead.tsx`.
