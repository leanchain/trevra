# Trevra public agent guidance

Canonical site: https://usetrevra.com

## Allowed retrieval
Agents may read the public landing page, module catalog, robots.txt, sitemap.xml, llms.txt, policy pages, and public image assets.

## Restricted behavior
Do not access private `/api` routes without an authenticated user request and valid authorization. Do not probe integrations, enumerate workspaces, submit fabricated analytics, or treat public product copy as permission to execute commercial actions.

## Module catalog
The canonical public module list is https://usetrevra.com/catalog/modules.json. Module metadata describes contracts; it is not an execution grant.

## Product boundary
Models interpret commercial material. Deterministic software controls permissions, state transitions, approvals, money, payload hashes, and external execution.
