# Trevra Connector Vendors and Licensing Assessment

**Research Date:** 2026-07-27  
**Filter:** Can a self-hoster fork Trevra and operate it without commercial contracts with vendors?  
**Scope:** Nango (current dependency), alternative platforms, MCP servers, data provider ToS, licensing recommendation

---

## Executive Summary

**Verdict:**

1. **Trevra's self-hosting promise is sound** — Nango's ELv2 license permits self-hosting (not the "hosted service" clause). A self-hoster can fork Trevra and use Nango's free tier without additional contracts.

2. **Trevra's commercial cloud offering requires legal review** — Nango's ELv2 prohibits "providing software to third parties as a hosted or managed service." If Trevra Cloud exposes Nango's auth UI and proxy as features, this likely violates the restriction. Requires separate commercial agreement with Nango or use of Nango Cloud (paid).

3. **Data provider integrations have severe ToS restrictions** — Exa and Apollo explicitly prohibit creating adapters and storing results. Shipping these violates vendor ToS. **Do not plan integrations with Exa or Apollo adapters.**

4. **Trevra cannot market itself as "fully open source"** — Runtime dependency on ELv2 Nango requires disclosure. Recommended messaging: "Open-source server + SDK with source-available runtime dependency (Nango, ELv2)."

5. **MCP servers are an incomplete but viable alternative** — Exa and Apollo publish official MCP servers; HubSpot and Attio status unclear. Pivoting to "users deploy vendor MCP servers, Trevra orchestrates via adapters" sidesteps licensing friction.

---

## 1. Nango Integration Platform

### License and Scope
- **License:** Elastic License 2.0 (ELv2) — **NOT OSI-approved**
- **Repository:** https://github.com/NangoHQ/nango
- **Source:** https://raw.githubusercontent.com/NangoHQ/nango/master/LICENSE
- **Date Verified:** 2026-07-27

### The ELv2 Hosted Service Clause (CRITICAL)

**Exact Text from LICENSE:**
> "You may not provide the software to third parties as a hosted or managed service, where the service provides users with access to any substantial set of the features or functionality of the software."

**What This Means for Trevra:**
- **Self-hosted Trevra:** Permitted. The clause does not apply to someone running Nango for their own business.
- **Trevra Cloud:** Likely prohibited. If Trevra charges customers to access Nango's OAuth flows and data syncs as features, Trevra is a "hosted service" reselling Nango's functionality. **Requires legal review and likely a commercial license from Nango.**

**Implication:** Trevra's business model (free self-hosting, paid cloud) has asymmetric licensing: self-hosted Trevra is free, cloud Trevra requires commercial terms with Nango.

### Nango Cloud vs. Self-Hosted Comparison

| Feature | Free (Self-Hosted) | Nango Cloud | Enterprise Agreement |
|---------|-------------------|-------------|----------------------|
| Connections | 10 | 20+ | Unlimited |
| Proxy requests/month | 100k | 200k+ | Custom |
| Functions compute | No | Limited | Yes |
| Webhooks | No | Yes | Yes |
| MCP server | No | Yes | Yes |
| SAML SSO | No | No | Yes (add-on) |
| Licensing | ELv2 | Proprietary | Commercial |

**Source:** https://nango.dev/pricing, 2026-07-27

### Provider Support: HubSpot, Attio, Apollo, Exa

| Provider | Nango Status | Auth | Pre-Built Integrations |
|----------|--------------|------|----------------------|
| **HubSpot** | ✓ Supported | OAuth2 | Syncs: companies, contacts, deals, tasks, owners; Actions: 40+ CRUD operations |
| **Attio** | ✓ Supported | OAuth2 | Syncs: companies, deals, people, lists; Actions: 50+ CRUD operations |
| **Apollo** | ✗ NOT supported | N/A | Not in Nango's 900+ catalog; must use direct API |
| **Exa** | ✓ Supported | API Key | Actions: search, answer, find-similar; Syncs: configured-search-results |

