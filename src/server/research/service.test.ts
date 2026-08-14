import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `research_source_documents` is a pure join table -- `(source_id, document_id)`
 * and nothing else -- so until 058 it had no way to say which tenant a link
 * belonged to, and every read of it was a read by parent id alone. The two
 * things that matters for are the corpus size a founder sees on their source
 * list, and which documents a `sourceId`-filtered search returns.
 *
 * The column is nullable at this stage, so the write test asserts the value the
 * sync wrote, not NOT NULL.
 */
const nangoGet = vi.hoisted(() => vi.fn());
vi.mock('../integration-service.js', () => ({ getNango: () => ({ get: nangoGet }) }));

const { id, openDatabase } = await import('../db.js');
const { listResearchSources, saveResearchSource, searchResearchCorpus, syncResearchSource } = await import('./service.js');

type Database = Awaited<ReturnType<typeof openDatabase>>;

let db: Database | undefined;
const createdWorkspaces: string[] = [];

afterEach(async () => {
  nangoGet.mockReset();
  if (db) {
    for (const workspaceId of createdWorkspaces.splice(0)) {
      await db.prepare('DELETE FROM workspaces WHERE id=?').run(workspaceId);
    }
    await db.close();
    db = undefined;
  }
});

async function openTestDb(): Promise<Database> {
  db = await openDatabase({ connectionString: process.env.TEST_DATABASE_URL, seedDemo: false });
  return db;
}

/** A tenant with one connected Reddit connection, ready for `saveResearchSource`. */
async function seedTenant(database: Database, label: string): Promise<{ workspaceId: string; connectionId: string }> {
  const now = new Date().toISOString();
  const workspaceId = id('ws');
  const connectionId = id('conn');
  createdWorkspaces.push(workspaceId);
  await database.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(workspaceId, label, now);
  await database.prepare(`
    INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(connectionId, workspaceId, 'reddit', 'reddit', `${connectionId}-external`, label, 'connected', 0, now, now);
  return { workspaceId, connectionId };
}

async function seedDocument(database: Database, workspaceId: string, externalId: string, title: string): Promise<string> {
  const now = new Date().toISOString();
  const documentId = id('rdoc');
  await database.prepare(`
    INSERT INTO research_documents (id,workspace_id,provider,external_id,document_type,community,title,content,source_url,content_hash,first_seen_at,last_seen_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(documentId, workspaceId, 'reddit', externalId, 'post', 'saas', title, 'Body text', `https://example.test/${externalId}`, externalId, now, now, now);
  return documentId;
}

describe('workspace attribution on research source documents', () => {
  it('stamps the source\'s workspace on every join row the sync writes', async () => {
    const database = await openTestDb();
    const tenant = await seedTenant(database, 'Syncing tenant');
    const source = await saveResearchSource(database, tenant.workspaceId, {
      name: 'SaaS watch',
      connectionId: tenant.connectionId,
      subreddits: ['saas'],
      queries: [],
      includeComments: false,
      maxPostsPerRun: 10,
      maxCommentsPerPost: 0,
      maxPagesPerRun: 1,
      pollIntervalMinutes: 60,
      enabled: true
    });

    nangoGet.mockResolvedValue({
      data: {
        data: {
          after: null,
          children: [{
            kind: 't3',
            data: {
              id: 'post1', subreddit: 'saas', title: 'Looking for a tool', selftext: 'We need help.',
              permalink: '/r/saas/comments/post1/looking', author: 'someone', score: 12, num_comments: 0,
              created_utc: 1_700_000_000, upvote_ratio: 0.95
            }
          }]
        }
      }
    });

    const result = await syncResearchSource(database, tenant.workspaceId, source.id);
    expect(result.inserted).toBe(1);

    const links = await database.prepare('SELECT workspace_id FROM research_source_documents WHERE source_id=?')
      .all<{ workspace_id: string | null }>(source.id);
    expect(links.length).toBe(1);
    expect(links[0].workspace_id).toBe(tenant.workspaceId);
  });

  it('ignores a join row attributed to another workspace when counting and when searching by source', async () => {
    const database = await openTestDb();
    const stranger = await seedTenant(database, 'Stranger tenant');
    const owner = await seedTenant(database, 'Owning tenant');
    const now = new Date().toISOString();
    const source = await saveResearchSource(database, owner.workspaceId, {
      name: 'Owned watch',
      connectionId: owner.connectionId,
      subreddits: ['saas'],
      queries: [],
      includeComments: false,
      maxPostsPerRun: 10,
      maxCommentsPerPost: 0,
      maxPagesPerRun: 1,
      pollIntervalMinutes: 60,
      enabled: true
    });

    const linked = await seedDocument(database, owner.workspaceId, 'owned1', 'Genuinely linked');
    const smuggled = await seedDocument(database, owner.workspaceId, 'owned2', 'Linked by a foreign row');
    await database.prepare('INSERT INTO research_source_documents (workspace_id,source_id,document_id,matched_queries,discovered_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run(owner.workspaceId, source.id, linked, [], now, now);
    // Same source, same tenant's document -- but the LINK claims to belong to
    // the stranger. `sd.source_id=?` alone could not tell the two rows apart.
    await database.prepare('INSERT INTO research_source_documents (workspace_id,source_id,document_id,matched_queries,discovered_at,last_seen_at) VALUES (?,?,?,?,?,?)')
      .run(stranger.workspaceId, source.id, smuggled, [], now, now);

    const sources = await listResearchSources(database, owner.workspaceId);
    expect(sources.find((row) => row.id === source.id)?.documents).toBe(1);

    const found = await searchResearchCorpus(database, owner.workspaceId, { sourceId: source.id });
    expect(found.map((row) => String(row.id))).toEqual([linked]);
    expect(found.map((row) => String(row.id))).not.toContain(smuggled);
  });
});
