/**
 * The Reverie mark: three spines on a shelf and one leaning, the library the
 * app is. Fixed colours, so it reads the same in both themes. The same
 * drawing is public/favicon.svg.
 */
export function ShelfMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <rect x="10" y="12" width="9" height="40" rx="2" fill="#3f4f8f" />
      <rect x="22" y="18" width="9" height="34" rx="2" fill="#7c8ac4" />
      <rect x="34" y="12" width="9" height="40" rx="2" fill="#3f4f8f" />
      <rect x="45" y="16" width="9" height="36" rx="2" transform="rotate(12 49.5 34)" fill="#ecc59a" />
      <rect x="6" y="52" width="52" height="3" rx="1.5" fill="#7a7b80" />
    </svg>
  );
}