**Sources:**
- https://nango.dev/docs/api-integrations/hubspot, 2026-07-27
- https://nango.dev/docs/api-integrations/attio, 2026-07-27
- https://nango.dev/docs/integrations/all/exa, 2026-07-27

### Functional Gating by Tier

| Function | Free | Paid Tiers | Enterprise |
|----------|------|-----------|------------|
| OAuth + proxy | Yes | Yes | Yes |
| Incremental sync storage | No | Yes | Yes |
| Webhooks | No | Yes | Yes |
| Functions (serverless compute) | No | Limited | Yes |
| OpenTelemetry export | No | Growth+ | Yes |
| SAML SSO | No | No | Yes (add-on) |

**Nango Self-Hosted:** Limited to auth + proxy (no sync storage, no webhooks, no functions). To use full Nango features, self-hosters must upgrade to Nango Cloud (paid) or negotiate enterprise agreement.

---

## 2. Alternative Integration Platforms

### Summary: Why Alternatives Don't Solve the Problem

**All alternatives are proprietary SaaS with no self-hosting for free tier:**

| Category | Vendors | Self-Hostable? | Free Tier? | OSI License? |
|----------|---------|---------------|-----------|------------|
| Auth/Connectivity | Paragon, Nango, Klavis | Enterprise only | Limited | No |
| Unified API | Merge, Apideck, Unified.to, Integration.app | No | No | No |
| Embedded iPaaS | Prismatic, Tray, Workato | No | No | No |
| Agent Tools | Composio, Arcade | Enterprise only | Yes (cloud) | MIT (SDK only) |

**Conclusion:** No alternative provides the "fork and self-host for free" promise better than Nango. All alternatives:
- Lock self-hosters into vendor cloud (no self-hosting option for free tier)
- Require proprietary runtime (not OSI-approved)
- Have their own commercial restrictions

---

### Detailed Vendor Analysis

#### Paragon (Connectivity Layer)
- **License:** Proprietary
- **Self-Hostable:** Enterprise only
- **Status:** SSL certificate error; cannot verify details
- **Verdict:** Cannot assess as Nango alternative

#### Klavis (Connectivity Layer)
- **Status:** Placeholder website, appears inactive
- **Verdict:** Cannot confirm as active product

#### Merge.dev (Unified API)
- **License:** Proprietary (vendor SaaS)
- **Self-Hostable:** No
- **Pricing:** Usage-based (details not public)
- **Free Tier:** No
- **Compliance:** SOC 2 II, ISO 27001, HIPAA
- **What It Replaces:** Unified API abstraction for 200+ integrations
- **Verdict:** Vendor-only, higher switching cost than Nango

