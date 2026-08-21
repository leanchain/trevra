import type { Db } from '../db.js';
import { normalizeAccountDomain } from '../accounts/store.js';
import { appendDomainEvent } from '../control-plane/events.js';
import {
  normalizeContactEmail,
  normalizeExplicitPhone,
  resolveContact,
  resolveExplicitAccount
} from './people.js';

export interface ImportedPersonEvidence {
  accountDomain: string;
  name?: string;
  email?: string;
  phone?: string;
  role?: string;
  sourcePath?: string;
}

export interface ImportedPeopleResult {
  created: number;
  matched: number;
  linked: number;
  skipped: number;
}

export interface ImportedPeopleActor {
  type: 'human' | 'agent' | 'system';
  id: string;
}

/**
 * Persist only explicit usable identities from an operator-reviewed account import.
 * Names alone remain review evidence; Trevra never invents a Person identity from a name.
 * The actor is recorded in the shared GTM ledger for every Person/link mutation.
 */
export async function persistImportedPeople(
  db: Db,
  workspaceId: string,
  evidence: readonly ImportedPersonEvidence[],
  actor: ImportedPeopleActor,
  now: Date = new Date()
): Promise<ImportedPeopleResult> {
  const result: ImportedPeopleResult = { created: 0, matched: 0, linked: 0, skipped: 0 };
  for (const item of evidence.slice(0, 4000)) {
    const domain = normalizeAccountDomain(item.accountDomain);
    const email = normalizeContactEmail(item.email);
    const phone = normalizeExplicitPhone(item.phone);
    if (!domain || (!email && !phone)) {
      result.skipped += 1;
      continue;
    }

    const outcome = await db.transaction(async (tx) => {
      const account = await tx
        .prepare('SELECT id FROM accounts WHERE workspace_id=? AND lower(domain)=lower(?) LIMIT 1')
        .get<{ id: string }>(workspaceId, domain);
      if (!account) return null;

      const resolved = await resolveContact(
        tx,
        workspaceId,
        {
          name: item.name,
          email: item.email,
          phone,
          role: item.role
        },
        now
      );
      const linked = await resolveExplicitAccount(
        tx,
        workspaceId,
        resolved.contact.id,
        {
          domain,
          role: item.role,
          source: 'import',
          sourceDetail: item.sourcePath ?? 'account-import'
        },
        now
      );

      await appendDomainEvent(tx, {
        workspaceId,
        streamType: 'contact',
        streamId: resolved.contact.id,
        eventType: resolved.created ? 'contact.created' : 'contact.matched',
        actorType: actor.type,
        actorId: actor.id,
        payload: {
          source: 'account-import',
          sourcePath: item.sourcePath ?? 'account-import',
          ...(resolved.conflicts.length ? { conflicts: resolved.conflicts } : {})
        },
        occurredAt: now
      });
      if (linked?.linked) {
        await appendDomainEvent(tx, {
          workspaceId,
          streamType: 'contact',
          streamId: resolved.contact.id,
          eventType: 'account_contact.linked',
          actorType: actor.type,
          actorId: actor.id,
          payload: {
            accountId: linked.accountId,
            source: 'import',
            sourcePath: item.sourcePath ?? 'account-import'
          },
          occurredAt: now
        });
      }
      return { resolved, linked };
    });

    if (!outcome) {
      result.skipped += 1;
      continue;
    }
    if (outcome.resolved.created) result.created += 1;
    else result.matched += 1;
    if (outcome.linked?.linked) result.linked += 1;
  }
  return result;
}
