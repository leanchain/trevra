# Discoverability and launch checklist

Trevra ships a crawlable initial document plus runtime-generated canonical metadata. The public surface includes:

- `/` — product and workspace entry;
- `/how-it-works` — substantive product explanation;
- `/security`, `/privacy`, `/terms`;
- `/robots.txt` and `/sitemap.xml`;
- `/llms.txt`, `/llms-full.txt`, `/agents.md`, `/humans.txt`;
- `/.well-known/security.txt` under RFC 9116;
- Open Graph, Twitter Card, Web App Manifest, icons, and JSON-LD;
- a root IndexNow key file when `INDEXNOW_KEY` is set;
- cookieless first-party attribution and aggregate traction reporting.

`llms.txt` and public `agents.md` are emerging conventions, not guaranteed ranking mechanisms. They complement crawlable HTML, canonical URLs, structured data, and sitemaps.

## Required production configuration

```env
PUBLIC_SITE_URL=https://your-final-domain.example
PUBLIC_SUPPORT_EMAIL=support@your-final-domain.example
SECURITY_CONTACT_EMAIL=security@your-final-domain.example
PUBLIC_LEGAL_NAME=Your legal operating name
MARKETING_HASH_SALT=<at least 32 random characters>
TRACTION_ADMIN_TOKEN=<at least 32 random characters>
INDEXNOW_KEY=<8-128 URL-safe characters>
GOOGLE_SITE_VERIFICATION=<optional Search Console token>
BING_SITE_VERIFICATION=<optional Bing Webmaster token>
```

Terraform generates the marketing salt, traction token, and IndexNow key. Support and security addresses must route to monitored inboxes.

## Search engine launch

1. Map the final HTTPS custom domain before deployment.
2. Set `PUBLIC_SITE_URL`, `APP_ORIGIN`, and `BETTER_AUTH_URL` to the same canonical origin.
3. Verify `/robots.txt`, `/sitemap.xml`, the public pages, and the social image on the final domain.
4. Add the site to Google Search Console and submit `/sitemap.xml`.
5. Add the site to Bing Webmaster Tools and configure `BING_SITE_VERIFICATION` if using meta verification.
6. Run `npm run seo:submit` with `PUBLIC_SITE_URL` and `INDEXNOW_KEY` after material public-page changes.
7. Validate the homepage JSON-LD with Google’s Rich Results Test. Trevra uses honest `Organization`, `WebSite`, `WebApplication`, and visible FAQ markup; it does not fabricate ratings or reviews.
8. Test the Open Graph image with the sharing debuggers used by the networks where the product will be posted.
9. Confirm the Cloud Monitoring email notification channel. Terraform checks `/api/health` every five minutes and alerts when checks fail for five minutes or the TLS certificate has fewer than 15 days remaining.

## Traction after launch

The client honors Do Not Track and Global Privacy Control. It sends no IP address or client content. A session-scoped random identifier is salted and hashed on the server.

Run a database report:

```bash
DATABASE_URL='postgresql://...' npm run traction:report -- --days=90
```

Or query the aggregate endpoint:

```bash
curl -H "Authorization: Bearer $TRACTION_ADMIN_TOKEN" \
  "https://your-domain.example/api/internal/traction?days=90"
```

The funnel reports page views, signup intent, completed workspaces, integration starts, and executed actions, with referral and UTM source summaries.

## Legal and operational review

The included privacy and terms pages are conservative baseline product copy, not jurisdiction-specific legal advice. Review the operating entity name, contact details, payment terms, governing law, data-processing agreements, cookie/analytics obligations, and regulated-market requirements before accepting paid users.
