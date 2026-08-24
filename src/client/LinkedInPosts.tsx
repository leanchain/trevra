import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bold, ImagePlus, Images, Italic, List, ListOrdered, Underline, X } from 'lucide-react';
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
  addLinkedInPostImage,
  cancelLinkedInPost,
  createLinkedInPost,
  listLinkedInPosts,
  publishLinkedInPostNow,
  updateLinkedInPost,
  type ApiError,
  type LinkedInPost
} from './api';
import { useActiveSeatKey } from './LinkedInActiveAccount';

const MAX_CHARS = 3000;
const MAX_IMAGES = 9;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EMPTY_BLOCKS: PostBlock[] = [{ runs: [{ type: 'text', text: '' }] }];

type PendingImage = { id: string; file: File; previewUrl: string };

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

function PostComposer({
  onCreated,
  setToast
}: {
  onCreated: () => void;
  setToast: (message: string) => void;
}) {
  const [seatKey] = useActiveSeatKey();
  const [blocks, setBlocks] = useState<PostBlock[]>(EMPTY_BLOCKS);
  const [scheduledAt, setScheduledAt] = useState('');
  const [media, setMedia] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState<'save' | 'schedule' | 'now' | null>(null);
  const [error, setError] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<PendingImage[]>([]);
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
  const empty = length === 0;
  const overLimit = length > MAX_CHARS;

  useEffect(() => {
    mediaRef.current = media;
  }, [media]);
  useEffect(
    () => () => {
      for (const image of mediaRef.current) URL.revokeObjectURL(image.previewUrl);
    },
    []
  );

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

  const addImages = (files: FileList | null) => {
    if (!files?.length) return;
    const chosen = Array.from(files);
    const problems: string[] = [];
    const accepted: PendingImage[] = [];
    let room = MAX_IMAGES - media.length;
    for (const file of chosen) {
      if (room <= 0) {
        problems.push(`A LinkedIn post can have at most ${MAX_IMAGES} images.`);
        break;
      }
      if (!IMAGE_TYPES.has(file.type)) {
        problems.push(`${file.name} is not a supported image. Use JPEG, PNG, WebP or GIF.`);
        continue;
      }
      if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
        problems.push(`${file.name} must be larger than 0 bytes and no more than 10 MB.`);
        continue;
      }
      accepted.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
        file,
        previewUrl: URL.createObjectURL(file)
      });
      room -= 1;
    }
    if (accepted.length > 0) setMedia((current) => [...current, ...accepted]);
    setError(problems[0] ?? '');
    if (imageInputRef.current) imageInputRef.current.value = '';
  };

  const removeImage = (imageId: string) => {
    setMedia((current) => {
      const removed = current.find((image) => image.id === imageId);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== imageId);
    });
  };

  // Routed through applyAndSync, not a bare setBlocks: the sync effect treats
  // an unbumped token as "typing-driven, leave the DOM alone", so a plain
  // setBlocks(EMPTY_BLOCKS) here would clear the state but leave the
  // just-published text sitting in the editor.
  const reset = () => {
    applyAndSync(() => EMPTY_BLOCKS);
    setScheduledAt('');
    setMedia((current) => {
      for (const image of current) URL.revokeObjectURL(image.previewUrl);
      return [];
    });
  };

  const save = async (mode: 'save' | 'schedule' | 'now') => {
    if (empty || overLimit) return;
    setBusy(mode);
    setError('');
    let createdId: string | null = null;
    try {
      // Images are uploaded as raw binary to their own endpoint, so the post is
      // born as a draft first. Only after every image is safely stored do we
      // schedule/publish it; a failed upload can therefore never leave a due
      // post whose media is only half present.
      const post = await createLinkedInPost({
        ...(seatKey ? { seatKey } : {}),
        blocks,
        status: 'draft'
      });
      createdId = post.id;
      for (const image of media) await addLinkedInPostImage(post.id, image.file);
      if (mode === 'schedule') {
        await updateLinkedInPost(post.id, {
          status: 'scheduled',
          scheduledAt: new Date(scheduledAt).toISOString()
        });
      } else if (mode === 'now') {
        await publishLinkedInPostNow(post.id);
      }
      setToast(
        mode === 'save'
          ? `Draft saved${media.length ? ` with ${media.length} image${media.length === 1 ? '' : 's'}` : ''}.`
          : mode === 'schedule'
            ? `Post scheduled${media.length ? ` with ${media.length} image${media.length === 1 ? '' : 's'}` : ''}.`
            : `Queued to publish shortly${media.length ? ` with ${media.length} image${media.length === 1 ? '' : 's'}` : ''}.`
      );
      reset();
      onCreated();
    } catch (cause) {
      setError((cause as ApiError)?.message ?? errorMessage(cause));
      // If the row was created before an image failed, show that recoverable
      // draft in history instead of leaving it invisible until the next reload.
      if (createdId) onCreated();
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
        role="textbox"
        aria-label="Post text"
        aria-multiline="true"
        suppressContentEditableWarning
        onInput={handleInput}
      />

      <div className={overLimit ? 'li-post-count li-post-count--over' : 'li-post-count'}>
        {length} / {MAX_CHARS}
      </div>

      <section className="li-post-media-section" aria-label="Post images">
        <div className="li-post-media-heading">
          <div>
            <strong>Images</strong>
            <span>
              {media.length > 0
                ? `${media.length} of ${MAX_IMAGES} added`
                : `Optional · up to ${MAX_IMAGES} images`}
            </span>
          </div>
          <input
            ref={imageInputRef}
            className="li-post-image-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            aria-label="Choose JPEG, PNG, WebP or GIF images to attach"
            multiple
            onChange={(event) => addImages(event.target.files)}
          />
          <button
            className="secondary-button"
            type="button"
            disabled={media.length >= MAX_IMAGES || busy !== null}
            onClick={() => imageInputRef.current?.click()}
          >
            <ImagePlus size={15} /> {media.length > 0 ? 'Add more' : 'Add images'}
          </button>
        </div>
        {media.length > 0 ? (
          <div className="li-post-media-grid" aria-label="Images attached to this post">
            {media.map((image, index) => (
              <figure className="li-post-media-card" key={image.id}>
                <img
                  src={image.previewUrl}
                  alt={`Post attachment ${index + 1}: ${image.file.name}`}
                />
                <figcaption title={image.file.name}>{image.file.name}</figcaption>
                <button
                  type="button"
                  aria-label={`Remove ${image.file.name}`}
                  disabled={busy !== null}
                  onClick={() => removeImage(image.id)}
                >
                  <X size={14} />
                </button>
              </figure>
            ))}
          </div>
        ) : (
          <p className="li-post-media-note">JPEG, PNG, WebP or GIF · 10 MB each</p>
        )}
      </section>

      {length > 0 && (
        <details className="mgr-inputs li-post-preview">
          <summary>Preview</summary>
          <div className="mgr-inputs-body">
            <div className="li-post-preview-card">
              <pre>{rendered}</pre>
            </div>
          </div>
        </details>
      )}

      {error && <p className="li-post-error">{error}</p>}

      <div className="li-post-actions">
        <div className="li-post-now-row">
          <button
            className="ghost-button"
            type="button"
            disabled={busy !== null || empty || overLimit}
            onClick={() => save('save')}
          >
            Save draft
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || empty || overLimit}
            onClick={() => save('now')}
          >
            Publish now
          </button>
        </div>
        <div className="li-post-schedule-row">
          <label className="li-post-schedule">
            Or schedule for
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== null || empty || overLimit || !scheduledAt}
            onClick={() => save('schedule')}
          >
            Schedule
          </button>
        </div>
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
      {post.media.length > 0 && (
        <span
          className="li-post-media-count"
          title={post.media.map((image) => image.name).join(', ')}
        >
          <Images size={13} /> {post.media.length}
        </span>
      )}
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
          <button className="secondary-button" type="button" disabled={busy} onClick={publishNow}>
            Publish now
          </button>
          <button className="ghost-button" type="button" disabled={busy} onClick={cancel}>
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
      <section className="page-panel li-posts-compose-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>New post</h3>
          </div>
        </div>
        <PostComposer setToast={setToast} onCreated={load} />
      </section>

      <section className="page-panel li-posts-history-panel">
        <div className="section-heading">
          <div>
            <h3 aria-level={2}>Scheduled and recent</h3>
          </div>
          {posts && <span className="li-chip">{posts.length}</span>}
        </div>
        {error && <p className="li-post-error">{error}</p>}
        {posts === null ? (
          <p className="empty-copy">Loading posts…</p>
        ) : posts.length === 0 ? (
          <div className="empty-state">
            <h4 aria-level={3}>No posts yet</h4>
          </div>
        ) : (
          <ul className="li-post-list">
            {posts.map((post) => (
              <PostRow key={post.id} post={post} onChanged={load} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
