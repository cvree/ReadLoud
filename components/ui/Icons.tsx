/* Hand-tuned 24px icon set on a 1.6 stroke. Inlined rather than pulled from
   a library so the whole set costs ~3 KB and every glyph shares one weight. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = (p: P) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...p,
});

export const Play = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.3-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14Z" />
  </svg>
);
export const Pause = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <rect x="6.5" y="4.5" width="4" height="15" rx="1.3" />
    <rect x="13.5" y="4.5" width="4" height="15" rx="1.3" />
  </svg>
);
export const SkipBack = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M18 5.5v13a1 1 0 0 1-1.55.83L8 13.7v4.8a1 1 0 0 1-2 0v-13a1 1 0 0 1 2 0v4.8l8.45-5.63A1 1 0 0 1 18 5.5Z" />
  </svg>
);
export const SkipForward = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M6 5.5v13a1 1 0 0 0 1.55.83L16 13.7v4.8a1 1 0 0 0 2 0v-13a1 1 0 0 0-2 0v4.8L7.55 4.67A1 1 0 0 0 6 5.5Z" />
  </svg>
);
/* Skip icons put the interval inside the arc, the way every media player
   does, so the number is legible at 18px instead of a smudge under it. */
export const Back15 = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4.5a8 8 0 1 0 8 8" />
    <path d="M12 1.6 8.6 4.5 12 7.4" />
    <text
      x="12.2" y="15.6" fontSize="9" fontWeight="700" letterSpacing="-0.5"
      fill="currentColor" stroke="none" textAnchor="middle"
      fontFamily="ui-sans-serif, system-ui, sans-serif"
    >
      15
    </text>
  </svg>
);
export const Forward15 = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4.5a8 8 0 1 1-8 8" />
    <path d="m12 1.6 3.4 2.9L12 7.4" />
    <text
      x="12.2" y="15.6" fontSize="9" fontWeight="700" letterSpacing="-0.5"
      fill="currentColor" stroke="none" textAnchor="middle"
      fontFamily="ui-sans-serif, system-ui, sans-serif"
    >
      15
    </text>
  </svg>
);
/* One word back / forward, for reading mode. A caret against a stop bar:
   the same grammar as the skip icons without the interval, because the
   interval here is a word rather than a number of seconds. */
export const WordBack = (p: P) => (
  <svg {...base(p)}>
    <path d="M14.5 6.5 9 12l5.5 5.5" />
    <path d="M6.5 5.5v13" />
  </svg>
);
export const WordForward = (p: P) => (
  <svg {...base(p)}>
    <path d="M9.5 6.5 15 12l-5.5 5.5" />
    <path d="M17.5 5.5v13" />
  </svg>
);
export const Rewind = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 5.5v5.2h5.2" />
    <path d="M4.6 10.7a7.6 7.6 0 1 1 1.5 6.1" />
  </svg>
);
export const Eye = (p: P) => (
  <svg {...base(p)}>
    <path d="M2.6 12S6 6.2 12 6.2 21.4 12 21.4 12 18 17.8 12 17.8 2.6 12 2.6 12Z" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);
export const Volume = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 5 6.5 8.8H3.5v6.4h3L11 19V5Z" />
    <path d="M15.2 9.2a4 4 0 0 1 0 5.6" />
    <path d="M17.9 6.5a7.8 7.8 0 0 1 0 11" />
  </svg>
);
export const VolumeMute = (p: P) => (
  <svg {...base(p)}>
    <path d="M11 5 6.5 8.8H3.5v6.4h3L11 19V5Z" />
    <path d="m15.5 9.5 5 5m0-5-5 5" />
  </svg>
);
export const Upload = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);
export const Download = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5" />
    <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </svg>
);
export const Waveform = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12h2m2-4v8m3-12v16m3-11v6m3-9v12m3-7v2m2 0h1" />
  </svg>
);
export const Doc = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </svg>
);
export const List = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
);
export const Text = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 5h14M5 5v2M19 5v2M12 5v14M9.5 19h5" />
  </svg>
);
export const Sliders = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h9m4 0h3M4 17h3m4 0h9" />
    <circle cx="15" cy="7" r="2.2" />
    <circle cx="9" cy="17" r="2.2" />
  </svg>
);
export const Close = (p: P) => (
  <svg {...base(p)}><path d="m6 6 12 12M18 6 6 18" /></svg>
);
export const Check = (p: P) => (
  <svg {...base(p)}><path d="m5 12.5 4.5 4.5L19 7" /></svg>
);
export const Chevron = (p: P) => (
  <svg {...base(p)}><path d="m9 5 7 7-7 7" /></svg>
);
export const Sparkle = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M12 2.6c.3 3.9 1.7 5.6 5.6 6.1-3.9.4-5.3 2.1-5.6 6-.3-3.9-1.7-5.6-5.6-6 3.9-.5 5.3-2.2 5.6-6.1ZM5.4 14.2c.16 2 .86 2.86 2.85 3.1-2 .2-2.7 1.06-2.85 3.06-.15-2-.85-2.86-2.85-3.06 2-.24 2.7-1.1 2.85-3.1Z" />
  </svg>
);
export const Focus = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <circle cx="12" cy="12" r="2.6" />
  </svg>
);
export const Sun = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </svg>
);
export const Moon = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z" />
  </svg>
);
export const Trash = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5" />
    <path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5M10.5 10.5v6M13.5 10.5v6" />
  </svg>
);
export const Warning = (p: P) => (
  <svg {...base(p)}>
    <path d="M10.3 4.3 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4.2M12 17h.01" />
  </svg>
);
export const Info = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8h.01" />
  </svg>
);
export const Mic = (p: P) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
  </svg>
);
export const Bolt = (p: P) => (
  <svg {...base(p)} fill="currentColor" stroke="none">
    <path d="M13.5 2 4.8 13.1a.7.7 0 0 0 .55 1.13h4.4l-1.3 7.6a.7.7 0 0 0 1.25.54l8.5-11a.7.7 0 0 0-.55-1.13h-4.3l1.4-7.35A.7.7 0 0 0 13.5 2Z" />
  </svg>
);
export const Book = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" />
    <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H19v3H6.5A2.5 2.5 0 0 1 4 20.5Z" />
  </svg>
);
export const Keyboard = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.6h.01M18 10h.01M18 13.6h.01M9.2 13.6h5.6" />
  </svg>
);