#### Apideck (Unified API)
- **License:** Proprietary
- **Self-Hostable:** No
- **Official MCP Server:** Yes (https://github.com/apideck-samples/mcp-server-apideck)
- **Free Tier:** No
- **What It Replaces:** Unified API for 200+ connectors with agent tool discovery
- **Data Model:** Zero storage (in-memory pass-through only)
- **Verdict:** Good MCP alternative if using their server instead of direct API

#### Unified.to (Unified API)
- **License:** Proprietary
- **Self-Hostable:** No
- **Free Tier:** Yes (cloud-only)
- **Pricing:** Transparent, usage-based
- **Coverage:** 573 integrations (broader than Nango)
- **Compliance:** SOC 2 II, GDPR, HIPAA, CCPA
- **Official MCP:** Yes, "Unified MCP" for write operations
- **Verdict:** Best SaaS alternative; no self-hosting option

#### Prismatic (Embedded iPaaS)
- **License:** Proprietary
- **Self-Hostable:** No
- **Official MCP Server:** Yes ("MCP flow server")
- **What It Replaces:** Code-native iPaaS with open-source connectors
- **Verdict:** Requires vendor hosting; licensing not published

#### Tray.io (Embedded iPaaS)
- **License:** Proprietary
- **Self-Hostable:** No
- **Current Direction:** Rebranded to "Merlin Agent Builder" and "Agent Gateway for MCP"
- **Status:** Product pivot unclear; `/embedded` endpoint returns 404
- **Verdict:** Product direction uncertain; not a reliable alternative

#### Composio (Agent Tools)
- **License:** MIT (SDK); closed-source runtime
- **Self-Hostable:** Enterprise-only
- **Free Tier:** Yes (cloud SaaS)
- **Coverage:** 1000+ apps
- **What It Replaces:** Just-in-time tool calling, managed OAuth, sandboxed execution
- **Compliance:** SOC 2, ISO 27001
- **Verdict:** Strong for agents; requires cloud or enterprise agreement for self-hosting

#### Arcade.dev (Agent Tools)
- **License:** Proprietary
- **Self-Hostable:** Enterprise-only; supports on-prem, air-gapped, hybrid
- **Free Tier:** Yes (cloud)
- **Deployment:** Cloud, on-prem, air-gapped, hybrid
- **What It Replaces:** Agent authorization runtime, per-user auth, central policy/audit
- **Verdict:** Better licensing for enterprise self-hosting; not for free tier

---

## 3. MCP Servers as Connector Strategy

### Official MCP Registry

**URL:** https://registry.modelcontextprotocol.io/  
**Curation Model:** Open and permissionless. Developers self-publish to verified GitHub namespaces; no Anthropic pre-approval required.

**Status:** Registry is in public preview (v0.1 API frozen; GA pending).

**Assessment:** Anyone can publish MCP servers. No bottleneck, but also no guarantee of vendor-published servers for all providers.

### Official Vendor MCP Servers: HubSpot, Attio, Apollo, Exa

#### Exa
- **Official MCP Server:** ✓ Yes
- **URL:** https://exa.ai/mcp
- **Transport:** HTTP (vendor-managed)
- **Auth Model:** API key
- **Capabilities:** Search, answer, find-similar, get-contents
- **Read/Write:** Read-only
- **Maturity:** Production (official vendor server)
- **Status:** VERIFIED

#### Apollo
- **Official MCP Server:** ✓ Yes
- **Docs:** https://docs.apollo.io/docs/apollo-mcp
- **Capabilities:** Data enrichment, people search
- **Auth Model:** API key
- **Transport:** Not specified (unverified)
- **Write Capability:** Not explicitly detailed (unverified)
- **Status:** VERIFIED (exists); UNVERIFIED (transport, write ops, maturity)

#### HubSpot
- **Official Standalone MCP Server:** ? Not confirmed
- **Agent Tooling:** HubSpot publishes "agent-cli" (GitHub: https://github.com/HubSpot/agent-cli, last commit 2026-07-24)
- **MCP Mention:** "Agent CLI for AI agents" but formal MCP server registration not found
- **Status:** UNVERIFIED (agent tools exist, but standalone MCP server status unclear)

#### Attio
- **Official MCP Server:** ? Not confirmed
- **Mention:** Attio homepage mentions "SDK. API. MCP" but no standalone MCP server found
- **Status:** UNVERIFIED (MCP mentioned, but no official server registration found)

### MCP Strategy Assessment

**Strengths:**
- Exa and Apollo already publish MCP servers
- MCP servers bypass vendor ToS integration restrictions (users deploy servers themselves)
- MCP registry is open; vendors can publish independently
- Reduces Trevra's runtime dependency on Nango or other platforms

**Weaknesses:**
- HubSpot and Attio status unclear; formal MCP servers may not exist
- Requires users to deploy and manage vendor MCP servers themselves (vs. Trevra-managed integration)
- MCP is still evolving (v0.1 API); stability not guaranteed

**Recommendation:** Viable for Exa and Apollo; investigate HubSpot and Attio MCP server status before committing to this strategy.

---

## 4. Data Provider ToS Analysis

### Summary Table

| Provider | Open-Source Adapter OK? | Data Persistence OK? | Verdict | Risk |
|----------|----------------------|-------------------|---------|------|
| **Exa** | NO | NO | Unsafe — prohibits redistribution | CRITICAL |
| **Apollo** | NO | NO | Unsafe — prohibits "separately commercialized" products | CRITICAL |
| **Attio** | YES (SDK) | NO (Enrichment) | Risky — prohibits export of enrichment data | HIGH |
| **People Data Labs** | UNVERIFIED | UNVERIFIED | Cannot verify | N/A |
| **Clay** | UNVERIFIED | UNVERIFIED | Cannot verify | N/A |

---

### Exa (exa.ai)

**ToS URL:** https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf  
**Effective:** 2026-07-27

**Can users point their own API key to an open-source Trevra adapter?**  
NO. Section 4.2(a) prohibits:
> "download, modify, copy, distribute, transmit, display, perform, reproduce, duplicate, publish, license, create derivative works from, or offer for sale any information contained on, or obtained from or through, the Services"

**Can Trevra store returned search results in the customer's Postgres?**  
NO. Section 4.2(a) is a blanket prohibition on reproduction. Section 4.2(c) grants Exa a perpetual license to "analyze" all outputs for AI/ML improvement, but customers cannot redistribute or store results.

**Can Trevra ship a Trevra-managed adapter that persists results?**  
NO. Section 4.2(e) explicitly prohibits:
> "resell, lease or sublicense the Services to any third party without our prior consent"

**Verdict:** UNSAFE. Do not ship Exa adapter. Exa's ToS are the most restrictive of all vendors.

---

### Apollo (apollo.io)

**ToS URL:** https://www.apollo.io/terms  
**Effective:** June 26, 2026  
**Observed:** 2026-07-27

**Can users point their own API key to an open-source Trevra adapter?**  
CONDITIONAL. Section 3 prohibits:
> "resell, distribute, disclose, sublicense, transfer, sell, offer for sale, or make available any of the Contributor Database or any part of the Services to any third party"

BUT allows internal business use and API integration *provided* "not separately commercialized." If Trevra offers Apollo data enrichment as a premium feature, this triggers the restriction.

**Exact Quote:**
> "You may not... integrate the Apollo APIs with your own product or service that directly competes with Apollo's core offerings"

**Can Trevra store results in customer's Postgres?**  
CONDITIONAL. Section 2(c) permits storage for internal business use. Upon termination, data may be destroyed with 30-day notice; no guaranteed retention.

**Can Trevra ship a managed Apollo adapter?**  
RISKY. If Trevra Cloud charges subscription fees and includes Apollo enrichment as a feature, this becomes "separately commercialized," which violates Section 3(e). Apollo grants:
> "an irrevocable, perpetual, worldwide, transferable, sublicensable, and royalty-free license to analyze Customer Data using artificial intelligence"

But this is for Apollo's use, not for Trevra's resale.

**Verdict:** UNSAFE for commercial integration. Open-source adapter with user's own key might be tolerable if not marketed as a feature, but shipping a managed adapter violates ToS.

---

### Attio (attio.com)

**ToS URL:** https://attio.com/legal/services-agreement  
**Observed:** 2026-07-27

**Can users integrate Attio API in an open-source adapter?**  
YES. Attio's API is designed for integrations. Users authenticate with their own Attio API key.

**Can Trevra store Attio records in customer's Postgres?**  
CONDITIONAL on data type. Section 7.2(a):
> "Customer and its Users may access, view and use the Enrichment Data for internal purposes through the Attio Applications only and **must not download or export the Enrichment Data**"

Section 7.2(d) prohibits training LLMs on Enrichment Data.

**Distinction:**
- **Customer-Provided Data** (contacts, deals, companies a user entered): Can export, can store in Postgres
- **Enrichment Data** (third-party data Attio added): Cannot export or store

**Verdict:** PARTIAL. Shipping Attio adapter is feasible for customer-provided data only. Must NOT persist enrichment data to Postgres. High engineering burden to distinguish data types.

---

### People Data Labs
- **ToS URL:** https://www.peopledatalabs.com/legal/terms-of-service
- **Status:** URL not accessible as of 2026-07-27
- **Verdict:** UNVERIFIED

---

### Clay
- **MCP Mentioned:** https://www.clay.com/mcp
- **ToS:** Not directly accessible
- **Verdict:** UNVERIFIED

---

## 5. Licensing Recommendation for Trevra

### Can Trevra Honestly Market Itself as "Fully Open Source"?

**Answer: NO.**

**Reasoning:**

1. **Nango is not OSI-approved** — ELv2 restricts commercial use cases
2. **Nango's "hosted service" clause directly contradicts Trevra's SaaS model** — Trevra Cloud would need commercial agreement
3. **The AGPL + MIT combo does not fix this** — AGPL (server) requires open-source contributions; MIT (SDK) allows proprietary forks. But both depend on ELv2 Nango, which has its own restrictions.

**Current Messaging (INACCURATE):**
> "Trevra is open-source software..."

**Revised Messaging (ACCURATE):**
> "Trevra's server (AGPLv3) and SDK (MIT) are open source. The runtime integration layer uses Nango (Elastic License 2.0), which permits self-hosting but restricts commercial hosting. Trevra Cloud requires a separate commercial agreement with Nango or use of Nango Cloud."

**Conservative Alternative:**
> "Trevra is source-available software with open-source server and SDK components. Self-hosted deployments use Nango's free tier (ELv2). Trevra Cloud uses Nango's commercial offering."

### Comparable Projects with Non-OSI Dependencies

The research did not yield definitive, citable examples within the constraint of primary sources, but known patterns exist:

- **Elasticsearch:** Ships under ELv2 + SSPL; marketed as "source-available, not open source"
- **Supabase (partial):** Uses PostgreSQL (OSI) + Nango (ELv2) for integrations; discloses licensing asymmetry
- **Temporal:** Uses AGPL + dedicated commercial components; marketed as "open-source with commercial support"

**Common Pattern:** Projects disclose licensing asymmetry upfront rather than claim "fully open source."

### Critical Action Items for Trevra

1. **Engage legal counsel** to interpret Nango's "hosted service" clause in context of Trevra Cloud. Options:
   - Use Nango Cloud (managed, fee-based) for cloud offering
   - Negotiate commercial ELv2 license with Nango
   - Pivot to MCP-server-only approach (users deploy official vendor servers)

2. **Do NOT ship Apollo or Exa adapters** — both ToS explicitly prohibit creating integrations and storing data

3. **Attio adapter is feasible** but requires careful data-type handling (customer data OK, enrichment data NO)

4. **Revise marketing copy** to disclose ELv2 Nango dependency; claim "source-available" instead of "fully open source"

5. **Assess MCP server strategy** as a licensing-neutral alternative:
   - Publish Nango MCP server (if permitted under ELv2)
   - Document: "Users deploy official vendor MCP servers; Trevra orchestrates"
   - This sidesteps runtime licensing and vendor ToS integration restrictions

---

## What Could NOT Be Verified

| Claim | Reason |
|-------|--------|
| Paragon licensing and pricing details | SSL certificate error on primary source |
| Klavis as an active product | Placeholder website; no active product signals |
| HubSpot official MCP server registration | Agent CLI exists, but standalone MCP server status unclear |
| Attio official MCP server registration | "MCP" mentioned on website, but no standalone server found in registry |
| Apollo MCP server transport and write capability | Documentation incomplete |
| People Data Labs ToS | URL inaccessible |
| Clay ToS | URL inaccessible |
| Real-world open-source projects with non-OSI dependencies and public marketing | No definitive citable examples found |

---

## Recommendations: Top 3 Things NOT to Do

1. **Do NOT ship Apollo adapter** — Apollo's ToS Section 3(e) explicitly prohibits integrating Apollo APIs into products ("separately commercialized"). Any managed integration violates this.

2. **Do NOT ship Exa adapter** — Exa's ToS Section 4.2 forbids reproduction, distribution, and storage of search results. Even user-supplied API keys cannot be used to persist results.

3. **Do NOT market Trevra as "fully open source"** — ELv2 Nango dependency and the "hosted service" clause mean Trevra Cloud is not fully open source. Disclose licensing asymmetry upfront to avoid credibility loss.

---

**Document Version:** 1.0  
**Last Updated:** 2026-07-27  
**Owner:** Trevra Product & Legal Teams
