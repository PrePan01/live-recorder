import { describe, expect, it } from "vitest";
import { missingEmailConfiguration } from "./emailConfiguration";

const valid: Record<string, unknown> = {
  "email-host": "smtp.example.com",
  "email-port": 465,
  "email-from": "sender@example.com",
  "email-recipients": ["recipient@example.com"],
  "email-username": "sender@example.com",
  "email-password": "",
};
const check = (patch: Record<string, unknown> = {}, passwordSet = true) => {
  const values = { ...valid, ...patch };
  return missingEmailConfiguration((id) => values[id], passwordSet);
};

describe("email notification prerequisites", () => {
  it("reports missing and invalid connection and address fields", () => {
    expect(check({
      "email-host": "  ",
      "email-port": null,
      "email-from": "unfinished",
      "email-recipients": ", ,",
    })).toEqual(["email-host", "email-port", "email-from", "email-recipients"]);
    expect(check({ "email-port": 65536 })).toEqual(["email-port"]);
    expect(check({ "email-recipients": ["invalid"] })).toEqual(["email-recipients"]);
    expect(check({ "email-recipients": [] })).toEqual(["email-recipients"]);
  });

  it("accepts stored passwords and pending password edits", () => {
    expect(check()).toEqual([]);
    expect(check({}, false)).toEqual(["email-password"]);
    expect(check({ "email-password": "new-password" }, false)).toEqual([]);
    expect(check({ "email-recipients": "one@example.com, two@example.com" })).toEqual([]);
  });

  it("allows SMTP servers without authentication", () => {
    expect(check({ "email-username": "" }, false)).toEqual([]);
  });
});
