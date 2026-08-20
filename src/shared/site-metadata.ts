/**
 * One source of truth for site copy and structured data.
 *
 * Dependency-free: no node builtins, no express, no db, no React. Imported by
 * the client bundle, the Express server, and tsx build scripts alike.
 */

export const SITE_NAME = 'Trevra';
export const SITE_TITLE = 'Trevra — GTM infrastructure for AI agents';
export const SITE_DESCRIPTION =
  'Trevra is open-source GTM infrastructure for Claude Code and Codex. Agents do the work, external actions require approval, and every run is logged.';

export const SOCIAL_IMAGE = {
  path: '/og/trevra-social.png',
  width: 1200,
  height: 630,
  alt: 'Trevra — GTM infrastructure for AI agents'
} as const;

export const PUBLIC_PATHS = ['/', '/how-it-works', '/security', '/privacy', '/terms'] as const;

export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: ReadonlyArray<FaqItem> = [
  {
    question: 'How do I use Trevra?',
    answer:
      'Point Claude Code or Codex at a Trevra workspace. The agent calls typed modules for research, drafting, and outreach, and Trevra records every run and holds anything that leaves the workspace.'
  },
  {
    question: 'Can an agent send messages on its own?',
    answer:
      'Only inside the policy you set. External actions require approval by default, and the approved payload is hashed before execution, so a modified payload is rejected.'
  },
  {
    question: 'How are modules shared safely?',
    answer:
      'Modules are versioned on GitHub and declare their input and output schemas, side-effect class, and approval requirement. Installing one never grants it permission to write externally.'
  },
  {
    question: 'Can I self-host Trevra?',
    answer:
      'Yes. Trevra runs on your own PostgreSQL, the module runner is open source, and the ledger, evidence, and configuration stay in infrastructure you control.'
  }
];

export interface StructuredDataConfig {
  origin: string;
  name: string;
  legalName: string;
  description: string;
  supportEmail: string;
  /** '' when this deployment has no GitHub URL to link to. */
  githubUrl: string;
}

/**
 * The `@graph` served in the JSON-LD block: Organization, WebSite,
 * WebApplication, and FAQPage, sharing the same `@id` shape used everywhere
 * on the site.
 */
export function buildStructuredData(config: StructuredDataConfig) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${config.origin}/#organization`,
        name: config.legalName,
        url: config.origin,
        email: config.supportEmail,
        logo: {
          '@type': 'ImageObject',
          url: `${config.origin}/icons/trevra-512.png`,
          width: 512,
          height: 512
        },
        ...(config.githubUrl ? { sameAs: [config.githubUrl] } : {})
      },
      {
        '@type': 'WebSite',
        '@id': `${config.origin}/#website`,
        url: config.origin,
        name: config.name,
        description: config.description,
        publisher: { '@id': `${config.origin}/#organization` },
        inLanguage: 'en'
      },
      {
        '@type': 'WebApplication',
        '@id': `${config.origin}/#application`,
        name: config.name,
        url: config.origin,
        description: config.description,
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript and a modern web browser',
        featureList: [
          'Typed, versioned GTM modules for Claude Code and Codex',
          'Public GitHub-synced module catalog',
          'Approval gate on every external action',
          'Cryptographic payload hashing between approval and execution',
          'Full run history with recorded inputs, outputs, and evidence',
          'Open source and self-hostable on your own PostgreSQL'
        ],
        publisher: { '@id': `${config.origin}/#organization` }
      },
      {
        '@type': 'FAQPage',
        mainEntity: FAQ_ITEMS.map(({ question, answer }) => ({
          '@type': 'Question',
          name: question,
          acceptedAnswer: { '@type': 'Answer', text: answer }
        }))
      }
    ]
  };
}

export interface WebPageStructuredDataConfig {
  origin: string;
  path: string;
  title: string;
  description: string;
}

export function buildWebPageStructuredData(config: WebPageStructuredDataConfig) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: config.title,
    description: config.description,
    url: `${config.origin}${config.path}`,
    isPartOf: { '@id': `${config.origin}/#website` },
    about: { '@id': `${config.origin}/#application` }
  };
}
