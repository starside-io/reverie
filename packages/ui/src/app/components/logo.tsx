/**
 * The Reverie mark: an hourglass, time settling into something kept. The
 * glass and sand have fixed colours; the two caps take the text colour, so
 * the mark reads in both themes. public/favicon.svg is the same drawing.
 */
export function HourglassMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <path
        d="M16 10H48C48 22 38 26 34 32C38 38 48 42 48 54H16C16 42 26 38 30 32C26 26 16 22 16 10Z"
        fill="#4f9a68"
      />
      <path d="M22 14H42C40 20 35 23 32 27C29 23 24 20 22 14Z" fill="#a3d9b0" />
      <path d="M20 54C21 47 27 44 32 40C37 44 43 47 44 54Z" fill="#ecc59a" />
      <rect x="12" y="6" width="40" height="4.5" rx="2.25" fill="currentColor" />
      <rect x="12" y="53.5" width="40" height="4.5" rx="2.25" fill="currentColor" />
    </svg>
  );
}
