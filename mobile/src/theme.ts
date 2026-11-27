/**
 * Palette mirrors `web/src/design/tokens.css` — the look is single-material and
 * light-only (docs/DESIGN.md), so there is no dark variant to switch to.
 * `--font-display` (Cinzel) is a web webfont; native falls back to the platform
 * serif, which keeps the same contrast between display and body.
 */
import { Platform } from 'react-native';

export interface Theme {
  scheme: 'light' | 'dark';
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  accentContrast: string;
  route: string;
  ok: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
}

const look: Theme = {
  scheme: 'light',
  bg: '#fdf4e3',
  surface: '#fbe7c2',
  surfaceAlt: '#f9dca5',
  border: '#f6cf84',
  text: '#2c3e50',
  // --text-muted is 3.5:1 here; the step that clears AA is mixed toward ink.
  muted: '#476481',
  accent: '#e05b5b',
  accentSoft: '#f8ddd5',
  accentContrast: '#000000',
  route: '#e05b5b',
  ok: '#2f6b4f',
  warn: '#8a5a12',
  warnSoft: '#f6e3c6',
  danger: '#a3352f',
  dangerSoft: '#f8ddd5',
};

export function useTheme(): Theme {
  return look;
}

export const DISPLAY_FONT = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });
export const BODY_FONT = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });
export const MONO_FONT = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Tabular figures matter for times and prices in a list. */
export const NUMERIC = { fontVariant: ['tabular-nums'] as const };
