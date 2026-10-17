/**
 * Calm companion palette — Gemini-like phone chat (soft light, one accent).
 * Not purple-glow AI slop; readable one-handed on Pixel.
 */
export const colors = {
  bg: '#f4f5f7',
  surface: '#ffffff',
  surfaceMuted: '#eef0f3',
  border: '#e2e5ea',
  text: '#1a1c1e',
  muted: '#5f6368',
  accent: '#1e6b4a',
  accentSoft: '#e6f2ec',
  accentText: '#ffffff',
  danger: '#b3261e',
  warn: '#8f6000',
  healthy: '#1e6b4a',
  degraded: '#8f6000',
  down: '#b3261e',
  /** User bubble */
  bubbleUser: '#f0f1f3',
  /** Agent identity in the transcript only (UI-SPEC); not a second brand accent. */
  identity: '#2563eb',
  /** Text on accent / dark fills */
  onDark: '#ffffff',
  surfaceRaised: '#f7f8fa',
  borderStrong: '#c5c9d0',
  dangerSoft: '#fdecea',
  dangerText: '#8c1d18',
  warnSoft: '#fff4e0',
  warnText: '#5c3e00',
  successSoft: '#e6f4ea',
  successText: '#0d5d2c',
  accentBorder: '#cfe6da',
  scrim: '#000000',
  /** Assistant bubble */
  bubbleAssistant: '#ffffff',
};

/** 4pt scale (UI-SPEC). */
export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
};

export const radii = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
};

/** UI-SPEC type scale: four sizes (13 / 16 / 20 / 28), weights 400 and 600 only. */
export const type = {
  title: 28,
  sub: 20,
  section: 13,
  body: 16,
  meta: 13,
  chip: 13,
};

/** UI-SPEC: weights 400 and 600 only. */
export const weight = { regular: '400', semibold: '600' } as const;

/** Line heights paired with the type scale: meta 13 → 18, body 16 → 22, sub 20 → 26. */
export const lineHeight = { meta: 18, body: 22, sub: 26 } as const;
