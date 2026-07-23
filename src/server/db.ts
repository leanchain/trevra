import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg, { type PoolClient, type QueryResultRow } from 'pg';

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1700, (value) => Number(value));
types.setTypeParser(1114, (value) => value);
types.setTypeParser(1184, (value) => value);

export const DEMO_WORKSPACE_ID = 'ws_demo';
export const DEMO_USER_ID = 'usr_demo';

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<T>>;
}

export class Db {
  constructor(
    private readonly queryable: Queryable,
    private readonly pool: InstanceType<typeof Pool> | null = null
  ) {}

  prepare(sql: string) {
    const text = normalizeSql(sql);
    return {
      get: async <T extends QueryResultRow = QueryResultRow>(...params: unknown[]): Promise<T | undefined> => {
        const result = await this.queryable.query<T>(text, params);
        return result.rows[0];
      },
      all: async <T extends QueryResultRow = QueryResultRow>(...params: unknown[]): Promise<T[]> => {
        const result = await this.queryable.query<T>(text, params);
        return result.rows;
      },
      run: async (...params: unknown[]): Promise<{ changes: number }> => {
        const result = await this.queryable.query(text, params);
        return { changes: result.rowCount ?? 0 };
      }
    };
  }

  async exec(sql: string): Promise<void> {
    await this.queryable.query(sql);
  }

  async transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.pool) throw new Error('Transactions can only be started from a pooled database handle');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new Db(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }

  getPool(): InstanceType<typeof Pool> {
    if (!this.pool) throw new Error('Pool is unavailable inside a transaction');
    return this.pool;
  }
}

export async function openDatabase(options: {
  connectionString?: string;
  seedDemo?: boolean;
  maxConnections?: number;
} = {}): Promise<Db> {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required; Trevra only supports PostgreSQL');

  const pool = new Pool({
    connectionString,
    max: options.maxConnections ?? Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.DATABASE_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 10_000),
    statement_timeout: Number(process.env.DATABASE_STATEMENT_TIMEOUT_MS ?? 30_000),
    application_name: process.env.DATABASE_APPLICATION_NAME ?? 'trevra'
  });
  pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error', error));
  const db = new Db(pool, pool);
  await migrate(db);
  if (options.seedDemo ?? process.env.NODE_ENV !== 'production') await seedDemo(db);
  return db;
}

async function migrate(db: Db): Promise<void> {
  const migrationDir = resolve(process.env.MIGRATIONS_PATH ?? 'migrations');
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  await db.transaction(async (tx) => {
    await tx.prepare("SELECT pg_advisory_xact_lock(hashtext('trevra-schema-migrations'))").get();
    await tx.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const name of files) {
      const existing = await tx.prepare('SELECT name FROM schema_migrations WHERE name=?').get<{ name: string }>(name);
      if (existing) continue;
      const sql = await readFile(resolve(migrationDir, name), 'utf8');
      await tx.exec(sql);
      await tx.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    }
  });
}

