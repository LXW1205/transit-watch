/**
 * One palette for both schemes, matching the web app's tokens closely enough
 * that the two clients look like the same product.
 */
import { useColorScheme } from 'react-native';

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

const light: Theme = {
  scheme: 'light',
  bg: '#f4f5f7',
  surface: '#ffffff',
  surfaceAlt: '#eceef2',
  border: '#d6dae1',
  text: '#17191d',
  muted: '#626873',
  accent: '#1f5fbf',
  accentSoft: '#e7eefb',
  accentContrast: '#ffffff',
  route: '#0f766e',
  ok: '#17663c',
  warn: '#7d5500',
  warnSoft: '#fdf3dd',
  danger: '#a3221b',
  dangerSoft: '#fbeceb',
};

const dark: Theme = {
  scheme: 'dark',
  bg: '#101216',
  surface: '#191c22',
  surfaceAlt: '#20242b',
  border: '#333944',
  text: '#e8eaee',
  muted: '#9aa2af',
  accent: '#7fa9f2',
  accentSoft: '#1b2740',
  accentContrast: '#0c1016',
  route: '#2dd4bf',
  ok: '#74d3a3',
  warn: '#f0c070',
  warnSoft: '#362c17',
  danger: '#ff9b93',
  dangerSoft: '#382020',
};

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

/** Tabular figures matter for times and prices in a list. */
export const NUMERIC = { fontVariant: ['tabular-nums'] as const };
