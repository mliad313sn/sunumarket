/**
 * Minimal authored icon set — one consistent stroke family (1.8, round caps),
 * 24 viewBox, currentColor. Kept in-repo instead of an icon dependency to hold
 * the ≤300 KB initial-bundle budget (NFR) and the no-CDN constraint.
 */
import type { ReactElement } from "react";

const P = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.5-4.5" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.3-5.4-6.3-9.7a6.3 6.3 0 1 1 12.6 0C18.3 15.6 12 21 12 21z" />
      <circle cx="12" cy="11" r="2.2" />
    </>
  ),
  phone: (
    <path d="M21.7 16.9v2.6a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.4 19.4 0 0 1-6-6A19.8 19.8 0 0 1 1.8 3.8a2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L7.6 9.4a16 16 0 0 0 6 6l1.2-1.1a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
  ),
  chat: (
    <path d="M21 11.5a8.4 8.4 0 0 1-8.4 8.4c-1.5 0-2.9-.4-4.1-1L3 20.4l1.5-5.5a8.4 8.4 0 1 1 16.5-3.4z" />
  ),
  check: <path d="m20 6.5-11 11L4 12.5" />,
  shield: (
    <>
      <path d="M12 2.8 19 5.6v5.2c0 4.5-3 7.6-7 9.4-4-1.8-7-4.9-7-9.4V5.6l7-2.8z" />
      <path d="m9 11.6 2.1 2.1 4-4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.5" />
      <path d="m21 15.5-5-5L5.5 21" />
    </>
  ),
  store: (
    <>
      <path d="M4 9.5 5.2 3.8h13.6L20 9.5" />
      <path d="M4 9.5a2.6 2.6 0 0 0 5.3 0 2.6 2.6 0 0 0 5.4 0 2.6 2.6 0 0 0 5.3 0" />
      <path d="M5.2 12v8.2h13.6V12" />
      <path d="M9.5 20.2v-5h5v5" />
    </>
  ),
  star: (
    <path d="m12 3.4 2.6 5.3 5.9.9-4.3 4.1 1 5.9L12 16.8l-5.2 2.8 1-5.9-4.3-4.1 5.9-.9L12 3.4z" />
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
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {P[name]}
    </svg>
  );
}

/** Brand mark: simple geometric monogram (also mirrored by the favicon data URI). */
export function BrandMark({ size = 22 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#0b7d4f" />
      <text
        x="16"
        y="22.5"
        textAnchor="middle"
        fontFamily="system-ui, sans-serif"
        fontSize="18"
        fontWeight="700"
        fill="#fff"
      >
        S
      </text>
    </svg>
  );
}