async function seedDemo(db: Db): Promise<void> {
  const existing = await db.prepare('SELECT id FROM workspaces WHERE id=?').get<{ id: string }>(DEMO_WORKSPACE_ID);
  if (existing) return;
  const now = new Date();
  const iso = (daysAgo = 0) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(DEMO_WORKSPACE_ID, 'Northstar Studio', iso(90));
    await tx.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)').run(DEMO_USER_ID, DEMO_WORKSPACE_ID, 'alex@northstar.studio', 'Alex Morgan', iso(90));
    await tx.prepare('INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(DEMO_WORKSPACE_ID, 'EUR', 'Alex', 'Europe/Zurich', 1, iso(90), iso());
    await tx.prepare('INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_synced_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('conn_demo_gmail', DEMO_WORKSPACE_ID, 'gmail', 'google-mail', 'demo-gmail', 'alex@northstar.studio', 'connected', 1, iso(), iso(90), iso());

    const clients = [
      ['cl_acme', 'Acme Labs', 'Maya Chen', 'maya@acme.example', 'active', 15000, 'EUR', iso(1)],
      ['cl_orbit', 'Orbit Health', 'Jonas Keller', 'jonas@orbit.example', 'prospect', 8000, 'EUR', iso(9)],
      ['cl_luma', 'Luma Works', 'Sofia Rossi', 'sofia@luma.example', 'active', 7200, 'EUR', iso(4)]
    ] as const;
    for (const client of clients) {
      await tx.prepare('INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(client[0], DEMO_WORKSPACE_ID, client[1], client[2], client[3], client[4], client[5], client[6], client[7], iso(80));
      await tx.prepare('INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id('ident'), DEMO_WORKSPACE_ID, client[0], 'email', 'email', client[3], iso(80));
    }

    await tx.prepare('INSERT INTO opportunities (id,workspace_id,client_id,title,value,currency,status,proposal_sent_at,expected_response_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('opp_orbit', DEMO_WORKSPACE_ID, 'cl_orbit', 'Brand strategy engagement', 8000, 'EUR', 'proposal_sent', iso(9), iso(5), iso(14));
    await tx.prepare('INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('prj_acme', DEMO_WORKSPACE_ID, 'cl_acme', 'Acme website launch', 'active', 15000, 'EUR', iso(50));
    await tx.prepare('INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('prj_luma', DEMO_WORKSPACE_ID, 'cl_luma', 'Luma positioning sprint', 'delivered', 7200, 'EUR', iso(35));
    await tx.prepare('INSERT INTO contracts (id,workspace_id,client_id,project_id,title,status,signed_at,effective_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('contract_acme', DEMO_WORKSPACE_ID, 'cl_acme', 'prj_acme', 'Acme website statement of work', 'signed', iso(52), iso(50), iso(52));
    await tx.prepare('INSERT INTO contract_clauses (id,contract_id,clause_type,title,content,value_number,unit,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('clause_acme_revision', 'contract_acme', 'change_order', 'Additional deliverables', 'Additional pages and deliverables require written approval and are priced separately.', 750, 'per landing page', iso(52));
    await tx.prepare('INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)').run('scope_acme_1', 'prj_acme', 'One homepage and one product landing page', 1, null, iso(50));
    await tx.prepare('INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)').run('scope_acme_2', 'prj_acme', 'Additional landing pages priced separately', 0, 750, iso(50));
    await tx.prepare('INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)').run('scope_luma_1', 'prj_luma', 'Positioning workshop and final strategy deck', 1, null, iso(35));
    await tx.prepare('INSERT INTO milestones (id,project_id,name,amount,currency,status,delivered_at,invoiced_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('mil_luma_final', 'prj_luma', 'Final strategy delivery', 2400, 'EUR', 'delivered', iso(2), null, iso(35));
    await tx.prepare('INSERT INTO deliverables (id,workspace_id,project_id,name,status,delivered_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('del_luma_deck', DEMO_WORKSPACE_ID, 'prj_luma', 'Final positioning deck', 'delivered', iso(2), iso(35));
    await tx.prepare('INSERT INTO invoices (id,workspace_id,client_id,project_id,external_ref,amount,currency,status,issued_at,due_at,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('inv_acme_104', DEMO_WORKSPACE_ID, 'cl_acme', 'prj_acme', 'INV-104', 1850, 'EUR', 'sent', iso(25), iso(7), null, iso(25));
    await tx.prepare('INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('msg_acme_extra', DEMO_WORKSPACE_ID, 'cl_acme', 'prj_acme', 'inbound', 'A few additions', 'Could you also create two additional landing pages for the partner campaigns? We would love to include those in this round.', iso(1), iso(1));
    await tx.prepare('INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('msg_orbit_proposal', DEMO_WORKSPACE_ID, 'cl_orbit', null, 'outbound', 'Orbit brand strategy proposal', 'Hi Jonas, attached is the €8,000 proposal. I can reserve an August start if you confirm this week.', iso(9), iso(9));
    await tx.prepare('INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('msg_luma_delivery', DEMO_WORKSPACE_ID, 'cl_luma', 'prj_luma', 'outbound', 'Final strategy deck', 'Hi Sofia, the final positioning deck and workshop summary are attached. This completes the final milestone.', iso(2), iso(2));

    const defaults = [
      ['rule_stale', 'stale_proposal', 'prepare', 0.85, 25000, 0, 1],
      ['rule_overdue', 'overdue_invoice', 'prepare', 0.95, 5000, 0, 1],
      ['rule_scope', 'scope_creep', 'suggest', 0.9, 5000, 0, 1],
      ['rule_unbilled', 'unbilled_milestone', 'prepare', 0.95, 10000, 0, 1]
    ] as const;
    for (const rule of defaults) {
      await tx.prepare('INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(rule[0], DEMO_WORKSPACE_ID, rule[1], rule[2], rule[3], rule[4], rule[5], rule[6], iso(30), iso());
    }
  });
}

export async function resetDemoData(db: Db): Promise<void> {
  await db.prepare('DELETE FROM workspaces WHERE id=?').run(DEMO_WORKSPACE_ID);
  await seedDemo(db);
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function normalizeSql(sql: string): string {
  let index = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++index}`);
}
