import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bold, Italic, Underline, List, ListOrdered } from 'lucide-react';
import {
  applyStyleToSelection,
  plainTextLength,
  renderPostBody,
  type PostBlock,
  type PostRun,
  type PostStyle,
  type RunPosition
} from '../shared/linkedin-post-format';
import {
  cancelLinkedInPost,
  createLinkedInPost,
  listLinkedInPosts,
  publishLinkedInPostNow,
  type ApiError,
  type LinkedInPost
} from './api';
import { useActiveSeatKey } from './LinkedInAccounts';

const MAX_CHARS = 3000;
const EMPTY_BLOCKS: PostBlock[] = [{ runs: [{ type: 'text', text: '' }] }];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * Resolve a DOM (node, offset) -- from window.getSelection()'s Range -- into
 * a RunPosition, purely from tree structure (which block/run CHILD INDEX the
 * node falls under), never from a stamped data-* attribute. An attribute
 * would go stale the instant the browser's own contentEditable behavior
 * inserts a new block div on Enter without our involvement; structural
 * position never does, because it's recomputed fresh every time it's read.
 */
function resolvePosition(container: HTMLElement, node: Node, offset: number): RunPosition | null {
  let blockEl: Element | null =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  while (blockEl && blockEl.parentElement !== container) blockEl = blockEl.parentElement;
  if (!blockEl || blockEl.parentElement !== container) return null;
  const block = Array.from(container.children).indexOf(blockEl);
  if (block === -1) return null;

  let runNode: Node = node;
  while (runNode.parentNode && runNode.parentNode !== blockEl) runNode = runNode.parentNode;
  const run =
    runNode.parentNode === blockEl
      ? Array.from(blockEl.childNodes).indexOf(runNode as ChildNode)
      : 0;

  // Offset from a Range is UTF-16 code units; convert to a CODE POINT offset,
  // which is what applyStyleToSelection consumes (see linkedin-post-format.ts's
  // own header on this exact class of bug -- astral bold/italic characters are
  // surrogate pairs, and indexing by UTF-16 unit corrupts boundaries near them).
  const textBefore =
    node.nodeType === Node.TEXT_NODE ? (node.textContent ?? '').slice(0, offset) : '';
  const codePointOffset = [...textBefore].length;
  return { block, run: Math.max(run, 0), offset: codePointOffset };
}

function currentSelection(container: HTMLElement): { start: RunPosition; end: RunPosition } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = resolvePosition(container, range.startContainer, range.startOffset);
  const end = resolvePosition(container, range.endContainer, range.endOffset);
  if (!start || !end) return null;
  return { start, end };
}

/** Like currentSelection, but also resolves a plain collapsed cursor (no drag-selected text) — used only by block-level toggles (Bullet/Numbered), which apply to whichever paragraph the cursor is in even with nothing selected. Bold/Italic/Underline's `toggle()` deliberately keeps requiring a real selection via `currentSelection` and must not use this. */
function currentCaretBlock(container: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  return resolvePosition(container, range.startContainer, range.startOffset)?.block ?? null;
}

