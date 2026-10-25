import { BY_ID, validateValue } from "./catalog";

export function missingEmailConfiguration(
  value: (id: string) => unknown,
  passwordSet: boolean,
): string[] {
  const missing = [
    "email-host",
    "email-port",
    "email-from",
    "email-recipients",
  ].filter((id) => {
    const raw = value(id);
    const current = id === "email-recipients" && !Array.isArray(raw)
      ? String(raw ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
      : raw;
    const empty = Array.isArray(current)
      ? !current.some((entry) => String(entry).trim())
      : !String(current ?? "").trim();
    return empty || !!validateValue(BY_ID[id]!, current);
  });
  if (
    String(value("email-username") ?? "").trim() &&
    !passwordSet &&
    !String(value("email-password") ?? "").length
  ) {
    missing.push("email-password");
  }
  return missing;
}
