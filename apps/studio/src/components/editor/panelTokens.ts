// ── Design Panel Tokens (for inline style={{}} usage) ──────────────────
// Tailwind classes use `panel-*` from tailwind.config.js theme.extend.colors.
// This file provides the same values for inline styles where Tailwind can't reach.

export const P = {
  accent: "#D97757",
  borderInput: "#D9D4C5",
  textMuted: "#7A766E",
  white: "#FFFFFF",
} as const;
