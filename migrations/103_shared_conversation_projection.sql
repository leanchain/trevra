-- Shared GTM Conversation projection.
--
-- Channel-specific tables remain authoritative for provider mechanics, safety,
-- retries and raw channel state. These tables give the operator one Person-led
-- conversation view across channels without creating a second sending engine.

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (workspace_id,person_id)
    REFERENCES contacts(workspace_id,id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_workspace_person
  ON conversations(workspace_id,person_id);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_recent
  ON conversations(workspace_id,last_activity_at DESC NULLS LAST,updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('linkedin','email')),
  provider TEXT NOT NULL,
  external_thread_ref TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id,source_type,source_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_channels_conversation
  ON conversation_channels(workspace_id,conversation_id,channel);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES conversation_channels(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('linkedin','email')),
  provider TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  subject TEXT,
  body TEXT NOT NULL,
  external_ref TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  actor_type TEXT,
  actor_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id,source_type,source_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
  ON conversation_messages(workspace_id,conversation_id,occurred_at,created_at);

-- Backfill conversations for already-resolved LinkedIn threads.
WITH thread_people AS (
  SELECT
    t.workspace_id,
    l.person_id,
    MAX(COALESCE(t.last_message_at,t.synced_at,t.created_at)) AS last_activity_at,
    MIN(t.created_at) AS created_at
  FROM linkedin_threads t
  JOIN linkedin_lead_contacts l
    ON l.workspace_id=t.workspace_id
   AND l.person_id IS NOT NULL
   AND l.profile_url IS NOT NULL
   AND t.profile_url IS NOT NULL
   AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(l.profile_url,chr(63),1),'#',1),'/'))=
       LOWER(RTRIM(SPLIT_PART(SPLIT_PART(t.profile_url,chr(63),1),'#',1),'/'))
  GROUP BY t.workspace_id,l.person_id
)
INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
SELECT
  'conv_' || SUBSTR(MD5(workspace_id || ':' || person_id),1,24),
  workspace_id,person_id,last_activity_at,created_at,last_activity_at
FROM thread_people
ON CONFLICT (workspace_id,person_id) DO UPDATE
SET last_activity_at=GREATEST(conversations.last_activity_at,EXCLUDED.last_activity_at),
    updated_at=GREATEST(conversations.updated_at,EXCLUDED.updated_at);

INSERT INTO conversation_channels (
  id,workspace_id,conversation_id,channel,provider,external_thread_ref,source_type,source_id,created_at,updated_at
)
SELECT
  'cch_' || SUBSTR(MD5('linkedin:' || t.workspace_id || ':' || t.id),1,24),
  t.workspace_id,
  c.id,
  'linkedin',
  'linkedin',
  t.thread_urn,
  'linkedin_thread',
  t.id,
  t.created_at,
  t.synced_at
FROM linkedin_threads t
JOIN linkedin_lead_contacts l
  ON l.workspace_id=t.workspace_id
 AND l.person_id IS NOT NULL
 AND l.profile_url IS NOT NULL
 AND t.profile_url IS NOT NULL
 AND LOWER(RTRIM(SPLIT_PART(SPLIT_PART(l.profile_url,chr(63),1),'#',1),'/'))=
     LOWER(RTRIM(SPLIT_PART(SPLIT_PART(t.profile_url,chr(63),1),'#',1),'/'))
JOIN conversations c ON c.workspace_id=t.workspace_id AND c.person_id=l.person_id
ON CONFLICT (workspace_id,source_type,source_id) DO NOTHING;

INSERT INTO conversation_messages (
  id,workspace_id,conversation_id,channel_id,channel,provider,direction,body,external_ref,
  source_type,source_id,occurred_at,created_at
)
SELECT
  'cmsg_' || SUBSTR(MD5('linkedin:' || m.workspace_id || ':' || m.id),1,24),
  m.workspace_id,
  ch.conversation_id,
  ch.id,
  'linkedin',
  'linkedin',
  CASE WHEN m.direction='in' THEN 'inbound' ELSE 'outbound' END,
  m.body,
  m.external_ref,
  'linkedin_message',
  m.id,
  COALESCE(m.sent_at,m.created_at),
  m.created_at
FROM linkedin_messages m
JOIN conversation_channels ch
  ON ch.workspace_id=m.workspace_id
 AND ch.source_type='linkedin_thread'
 AND ch.source_id=m.thread_id
ON CONFLICT (workspace_id,source_type,source_id) DO NOTHING;

-- Backfill connected email messages that already have a canonical Person.
WITH email_people AS (
  SELECT
    m.workspace_id,
    m.person_id,
    MAX(m.occurred_at) AS last_activity_at,
    MIN(m.created_at) AS created_at
  FROM messages m
  JOIN source_records s ON s.id=m.source_record_id AND s.workspace_id=m.workspace_id
  WHERE m.person_id IS NOT NULL
    AND LOWER(s.provider) IN ('gmail','google-mail','microsoft','outlook')
  GROUP BY m.workspace_id,m.person_id
)
INSERT INTO conversations (id,workspace_id,person_id,last_activity_at,created_at,updated_at)
SELECT
  'conv_' || SUBSTR(MD5(workspace_id || ':' || person_id),1,24),
  workspace_id,person_id,last_activity_at,created_at,last_activity_at
FROM email_people
ON CONFLICT (workspace_id,person_id) DO UPDATE
SET last_activity_at=GREATEST(conversations.last_activity_at,EXCLUDED.last_activity_at),
    updated_at=GREATEST(conversations.updated_at,EXCLUDED.updated_at);

INSERT INTO conversation_messages (
  id,workspace_id,conversation_id,channel,provider,direction,subject,body,external_ref,
  source_type,source_id,occurred_at,created_at
)
SELECT
  'cmsg_' || SUBSTR(MD5('legacy-email:' || m.workspace_id || ':' || m.id),1,24),
  m.workspace_id,
  c.id,
  'email',
  LOWER(s.provider),
  CASE WHEN m.direction='inbound' THEN 'inbound' ELSE 'outbound' END,
  NULLIF(m.subject,''),
  m.body,
  s.external_id,
  'legacy_message',
  m.id,
  m.occurred_at,
  m.created_at
FROM messages m
JOIN source_records s ON s.id=m.source_record_id AND s.workspace_id=m.workspace_id
JOIN conversations c ON c.workspace_id=m.workspace_id AND c.person_id=m.person_id
WHERE m.person_id IS NOT NULL
  AND LOWER(s.provider) IN ('gmail','google-mail','microsoft','outlook')
ON CONFLICT (workspace_id,source_type,source_id) DO NOTHING;