/** DOM -> blocks. The typing path's source of truth. No data-* dependency. */
function parseDomToBlocks(container: HTMLElement): PostBlock[] {
  const blockEls = Array.from(container.children);
  if (blockEls.length === 0) return [{ runs: [{ type: 'text', text: '' }] }];
  return blockEls.map((blockEl) => {
    const list = (blockEl as HTMLElement).dataset.list as 'bullet' | 'numbered' | undefined;
    const runs: PostRun[] = [];
    blockEl.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (text) runs.push({ type: 'text', text });
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === 'BR') {
        // A lone <br> is Chrome's own filler for an empty block, not something
        // the user typed. Reading it as a 'break' run made a deliberately
        // blank spacer line -- the most ordinary thing there is in a LinkedIn
        // post -- render as TWO newlines and cost an extra character against
        // the 3000 cap. A <br> with text beside it IS a user break (shift+Enter).
        if (blockEl.childNodes.length === 1) return;
        runs.push({ type: 'break' });
        return;
      }
      if (node.dataset.mention) {
        runs.push({
          type: 'mention',
          displayText: node.dataset.mentionDisplay ?? node.textContent ?? '',
          entityKind: (node.dataset.mentionKind as 'person' | 'page') ?? 'person',
          ...(node.dataset.mentionUrn ? { resolvedUrn: node.dataset.mentionUrn } : {})
        });
        return;
      }
      const text = node.textContent ?? '';
      if (!text) return;
      const bold = node.classList.contains('li-post-run--bold');
      const italic = node.classList.contains('li-post-run--italic');
      const underline = node.classList.contains('li-post-run--underline');
      runs.push({
        type: 'text',
        text,
        ...(bold ? { bold: true } : {}),
        ...(italic ? { italic: true } : {}),
        ...(underline ? { underline: true } : {})
      });
    });
    if (runs.length === 0) runs.push({ type: 'text', text: '' });
    return { runs, ...(list ? { list } : {}) };
  });
}

/** blocks -> DOM. The toolbar-action path. Rebuilds the editor's children from scratch. */
function renderBlocksIntoDom(container: HTMLElement, blocks: PostBlock[]): void {
  container.innerHTML = '';
  blocks.forEach((block) => {
    const div = document.createElement('div');
    div.className = block.list ? `li-post-line li-post-line--${block.list}` : 'li-post-line';
    if (block.list) div.dataset.list = block.list;
    block.runs.forEach((run) => {
      if (run.type === 'break') {
        div.appendChild(document.createElement('br'));
        return;
      }
      if (run.type === 'mention') {
        const span = document.createElement('span');
        span.className = 'li-post-mention';
        span.contentEditable = 'false';
        span.dataset.mention = 'true';
        span.dataset.mentionDisplay = run.displayText;
        span.dataset.mentionKind = run.entityKind;
        if (run.resolvedUrn) span.dataset.mentionUrn = run.resolvedUrn;
        span.textContent = `@${run.displayText}`;
        div.appendChild(span);
        return;
      }
      if (run.bold || run.italic || run.underline) {
        const span = document.createElement('span');
        span.className = [
          run.bold && 'li-post-run--bold',
          run.italic && 'li-post-run--italic',
          run.underline && 'li-post-run--underline'
        ]
          .filter(Boolean)
          .join(' ');
        span.textContent = run.text;
        div.appendChild(span);
      } else {
        div.appendChild(document.createTextNode(run.text));
      }
    });
    if (block.runs.length === 0) div.appendChild(document.createTextNode(''));
    container.appendChild(div);
  });
}

