import type { ReactNode } from "react";
import { SettingsContext } from "./SettingsContext";
import { useSettingsModel } from "./useSettingsModel";
export function SettingsProvider({ children }: { children: ReactNode }) {
  const model = useSettingsModel();
  return (
    <SettingsContext.Provider value={model}>
      {children}
    </SettingsContext.Provider>
  );
}
