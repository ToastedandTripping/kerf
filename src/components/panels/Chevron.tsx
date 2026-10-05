/** The one disclosure glyph (UI polish P49): a 10x10 stroked chevron in
 *  currentColor, pointing right when closed and rotated 90 degrees when open.
 *  Always drawn left of its title. No transition: collapse is instant. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none" }}
    >
      <path d="M3.5 2L6.5 5L3.5 8" />
    </svg>
  );
}