export function PostComposer({
  onCreated,
  setToast
}: {
  onCreated: () => void;
  setToast: (message: string) => void;
}) {
  const [seatKey] = useActiveSeatKey();
  const [blocks, setBlocks] = useState<PostBlock[]>(EMPTY_BLOCKS);
  const [scheduledAt, setScheduledAt] = useState('');
  const [busy, setBusy] = useState<'save' | 'schedule' | 'now' | null>(null);
  const [error, setError] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  // STATE, not a ref, and deliberately: a toolbar action must re-render even
  // when its mutation returns the blocks array unchanged (applyStyleToSelection
  // no-ops on a multi-block selection). With a ref, that bump would never be
  // consumed by the effect below, and the NEXT keystroke would find the token
  // still ahead of lastSyncedToken and rewrite the DOM mid-typing -- exactly
  // the cursor-fighting bug this whole mechanism exists to remove.
  const [domSyncToken, setDomSyncToken] = useState(0);
  const lastSyncedToken = useRef(-1);

  const rendered = useMemo(() => renderPostBody(blocks), [blocks]);
  const length = useMemo(() => plainTextLength(blocks), [blocks]);
  const overLimit = length > MAX_CHARS;

  // Runs on mount (token 0 vs -1: always syncs once) and whenever a toolbar
  // action bumps domSyncToken. Deliberately does NOT run on every `blocks`
  // change from typing -- handleInput() below updates `blocks` without
  // touching domSyncToken, so this effect no-ops and the DOM (which the
  // browser already has correct, because typing was never controlled) is left
  // completely alone. This is what fixes the cursor-fighting bug: the only
  // code that ever rewrites the editor's DOM is a toolbar click, never a
  // keystroke.
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (domSyncToken === lastSyncedToken.current) return;
    renderBlocksIntoDom(el, blocks);
    lastSyncedToken.current = domSyncToken;
  }, [blocks, domSyncToken]);

  const handleInput = () => {
    const el = editorRef.current;
    if (!el) return;
    setBlocks(parseDomToBlocks(el));
  };

  const applyAndSync = (mutate: (current: PostBlock[]) => PostBlock[]) => {
    setBlocks((current) => mutate(current));
    setDomSyncToken((token) => token + 1);
  };

  // Which paragraph a block-level toggle (Bullet/Numbered) applies to: the
  // block the cursor/selection is actually in, not always the last one --
  // that was this function's own bug in an earlier draft (a hardcoded
  // `blocks.length - 1` at both call sites below, caught in review): a click
  // while editing an earlier paragraph in a multi-paragraph post must affect
  // THAT paragraph, not silently bullet whichever one happens to be last.
  // Falls back to the last block only when there is genuinely no selection
  // (e.g. the editor never received focus yet).
  const currentBlockIndex = (): number => {
    const el = editorRef.current;
    if (!el) return blocks.length - 1;
    const selection = currentSelection(el);
    if (selection) return selection.start.block;
    return currentCaretBlock(el) ?? blocks.length - 1;
  };

  const toggle = (style: PostStyle) => {
    const el = editorRef.current;
    if (!el) return;
    const selection = currentSelection(el);
    if (!selection) return; // no-selection "arm for next typed text" is a documented, deferred follow-up
    applyAndSync((current) => applyStyleToSelection(current, selection, style));
  };

  const toggleListAt = (blockIndex: number, kind: 'bullet' | 'numbered') => {
    applyAndSync((current) =>
      current.map((block, bi) =>
        bi !== blockIndex ? block : { ...block, list: block.list === kind ? undefined : kind }
      )
    );
  };

  // Routed through applyAndSync, not a bare setBlocks: the sync effect treats
  // an unbumped token as "typing-driven, leave the DOM alone", so a plain
  // setBlocks(EMPTY_BLOCKS) here would clear the state but leave the
  // just-published text sitting in the editor.
  const reset = () => {
    applyAndSync(() => EMPTY_BLOCKS);
    setScheduledAt('');
  };

  const save = async (mode: 'save' | 'schedule' | 'now') => {
    if (overLimit) return;
    setBusy(mode);
    setError('');
    try {
      const post = await createLinkedInPost({
        ...(seatKey ? { seatKey } : {}),
        blocks,
        ...(mode === 'schedule'
          ? { status: 'scheduled' as const, scheduledAt: new Date(scheduledAt).toISOString() }
          : mode === 'save'
            ? { status: 'draft' as const }
            : {})
      });
      if (mode === 'now') await publishLinkedInPostNow(post.id);
      setToast(
        mode === 'save'
          ? 'Draft saved.'
          : mode === 'schedule'
            ? 'Post scheduled.'
            : 'Queued to publish shortly.'
      );
      reset();
      onCreated();
    } catch (cause) {
      setError((cause as ApiError)?.message ?? errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="li-post-composer">
      <div className="li-post-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" onClick={() => toggle('bold')} aria-label="Bold">
          <Bold size={16} />
        </button>
        <button type="button" onClick={() => toggle('italic')} aria-label="Italic">
          <Italic size={16} />
        </button>
        <button type="button" onClick={() => toggle('underline')} aria-label="Underline">
          <Underline size={16} />
        </button>
        <button
          type="button"
          onClick={() => toggleListAt(currentBlockIndex(), 'bullet')}
          aria-label="Bulleted list"
        >
          <List size={16} />
        </button>
        <button
          type="button"
          onClick={() => toggleListAt(currentBlockIndex(), 'numbered')}
          aria-label="Numbered list"
        >
          <ListOrdered size={16} />
        </button>
      </div>

      <div
        ref={editorRef}
        className="li-post-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
      />

      <div className={overLimit ? 'li-post-count li-post-count--over' : 'li-post-count'}>
        {length} / {MAX_CHARS}
      </div>

      <div className="li-post-preview">
        <div className="li-post-preview-card">
          <pre>{rendered}</pre>
        </div>
      </div>

      {error && <p className="li-post-error">{error}</p>}

      <div className="li-post-actions">
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
          aria-label="Schedule for"
        />
        <button type="button" disabled={busy !== null || overLimit} onClick={() => save('save')}>
          Save draft
        </button>
        <button
          type="button"
          disabled={busy !== null || overLimit || !scheduledAt}
          onClick={() => save('schedule')}
        >
          Schedule
        </button>
        <button type="button" disabled={busy !== null || overLimit} onClick={() => save('now')}>
          Publish now
        </button>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<LinkedInPost['status'], string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing…',
  posted: 'Posted',
  failed: 'Failed',
  missed: 'Missed',
  canceled: 'Canceled'
};

function PostRow({ post, onChanged }: { post: LinkedInPost; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  // A 409 (someone else already published it, the worker already claimed it)
  // or a 5xx used to become an unhandled rejection and a row that silently
  // did not change -- the user's own click looked like it did nothing.
  const [error, setError] = useState('');
  const cancel = async () => {
    setBusy(true);
    setError('');
    try {
      await cancelLinkedInPost(post.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  const publishNow = async () => {
    setBusy(true);
    setError('');
    try {
      await publishLinkedInPostNow(post.id);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  // Sliced by CODE POINT: a styled run is astral (surrogate pairs), and a
  // UTF-16 slice can cut one in half and render a replacement character.
  const preview = [...renderPostBody(post.blocks)].slice(0, 140).join('');
  return (
    <li className="li-post-row">
      <span className={`li-post-status li-post-status--${post.status}`}>
        {STATUS_LABELS[post.status]}
      </span>
      <span className="li-post-row-preview">{preview}</span>
      <span className="li-post-row-when">
        {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : '—'}
      </span>
      {(post.status === 'failed' || post.status === 'missed') && post.error && (
        <span className="li-post-row-error" title={post.error.detail}>
          {post.error.kind}
        </span>
      )}
      {error && <span className="li-post-row-error">{error}</span>}
      {(post.status === 'draft' ||
        post.status === 'scheduled' ||
        post.status === 'failed' ||
        post.status === 'missed') && (
        <span className="li-post-row-actions">
          <button type="button" disabled={busy} onClick={publishNow}>
            Publish now
          </button>
          <button type="button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </span>
      )}
      {post.status === 'posted' && post.postedUrl && (
        <a className="li-post-row-link" href={post.postedUrl} target="_blank" rel="noreferrer">
          View on LinkedIn
        </a>
      )}
    </li>
  );
}

export function LinkedInPosts({ setToast }: { setToast: (message: string) => void }) {
  const [posts, setPosts] = useState<LinkedInPost[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setPosts(await listLinkedInPosts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load posts.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="li-posts-screen">
      <PostComposer setToast={setToast} onCreated={load} />
      {error && <p className="li-post-error">{error}</p>}
      {posts === null ? (
        <p>Loading…</p>
      ) : posts.length === 0 ? (
        <p className="li-post-empty">No posts yet — write one above.</p>
      ) : (
        <ul className="li-post-list">
          {posts.map((post) => (
            <PostRow key={post.id} post={post} onChanged={load} />
          ))}
        </ul>
      )}
    </div>
  );
}
