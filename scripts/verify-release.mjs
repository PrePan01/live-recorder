#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === "win32";
const npm = isWindows ? "npm.cmd" : "npm";

function run(label, command, args, cwd = root, env = process.env) {
  console.log(`\n[verify-release] ${label}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: isWindows && command === npm,
    windowsHide: false,
    env,
  });
  if (result.error || result.status !== 0) {
    const reason =
      result.error?.message ?? `exit code ${result.status ?? "unknown"}`;
    throw new Error(`${label} failed: ${reason}`);
  }
}

try {
  run("Verify repository quality", process.execPath, [
    "scripts/check-quality.mjs",
    "--build-in-installer",
  ]);
  run("Build and verify installer", npm, ["run", "package"], root, {
    ...process.env,
    LR_SKIP_BACKEND_BUILD: "1",
  });
  run("Verify native service lifecycle", "cargo", [
    "test",
    "--locked",
    "--manifest-path",
    path.join(root, "frontend", "src-tauri", "Cargo.toml"),
    "--lib",
  ]);
  console.log("\n[verify-release] All release checks passed.");
} catch (error) {
  console.error(`\n[verify-release] ${error.message}`);
  process.exitCode = 1;
}
