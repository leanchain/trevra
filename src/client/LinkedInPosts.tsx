import { useMemo, useRef, useState } from 'react';
import { Bold, Italic, Underline, List, ListOrdered } from 'lucide-react';
import {
  applyStyleToSelection,
  plainTextLength,
  renderPostBody,
  type PostBlock,
  type PostStyle,
  type RunPosition
} from '../shared/linkedin-post-format';
import { createLinkedInPost, publishLinkedInPostNow, type ApiError } from './api';
import { useActiveSeatKey } from './LinkedInAccounts';

const MAX_CHARS = 3000;
const EMPTY_BLOCKS: PostBlock[] = [{ runs: [{ type: 'text', text: '' }] }];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/**
 * A block/run/offset position from the browser's own Selection, resolved
 * against `data-block`/`data-run` attributes the composer stamps onto every
 * run span it renders -- the DOM is the source of the (block, run) pair; the
 * character offset within a run comes from the Range's own offset, since a
 * run renders as one text node.
 */
function positionFromNode(node: Node, offset: number): RunPosition | null {
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest(
    '[data-run]'
  );
  if (!el) return null;
  const block = Number(el.getAttribute('data-block'));
  const run = Number(el.getAttribute('data-run'));
  if (Number.isNaN(block) || Number.isNaN(run)) return null;
  return { block, run, offset };
}

function currentSelection(container: HTMLElement): { start: RunPosition; end: RunPosition } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = positionFromNode(range.startContainer, range.startOffset);
  const end = positionFromNode(range.endContainer, range.endOffset);
  if (!start || !end) return null;
  return { start, end };
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

  const rendered = useMemo(() => renderPostBody(blocks), [blocks]);
  const length = useMemo(() => plainTextLength(blocks), [blocks]);
  const overLimit = length > MAX_CHARS;

  const toggle = (style: PostStyle) => {
    const el = editorRef.current;
    if (!el) return;
    const selection = currentSelection(el);
    if (!selection) return; // no-selection "arm for next typed text" is a Task-8-scale follow-up; M1 requires a selection
    setBlocks((current) => applyStyleToSelection(current, selection, style));
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
    const selection = el ? currentSelection(el) : null;
    return selection?.start.block ?? blocks.length - 1;
  };

  const editRunText = (blockIndex: number, runIndex: number, text: string) => {
    setBlocks((current) =>
      current.map((block, bi) =>
        bi !== blockIndex
          ? block
          : {
              ...block,
              runs: block.runs.map((run, ri) =>
                ri !== runIndex || run.type !== 'text' ? run : { ...run, text }
              )
            }
      )
    );
  };

  const toggleListAt = (blockIndex: number, kind: 'bullet' | 'numbered') => {
    setBlocks((current) =>
      current.map((block, bi) =>
        bi !== blockIndex ? block : { ...block, list: block.list === kind ? undefined : kind }
      )
    );
  };

  const reset = () => {
    setBlocks(EMPTY_BLOCKS);
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
      >
        {blocks.map((block, bi) => (
          <div
            key={bi}
            data-block={bi}
            className={block.list ? `li-post-line li-post-line--${block.list}` : 'li-post-line'}
          >
            {block.runs.map((run, ri) =>
              run.type === 'text' ? (
                <span
                  key={ri}
                  data-block={bi}
                  data-run={ri}
                  className={[
                    run.bold && 'li-post-run--bold',
                    run.italic && 'li-post-run--italic',
                    run.underline && 'li-post-run--underline'
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={(event) =>
                    editRunText(bi, ri, (event.target as HTMLElement).textContent ?? '')
                  }
                >
                  {run.text}
                </span>
              ) : run.type === 'mention' ? (
                <span
                  key={ri}
                  data-block={bi}
                  data-run={ri}
                  className="li-post-mention"
                  contentEditable={false}
                >
                  @{run.displayText}
                </span>
              ) : (
                <br key={ri} />
              )
            )}
          </div>
        ))}
      </div>

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
