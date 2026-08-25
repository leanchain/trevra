import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PlaybookRun } from '../shared/types';
import {
  decidePlaybookStep,
  getConversationMessages,
  getConversations,
  prepareConversationEmailReply,
  type ConversationMessage,
  type ConversationSummary
} from './api';
import { errorMessage } from './LinkedInSafety';

function when(value: string | null): string {
  if (!value) return 'Unknown time';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'Unknown time';
}

function channelLabel(channel: ConversationSummary['channels'][number]): string {
  return channel === 'linkedin' ? 'LinkedIn' : 'Email';
}

function suggestedReplySubject(messages: ConversationMessage[]): string {
  const subject = [...messages]
    .reverse()
    .find((message) => message.channel === 'email' && message.subject?.trim())
    ?.subject?.trim();
  if (!subject) return '';
  return /^re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

function newReplyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `conversation-reply-${uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

/**
 * A CONVERSATION THAT CANNOT BE ANSWERED HERE HAS TO SAY SO.
 *
 * This screen prepares EMAIL replies, and only in answer to an inbound email
 * (`canReplyByEmail`). For every other conversation the composer simply did not
 * render -- no box, no button, no sentence -- and the only clue was a footnote
 * at the bottom of the page pointing at "the LinkedIn inbox view above". An
 * operator opening the default tab on a LinkedIn thread was looking at a
 * transcript with no visible way to answer it and no stated reason, which is
 * exactly how it was reported.
 *
 * So the absence is now explained where the composer would have been, and the
 * screen that CAN send offers itself as a button rather than as a footnote.
 */
export function SharedConversations({
  onOpenLinkedInInbox
}: {
  /** Switches the surrounding view to the LinkedIn inbox. Absent in tests and any host that has no such view. */
  onOpenLinkedInInbox?: () => void;
} = {}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [replyKey, setReplyKey] = useState('');
  const [preparedRun, setPreparedRun] = useState<PlaybookRun | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [replyNotice, setReplyNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getConversations(100);
      setConversations(next);
      setSelectedId((current) =>
        current && next.some((conversation) => conversation.id === current)
          ? current
          : (next[0]?.id ?? null)
      );
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read shared conversations. Nothing was changed.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const readSelected = useCallback(async (conversationId: string) => {
    setReading(true);
    try {
      const next = await getConversationMessages(conversationId, 300);
      setMessages(next);
      setReplySubject((current) => current || suggestedReplySubject(next));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to read this conversation. Nothing was changed.'));
    } finally {
      setReading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setMessages([]);
    setReplySubject('');
    setReplyBody('');
    setReplyKey('');
    setPreparedRun(null);
    setReplyNotice('');
    if (selectedId) void readSelected(selectedId);
  }, [selectedId, readSelected]);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;
  const emailThreadAvailable = messages.some(
    (message) => message.channel === 'email' && Boolean(message.externalRef?.trim())
  );
  const canReplyByEmail = Boolean(
    selected?.email &&
    selected.latestMessage?.channel === 'email' &&
    selected.latestMessage.direction === 'inbound'
  );
  const approvalStep = preparedRun?.steps.find((step) => step.stepId === 'approve-reply') ?? null;
  const exactPreparedPayload = useMemo(() => {
    if (
      !approvalStep?.input ||
      typeof approvalStep.input !== 'object' ||
      Array.isArray(approvalStep.input)
    ) {
      return null;
    }
    const payload = approvalStep.input as Record<string, unknown>;
    return {
      recipient: String(payload.recipient ?? ''),
      subject: String(payload.subject ?? ''),
      body: String(payload.body ?? '')
    };
  }, [approvalStep]);

  const changeDraft = (field: 'subject' | 'body', value: string) => {
    setPreparedRun(null);
    setReplyKey('');
    setReplyNotice('');
    if (field === 'subject') setReplySubject(value);
    else setReplyBody(value);
  };

  const prepareReply = async () => {
    if (!selectedId) return;
    const key = replyKey || newReplyKey();
    if (!replyKey) setReplyKey(key);
    setPreparing(true);
    setReplyNotice('');
    try {
      const run = await prepareConversationEmailReply(selectedId, {
        idempotencyKey: key,
        subject: replySubject,
        body: replyBody
      });
      setPreparedRun(run);
      setReplyNotice('Prepared. Review the exact reply below, then approve it to send.');
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'Unable to prepare this email reply. Nothing was sent.'));
    } finally {
      setPreparing(false);
    }
  };

  const decidePreparedReply = async (decision: 'approve' | 'reject') => {
    if (!selectedId || !preparedRun || !approvalStep) return;
    setApproving(true);
    setReplyNotice('');
    try {
      const run = await decidePlaybookStep(preparedRun.id, approvalStep.stepId, decision);
      setPreparedRun(run);
      if (decision === 'reject') {
        setPreparedRun(null);
        setReplyKey('');
        setReplyNotice('Prepared reply discarded. Nothing was sent.');
        return;
      }
      if (run.status === 'completed') {
        setReplyBody('');
        setReplyKey('');
        setPreparedRun(null);
        setReplyNotice('Reply sent through the connected mailbox.');
        await Promise.all([readSelected(selectedId), load()]);
      } else {
        setReplyNotice(
          `Reply approval recorded. Nothing has been sent yet; current state: ${run.status.replaceAll('_', ' ')}.`
        );
      }
      setError('');
    } catch (err) {
      setError(
        errorMessage(
          err,
          decision === 'approve'
            ? 'Unable to approve this reply. Nothing was sent. Reload before retrying.'
            : 'Unable to discard this prepared reply. Reload before retrying.'
        )
      );
    } finally {
      setApproving(false);
    }
  };

  return (
    <section className="page-panel shared-conversations" aria-label="Shared GTM conversations">
      <div className="section-heading">
        <div>
          <h2>Conversations</h2>
          <p>
            One Person-centric transcript across email and LinkedIn. Channel-specific delivery and
            safety controls stay authoritative underneath.
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {replyNotice && <div className="shared-reply-notice">{replyNotice}</div>}

      {!loading && conversations.length === 0 && (
        <div className="empty-state">
          <h4 aria-level={3}>No shared conversations yet</h4>
          <p>
            Email or LinkedIn messages will appear here once Trevra has verified and stored them.
          </p>
        </div>
      )}

      {conversations.length > 0 && (
        <div className="shared-conversation-grid">
          <div className="shared-conversation-list" aria-label="People with conversations">
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                className={`shared-conversation-row${conversation.id === selectedId ? ' is-active' : ''}`}
                onClick={() => setSelectedId(conversation.id)}
              >
                <span className="shared-conversation-row-head">
                  <strong>{conversation.personName ?? conversation.email ?? 'Known person'}</strong>
                  {conversation.needsReply && <span className="status-pill">Needs reply</span>}
                </span>
                <span className="shared-conversation-meta">
                  {conversation.channels.map(channelLabel).join(' + ') || 'Conversation'} ·{' '}
                  {when(conversation.lastActivityAt)}
                </span>
                {conversation.latestMessage && (
                  <span className="shared-conversation-preview">
                    {conversation.latestMessage.body}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="shared-transcript" aria-live="polite">
            {selected && (
              <div className="shared-transcript-head">
                <div>
                  <strong>{selected.personName ?? selected.email ?? 'Known person'}</strong>
                  <span>
                    {[selected.email, selected.linkedinUrl].filter(Boolean).join(' · ') ||
                      selected.channels.map(channelLabel).join(' + ')}
                  </span>
                </div>
                {selected.needsReply && <span className="status-pill">Latest is inbound</span>}
              </div>
            )}

            {reading ? (
              <p className="empty-copy">Reading transcript…</p>
            ) : messages.length === 0 ? (
              <p className="empty-copy">No projected messages in this conversation yet.</p>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`shared-message is-${message.direction}`}>
                  <div className="shared-message-head">
                    <strong>
                      {message.direction === 'inbound' ? 'Them' : 'You'} ·{' '}
                      {channelLabel(message.channel)}
                    </strong>
                    <span>{when(message.occurredAt)}</span>
                  </div>
                  {message.subject && (
                    <span className="shared-message-subject">{message.subject}</span>
                  )}
                  <p>{message.body}</p>
                </article>
              ))
            )}

            {!canReplyByEmail && selected && (
              <div className="shared-reply-composer shared-reply-elsewhere">
                <div className="shared-reply-heading">
                  <div>
                    <strong>Not answerable from this screen</strong>
                    <span>
                      {selected.channels.includes('linkedin')
                        ? 'The last message on this conversation came through LinkedIn. LinkedIn replies are queued in the LinkedIn inbox and sent from the paired browser at paced gaps, so they are written there rather than here.'
                        : selected.email
                          ? 'Trevra only prepares an email reply in answer to an inbound email. The most recent message here is not one, so there is nothing to reply to yet.'
                          : 'This person has no email address on file, so there is no email thread to reply to.'}
                    </span>
                  </div>
                </div>
                {selected.channels.includes('linkedin') && onOpenLinkedInInbox && (
                  <div className="shared-reply-actions">
                    <button className="primary-button" type="button" onClick={onOpenLinkedInInbox}>
                      Open the LinkedIn inbox
                    </button>
                  </div>
                )}
              </div>
            )}

            {canReplyByEmail && (
              <div className="shared-reply-composer">
                <div className="shared-reply-heading">
                  <div>
                    <strong>Reply by email</strong>
                    <span>
                      Preparation never sends. The exact prepared bytes require your approval.
                    </span>
                  </div>
                  {!emailThreadAvailable && <span className="status-pill">Thread unavailable</span>}
                </div>
                <label>
                  Subject
                  <input
                    value={replySubject}
                    onChange={(event) => changeDraft('subject', event.target.value)}
                    maxLength={200}
                  />
                </label>
                <label>
                  Reply
                  <textarea
                    value={replyBody}
                    onChange={(event) => changeDraft('body', event.target.value)}
                    rows={5}
                    maxLength={20_000}
                    placeholder="Write the reply you want Trevra to prepare…"
                  />
                </label>

                {exactPreparedPayload && preparedRun?.status === 'waiting_approval' && (
                  <div className="shared-reply-review">
                    <strong>Exact reply waiting for approval</strong>
                    <span>To: {exactPreparedPayload.recipient}</span>
                    <span>Subject: {exactPreparedPayload.subject}</span>
                    <p>{exactPreparedPayload.body}</p>
                  </div>
                )}

                <div className="shared-reply-actions">
                  {preparedRun?.status === 'waiting_approval' && approvalStep ? (
                    <>
                      <button
                        className="primary-button"
                        type="button"
                        disabled={approving}
                        onClick={() => void decidePreparedReply('approve')}
                      >
                        {approving ? 'Approving…' : 'Approve & send'}
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={approving}
                        onClick={() => void decidePreparedReply('reject')}
                      >
                        Discard
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary-button"
                      type="button"
                      disabled={
                        preparing ||
                        !emailThreadAvailable ||
                        !replySubject.trim() ||
                        !replyBody.trim()
                      }
                      onClick={() => void prepareReply()}
                    >
                      {preparing ? 'Preparing…' : 'Prepare reply'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="shared-conversation-footnote">
        Email replies above use the same exact-payload approval and connected-mailbox executor as
        Trevra playbooks. Use the LinkedIn inbox view above for channel-specific reply, queue, and
        manual-task controls.
      </p>
    </section>
  );
}
