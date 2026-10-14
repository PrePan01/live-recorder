import { createContext, useContext } from "react";
import type { useSettingsModel } from "./useSettingsModel";
export const SettingsContext = createContext<ReturnType<
  typeof useSettingsModel
> | null>(null);
export function useSettingsModelContext() {
  const model = useContext(SettingsContext);
  if (!model) throw new Error("SettingsProvider is required");
  return model;
}
