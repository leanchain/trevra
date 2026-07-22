import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEMO_WORKSPACE_ID = 'ws_demo';
export const DEMO_USER_ID = 'usr_demo';

export type Db = Database.Database;

export function openDatabase(path = process.env.DATABASE_PATH ?? './data/trevra.db'): Db {
  const resolved = path === ':memory:' ? path : resolve(path);
  if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  seedDemo(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_settings (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      currency TEXT NOT NULL DEFAULT 'EUR',
      sender_name TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'Europe/Zurich',
      demo_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_config_key TEXT NOT NULL,
      external_connection_id TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, provider_config_key, external_connection_id)
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      workspace_id TEXT,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      UNIQUE(provider, external_event_id)
    );
    CREATE TABLE IF NOT EXISTS source_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      object_type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_url TEXT,
      content_hash TEXT NOT NULL,
      occurred_at TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, provider, object_type, external_id)
    );
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      active_value REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      last_interaction_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contact_identities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      identity_type TEXT NOT NULL,
      identity_value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, provider, identity_type, identity_value)
    );
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      value REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      proposal_sent_at TEXT,
      expected_response_at TEXT,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      total_value REAL NOT NULL,
      currency TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contracts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      signed_at TEXT,
      effective_at TEXT,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contract_clauses (
      id TEXT PRIMARY KEY,
      contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      clause_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      value_number REAL,
      unit TEXT,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scope_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      included INTEGER NOT NULL DEFAULT 1,
      unit_price REAL,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      owner_type TEXT NOT NULL,
      description TEXT NOT NULL,
      due_at TEXT,
      status TEXT NOT NULL,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliverables (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      delivered_at TEXT,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      delivered_at TEXT,
      invoiced_at TEXT,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      external_ref TEXT,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      paid_at TEXT,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
      external_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      paid_at TEXT NOT NULL,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, external_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      direction TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      source_record_id TEXT REFERENCES source_records(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recommendations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      estimated_amount REAL NOT NULL,
      currency TEXT NOT NULL,
      confidence REAL NOT NULL,
      urgency REAL NOT NULL,
      priority_score REAL NOT NULL,
      status TEXT NOT NULL,
      recommended_action TEXT NOT NULL,
      snoozed_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, source_key)
    );
    CREATE TABLE IF NOT EXISTS recommendation_evidence (
      id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Evidence',
      category TEXT NOT NULL DEFAULT 'supporting',
      external_url TEXT,
      excerpt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proof_packs (
      id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL UNIQUE REFERENCES recommendations(id) ON DELETE CASCADE,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proof_pack_items (
      id TEXT PRIMARY KEY,
      proof_pack_id TEXT NOT NULL REFERENCES proof_packs(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_url TEXT,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS actions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
      connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      structured_payload_json TEXT NOT NULL DEFAULT '{}',
      payload_hash TEXT,
      status TEXT NOT NULL,
      execution_provider TEXT NOT NULL DEFAULT 'unconfigured',
      external_ref TEXT,
      scheduled_for TEXT,
      executed_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      recommendation_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      min_confidence REAL NOT NULL DEFAULT 0.95,
      max_amount REAL NOT NULL DEFAULT 0,
      delay_minutes INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, recommendation_type)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      automation_rule_id TEXT REFERENCES automation_rules(id) ON DELETE SET NULL,
      approval_type TEXT NOT NULL DEFAULT 'manual',
      approved_payload_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recommendation_outcomes (
      id TEXT PRIMARY KEY,
      recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
      outcome_type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'EUR',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_connections_workspace ON connections(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_source_records_lookup ON source_records(workspace_id, provider, object_type, external_id);
    CREATE INDEX IF NOT EXISTS idx_recommendations_workspace_status ON recommendations(workspace_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_client_time ON messages(client_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_invoices_workspace_due ON invoices(workspace_id, due_at);
    CREATE INDEX IF NOT EXISTS idx_actions_schedule ON actions(status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_outcomes_recommendation ON recommendation_outcomes(recommendation_id);
  `);

  ensureColumn(db, 'opportunities', 'source_record_id', 'TEXT REFERENCES source_records(id) ON DELETE SET NULL');
  ensureColumn(db, 'scope_items', 'source_record_id', 'TEXT REFERENCES source_records(id) ON DELETE SET NULL');
  ensureColumn(db, 'milestones', 'source_record_id', 'TEXT REFERENCES source_records(id) ON DELETE SET NULL');
  ensureColumn(db, 'invoices', 'source_record_id', 'TEXT REFERENCES source_records(id) ON DELETE SET NULL');
  ensureColumn(db, 'messages', 'source_record_id', 'TEXT REFERENCES source_records(id) ON DELETE SET NULL');
  ensureColumn(db, 'recommendation_evidence', 'label', "TEXT NOT NULL DEFAULT 'Evidence'");
  ensureColumn(db, 'recommendation_evidence', 'category', "TEXT NOT NULL DEFAULT 'supporting'");
  ensureColumn(db, 'recommendation_evidence', 'external_url', 'TEXT');
  ensureColumn(db, 'actions', 'connection_id', 'TEXT REFERENCES connections(id) ON DELETE SET NULL');
  ensureColumn(db, 'actions', 'structured_payload_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'actions', 'execution_provider', "TEXT NOT NULL DEFAULT 'unconfigured'");
  ensureColumn(db, 'actions', 'external_ref', 'TEXT');
  ensureColumn(db, 'actions', 'scheduled_for', 'TEXT');
  ensureColumn(db, 'actions', 'executed_at', 'TEXT');
  ensureColumn(db, 'actions', 'last_error', 'TEXT');
  ensureColumn(db, 'approvals', 'automation_rule_id', 'TEXT REFERENCES automation_rules(id) ON DELETE SET NULL');
  ensureColumn(db, 'approvals', 'approval_type', "TEXT NOT NULL DEFAULT 'manual'");
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function seedDemo(db: Db): void {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM workspaces').get() as { count: number };
  if (existing.count > 0) return;

  const now = new Date();
  const iso = (daysAgo = 0) => new Date(now.getTime() - daysAgo * 86400000).toISOString();

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)').run(DEMO_WORKSPACE_ID, 'Northstar Studio', iso(90));
    db.prepare('INSERT INTO users (id,workspace_id,email,name,created_at) VALUES (?,?,?,?,?)').run(DEMO_USER_ID, DEMO_WORKSPACE_ID, 'alex@northstar.studio', 'Alex Morgan', iso(90));
    db.prepare('INSERT INTO workspace_settings (workspace_id,currency,sender_name,timezone,demo_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(DEMO_WORKSPACE_ID, 'EUR', 'Alex', 'Europe/Zurich', 1, iso(90), iso());
    db.prepare('INSERT INTO connections (id,workspace_id,provider,provider_config_key,external_connection_id,display_name,status,is_demo,last_synced_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('conn_demo_gmail', DEMO_WORKSPACE_ID, 'gmail', 'google-mail', 'demo-gmail', 'alex@northstar.studio', 'connected', 1, iso(), iso(90), iso());

    const clients = [
      ['cl_acme', 'Acme Labs', 'Maya Chen', 'maya@acme.example', 'active', 15000, 'EUR', iso(1)],
      ['cl_orbit', 'Orbit Health', 'Jonas Keller', 'jonas@orbit.example', 'prospect', 8000, 'EUR', iso(9)],
      ['cl_luma', 'Luma Works', 'Sofia Rossi', 'sofia@luma.example', 'active', 7200, 'EUR', iso(4)]
    ] as const;
    const clientStmt = db.prepare('INSERT INTO clients (id,workspace_id,name,contact_name,email,status,active_value,currency,last_interaction_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const c of clients) {
      clientStmt.run(c[0], DEMO_WORKSPACE_ID, c[1], c[2], c[3], c[4], c[5], c[6], c[7], iso(80));
      db.prepare('INSERT INTO contact_identities (id,workspace_id,client_id,provider,identity_type,identity_value,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id('ident'), DEMO_WORKSPACE_ID, c[0], 'email', 'email', c[3], iso(80));
    }

    db.prepare('INSERT INTO opportunities (id,workspace_id,client_id,title,value,currency,status,proposal_sent_at,expected_response_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('opp_orbit', DEMO_WORKSPACE_ID, 'cl_orbit', 'Brand strategy engagement', 8000, 'EUR', 'proposal_sent', iso(9), iso(5), iso(14));

    db.prepare('INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('prj_acme', DEMO_WORKSPACE_ID, 'cl_acme', 'Acme website launch', 'active', 15000, 'EUR', iso(50));
    db.prepare('INSERT INTO projects (id,workspace_id,client_id,name,status,total_value,currency,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('prj_luma', DEMO_WORKSPACE_ID, 'cl_luma', 'Luma positioning sprint', 'delivered', 7200, 'EUR', iso(35));

    db.prepare('INSERT INTO contracts (id,workspace_id,client_id,project_id,title,status,signed_at,effective_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('contract_acme', DEMO_WORKSPACE_ID, 'cl_acme', 'prj_acme', 'Acme website statement of work', 'signed', iso(52), iso(50), iso(52));
    db.prepare('INSERT INTO contract_clauses (id,contract_id,clause_type,title,content,value_number,unit,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('clause_acme_revision', 'contract_acme', 'change_order', 'Additional deliverables', 'Additional pages and deliverables require written approval and are priced separately.', 750, 'per landing page', iso(52));

    const scopeStmt = db.prepare('INSERT INTO scope_items (id,project_id,description,included,unit_price,created_at) VALUES (?,?,?,?,?,?)');
    scopeStmt.run('scope_acme_1', 'prj_acme', 'One homepage and one product landing page', 1, null, iso(50));
    scopeStmt.run('scope_acme_2', 'prj_acme', 'Additional landing pages priced separately', 0, 750, iso(50));
    scopeStmt.run('scope_luma_1', 'prj_luma', 'Positioning workshop and final strategy deck', 1, null, iso(35));

    db.prepare('INSERT INTO milestones (id,project_id,name,amount,currency,status,delivered_at,invoiced_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('mil_luma_final', 'prj_luma', 'Final strategy delivery', 2400, 'EUR', 'delivered', iso(2), null, iso(35));
    db.prepare('INSERT INTO deliverables (id,workspace_id,project_id,name,status,delivered_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('del_luma_deck', DEMO_WORKSPACE_ID, 'prj_luma', 'Final positioning deck', 'delivered', iso(2), iso(35));

    db.prepare('INSERT INTO invoices (id,workspace_id,client_id,project_id,external_ref,amount,currency,status,issued_at,due_at,paid_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('inv_acme_104', DEMO_WORKSPACE_ID, 'cl_acme', 'prj_acme', 'INV-104', 1850, 'EUR', 'sent', iso(25), iso(7), null, iso(25));

    const msgStmt = db.prepare('INSERT INTO messages (id,workspace_id,client_id,project_id,direction,subject,body,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)');
    msgStmt.run('msg_acme_extra', DEMO_WORKSPACE_ID, 'cl_acme', 'prj_acme', 'inbound', 'A few additions', 'Could you also create two additional landing pages for the partner campaigns? We would love to include those in this round.', iso(1), iso(1));
    msgStmt.run('msg_orbit_proposal', DEMO_WORKSPACE_ID, 'cl_orbit', null, 'outbound', 'Orbit brand strategy proposal', 'Hi Jonas, attached is the €8,000 proposal. I can reserve an August start if you confirm this week.', iso(9), iso(9));
    msgStmt.run('msg_luma_delivery', DEMO_WORKSPACE_ID, 'cl_luma', 'prj_luma', 'outbound', 'Final strategy deck', 'Hi Sofia, the final positioning deck and workshop summary are attached. This completes the final milestone.', iso(2), iso(2));

    const ruleStmt = db.prepare('INSERT INTO automation_rules (id,workspace_id,recommendation_type,mode,min_confidence,max_amount,delay_minutes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    ruleStmt.run('rule_stale', DEMO_WORKSPACE_ID, 'stale_proposal', 'prepare', 0.85, 25000, 0, 1, iso(30), iso());
    ruleStmt.run('rule_overdue', DEMO_WORKSPACE_ID, 'overdue_invoice', 'prepare', 0.95, 5000, 0, 1, iso(30), iso());
    ruleStmt.run('rule_scope', DEMO_WORKSPACE_ID, 'scope_creep', 'suggest', 0.9, 5000, 0, 1, iso(30), iso());
    ruleStmt.run('rule_unbilled', DEMO_WORKSPACE_ID, 'unbilled_milestone', 'prepare', 0.95, 10000, 0, 1, iso(30), iso());

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function resetDemoData(db: Db): void {
  const tables = [
    'audit_events','recommendation_outcomes','approvals','automation_rules','actions','proof_pack_items','proof_packs',
    'recommendation_evidence','recommendations','payments','messages','invoices','milestones','deliverables','commitments',
    'scope_items','contract_clauses','contracts','projects','opportunities','contact_identities','clients','source_records',
    'webhook_events','connections','workspace_settings','sessions','users','workspaces'
  ];
  db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
  try {
    for (const table of tables) db.exec(`DELETE FROM ${table};`);
    db.exec('COMMIT; PRAGMA foreign_keys = ON;');
    seedDemo(db);
  } catch (error) {
    db.exec('ROLLBACK; PRAGMA foreign_keys = ON;');
    throw error;
  }
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
