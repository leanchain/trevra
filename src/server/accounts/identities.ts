export const META_PAGE_ID_TAG_PREFIX = 'meta-page-id:';
export const META_PAGE_ID_RE = /^\d{5,30}$/;
const META_PAGE_ID_TAG_RE = /^meta-page-id:(\d{5,30})$/i;

/** Exact numeric Meta/Facebook Page identities only. Never names or vanity handles. */
export function metaPageIdsFromTags(tags: readonly string[]): string[] {
  return [
    ...new Set(
      tags
        .map((tag) => META_PAGE_ID_TAG_RE.exec(tag.trim())?.[1] ?? null)
        .filter((value): value is string => Boolean(value))
    )
  ].slice(0, 10);
}

/**
 * Replace Trevra's internal Meta identity tag while preserving every operator tag.
 * Prefix-shaped legacy/malformed identity tags are removed so one account has one
 * canonical Page identity after an edit.
 */
export function withMetaPageId(tags: readonly string[], pageId: string | null): string[] {
  const kept = tags.filter((tag) => !tag.trim().toLowerCase().startsWith(META_PAGE_ID_TAG_PREFIX));
  return pageId ? [...kept, `${META_PAGE_ID_TAG_PREFIX}${pageId}`] : kept;
}
