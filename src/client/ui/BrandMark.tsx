/* The Trevra glyph: three modules composing a T. Ships as markup rather than
 * a font character so every surface renders the mark itself, and inherits
 * `currentColor` so the green-on-white and white-on-green tiles both work. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 42 34" aria-hidden="true" focusable="false" fill="currentColor">
      <rect width="11" height="11" rx="3" />
      <rect x="31" width="11" height="11" rx="3" />
      <rect x="14.5" width="13" height="34" rx="3.4" />
    </svg>
  );
}
