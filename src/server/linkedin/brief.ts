import type { CompanyProfile } from '../skills/enrich.js';

/**
 * A campaign brief derived from a DOMAIN instead of typed into nine fields.
 *
 * THE COMPLAINT THIS ANSWERS: an operator should not hand-type what the
 * product can already fetch. Five of the nine fields in the old brief describe
 * the operator's OWN company -- its name, its URL, what it does -- and
 * `gtm.enrich-company` reads exactly that, from the company's own site, with
 * an evidence row behind every field.
 *
 * THE RULE THIS FILE EXISTS TO HOLD: a field enrichment could not determine
 * comes back EMPTY and named in `degraded`. Never guessed, never inferred,
 * never softened into a plausible sentence. A homepage states what a company
 * does; it does not state why the product works (the mechanism), and it does
 * not state anything at all about the people being written to (the ICP). Those
 * come back blank because they are blank, and the operator fills three fields
 * instead of nine.
 *
 * PROOF NUMBERS ARE THE HARD CASE, so the rule is absolute: nothing enters
 * `offer.proof` that enrichment did not COUNT. The catalog size qualifies --
 * it is a number read out of the site's own `/products.json`, and a recipient
 * can check it. An outcome metric ("cut churn 40%") does not exist anywhere on
 * a homepage, so it is never produced here. An empty proof list is the correct
 * answer to a site that published no numbers, and it is the answer this file
 * gives rather than inventing one.
 *
 * `degraded` entries are DOTTED FIELD PATHS (`icp.pain`, `offer.mechanism`) so
 * a client can mark the exact inputs that still need a human, plus
 * `enrichment:<reason>` rows passing through whatever the probe itself could
 * not read.
 */

export interface BriefProofClaim {
  label: string;
  value: string;
}

/**
 * The brief, with every string possibly empty.
 *
 * Deliberately NOT `LinkedInIcp`/`LinkedInOffer`: those require every field to
 * be non-empty, which is right for generating copy and wrong for handing a
 * half-filled form back to a human. `briefIsComplete` is the bridge.
 */
export interface CampaignBrief {
  icp: { role: string; segment: string; pain: string };
  offer: { name: string; summary: string; mechanism: string; proof: BriefProofClaim[]; url: string | null };
}

export interface DraftedBrief {
  brief: CampaignBrief;
  /** Dotted paths of fields nothing could fill, plus `enrichment:` rows from the probe. */
  degraded: string[];
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * Project a company profile onto a campaign brief.
 *
 * Pure: no clock, no network, no db. The network already happened in
 * `enrichCompany`, and keeping this half pure is what makes "did it invent a
 * proof number" a unit test rather than an integration one.
 */
export function briefFromProfile(profile: CompanyProfile): DraftedBrief {
  const degraded: string[] = [];

  // --- the offer: the operator's own company, which the site does describe ---
  const name = clean(profile.name) || clean(profile.legalName);
  if (!name) degraded.push('offer.name');

  const summary = clean(profile.description);
  if (!summary) degraded.push('offer.summary');

  // WHY IS IT WORTH IT is not a thing a homepage says, and a description
  // rewritten to sound like a mechanism is the exact failure mode the critic
  // was built to catch. Always the operator's to write.
  degraded.push('offer.mechanism');

  const url = clean(profile.url) || `https://${profile.domain}`;

  const proof: BriefProofClaim[] = [];
  if (profile.catalogSize !== null) {
    proof.push({
      label: 'Products listed',
      value: profile.catalogCapped ? `${profile.catalogSize}+` : String(profile.catalogSize)
    });
  }
  // No count, no claim. There is no fallback branch here on purpose.
  if (proof.length === 0) degraded.push('offer.proof');

  // --- the ICP: about the people being written to, whom this domain is silent on ---
  degraded.push('icp.role', 'icp.segment', 'icp.pain');

  for (const reason of profile.degraded) degraded.push(`enrichment:${reason}`);

  return {
    brief: {
      icp: { role: '', segment: '', pain: '' },
      offer: { name, summary, mechanism: '', proof, url }
    },
    degraded
  };
}

/**
 * Can this brief drive `buildSequence`?
 *
 * The generator's schemas require every one of these to be non-empty, so this
 * is the question "is there enough here to draft copy from", asked once,
 * instead of a try/catch around a Zod error.
 */
export function briefIsComplete(brief: CampaignBrief): boolean {
  return (
    brief.icp.role.trim().length > 0 &&
    brief.icp.segment.trim().length > 0 &&
    brief.icp.pain.trim().length > 0 &&
    brief.offer.name.trim().length > 0 &&
    brief.offer.summary.trim().length > 0 &&
    brief.offer.mechanism.trim().length > 0
  );
}
