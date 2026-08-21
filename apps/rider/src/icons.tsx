/**
 * Authored icon set for the rider PWA — one stroke family (2.0, round caps —
 * heavier than the buyer app for sunlight legibility), 24 viewBox, currentColor.
 * In-repo instead of an icon dependency to hold the bundle budget (no CDN).
 */
import type { ReactElement } from "react";

const P = {
  package: (
    <>
      <path d="M21 8.2v7.6a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4a2 2 0 0 1-1-1.7V8.2a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4a2 2 0 0 1 1 1.7z" />
      <path d="M3.3 7.3 12 12.3l8.7-5M12 22V12.3" />
    </>
  ),
  route: (
    <>
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <path d="M8.5 19h6a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7h6" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.3-5.4-6.3-9.7a6.3 6.3 0 1 1 12.6 0C18.3 15.6 12 21 12 21z" />
      <circle cx="12" cy="11" r="2.2" />
    </>
  ),
  check: <path d="m20 6.5-11 11L4 12.5" />,
  alert: (
    <>
      <path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4.5M12 17.5h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.5 11A8.6 8.6 0 0 0 5.9 6.3L3.5 8.6" />
      <path d="M3.5 4v4.6H8M3.5 13a8.6 8.6 0 0 0 14.6 4.7l2.4-2.3" />
      <path d="M20.5 20v-4.6H16" />
    </>
  ),
  cash: (
    <>
      <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 10.5v.01M18 13.5v.01" />
    </>
  )
};

export type IconName = keyof typeof P;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  );
}

/** Rider brand mark: high-vis variant of the SunuMarket monogram. */
export function BrandMark({ size = 24 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#ffd400" />
      <text
        x="16"
        y="22.5"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontSize="18"
        fontWeight="700"
        fill="#161200"
      >
        S
      </text>
    </svg>
  );
}
