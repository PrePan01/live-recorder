import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ConfigProvider, theme as antdTheme } from 'antd';
import type { ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type AppThemeMode = 'light' | 'dark';

interface ThemeContextValue {
  preference: ThemePreference;
  mode: AppThemeMode;
  setPreference: (p: ThemePreference) => void;
}

const STORAGE_KEY = 'live-recorder-theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

export const baseToken = {
  colorPrimary: '#2563eb',
  colorInfo: '#2563eb',
  colorSuccess: '#16a34a',
  colorWarning: '#d97706',
  colorError: '#dc2626',
  borderRadius: 10,
  controlHeight: 36,
  fontSize: 14,
  wireframe: false,
  motionDurationMid: '0.25s',
  motionDurationSlow: '0.35s',
};

const componentTokens = {
  Card: { paddingLG: 20 },
  Button: { fontWeight: 600 },
  Menu: { itemHeight: 44, itemBorderRadius: 8, itemMarginInline: 8 },
  Table: { headerBg: 'transparent' },
};

export function initialPreference(): ThemePreference {
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return 'system';
}

export function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveMode(preference: ThemePreference): AppThemeMode {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, preference);
  }, [preference]);

  const mode = useMemo(() => resolveMode(preference), [preference]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
  }, [mode]);

  useEffect(() => {
    if (preference !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setPreference('system');
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [preference]);

  const value = useMemo(() => ({ preference, mode, setPreference }), [preference, mode]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        theme={{
          algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: baseToken,
          components: componentTokens,
          cssVar: { key: 'lr' },
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return value;
}