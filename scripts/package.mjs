#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";
const bundle = path.join(
  root,
  "frontend",
  "src-tauri",
  "target",
  "release",
  "bundle",
);
const release = path.join(root, "release");
const products = [];
let exitCode = 0;

class StepError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  if (r.status !== 0 || r.error) {
    throw new StepError(
      `命令失败: ${cmd} ${args.join(" ")} (${r.error ? r.error.message : `exit ${r.status}`})`,
      (r.status ?? 1) || 1,
    );
  }
};

const backendDir = path.join(root, "backend");

function restoreBackendDeps() {
  if (process.env.LR_SKIP_BACKEND_RESTORE === "1") return;
  console.log("[package] 恢复后端完整依赖（npm ci）…");
  const r = spawnSync("npm", ["ci", "--include=dev"], {
    cwd: backendDir,
    stdio: "inherit",
    shell: isWin,
  });
  if (r.error || r.status !== 0) {
    console.warn(
      "[package] 恢复 npm ci 失败，如需开发请手动 cd backend && npm ci",
    );
  }
}

try {
  console.log("[package] 1/4 构建后端 dist…");
  if (process.env.LR_SKIP_BACKEND_BUILD === "1") {
    if (!existsSync(path.join(root, "backend", "dist", "index.js"))) {
      throw new Error(
        "LR_SKIP_BACKEND_BUILD=1 requires an already compiled backend/dist/index.js",
      );
    }
    console.log("[package] 使用已构建并验证的后端 dist");
  } else {
    run("npm", ["run", "build"], path.join(root, "backend"));
  }

  console.log("[package] 精简后端 node_modules 为生产依赖…");
  run("npm", ["prune", "--omit=dev"], backendDir);

  const stripDepTests = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      if (e.name === "test" || e.name === "tests")
        rmSync(child, { recursive: true, force: true });
      else stripDepTests(child);
    }
  };
  const depRoot = path.join(backendDir, "node_modules");
  if (existsSync(depRoot)) {
    stripDepTests(depRoot);
    console.log("[package] 已清理依赖内 test/tests 目录");
  }

  console.log("[package] 2/4 tauri build…");
  process.env.LR_SKIP_BACKEND_BUILD = "1";
  run(
    isWin ? "npx.cmd" : "npx",
    [
      "tauri",
      "build",
      ...(process.env.CI ? ["--verbose"] : []),
      "--",
      "--locked",
    ],
    path.join(root, "frontend"),
  );

  // 3) macOS dmg
  if (!isWin) {
    console.log("[package] 3/4 生成 dmg…");
    const dmgDir = path.join(bundle, "dmg");
    if (existsSync(dmgDir)) {
      for (const f of readdirSync(dmgDir))
        if (/\.dmg$/i.test(f)) rmSync(path.join(dmgDir, f), { force: true });
    }
    run("node", ["scripts/bundle-dmg.mjs"], path.join(root, "frontend"));
    const produced = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (existsSync(dmgDir)) {
        for (const f of readdirSync(dmgDir))
          if (/\.dmg$/i.test(f)) produced.push(f);
      }
      if (produced.length > 0) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (produced.length === 0) {
      throw new Error(
        `bundle-dmg 未产出 .dmg（${dmgDir} 为空）——请检查 hdiutil/codesign 输出`,
      );
    }
    console.log(`[package] 已生成 dmg: ${produced.join(", ")}`);
  }

  mkdirSync(release, { recursive: true });
  for (const f of readdirSync(release)) {
    if (
      /\.(dmg|exe|msi)$/.test(f) ||
      f === "Live Recorder.app" ||
      f === ".DS_Store" ||
      /^Live Recorder/.test(f)
    ) {
      rmSync(path.join(release, f), { recursive: true, force: true });
    }
  }
  if (!isWin) {
    const macosDir = path.join(bundle, "macos");
    if (existsSync(macosDir)) {
      for (const f of readdirSync(macosDir)) {
        if (f === ".DS_Store") continue;
        cpSync(path.join(macosDir, f), path.join(release, f), {
          recursive: true,
        });
        products.push(f);
        console.log(`[package] 拷贝 -> release/${f}`);
      }
    }
    const dmgDir = path.join(bundle, "dmg");
    if (existsSync(dmgDir)) {
      for (const f of readdirSync(dmgDir)) {
        if (/\.dmg$/i.test(f)) {
          copyFileSync(path.join(dmgDir, f), path.join(release, f));
          products.push(f);
          console.log(`[package] 拷贝 -> release/${f}`);
        }
      }
    }
    const missing = ["app", "dmg"].filter(
      (kind) =>
        !products.some((p) =>
          kind === "app" ? p.endsWith(".app") : p.endsWith(".dmg"),
        ),
    );
    if (missing.length > 0) {
      throw new Error(
        `macOS 产物缺失: ${missing.join("/")}（release/ 现含: ${products.join(", ") || "无"}）`,
      );
    }
  } else {
    for (const sub of ["nsis"]) {
      const dir = path.join(bundle, sub);
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          copyFileSync(path.join(dir, f), path.join(release, f));
          products.push(f);
          console.log(`[package] 拷贝 -> release/${f}`);
        }
      }
    }
    const setups = products.filter((f) => f.endsWith("-setup.exe"));
    if (setups.length === 0) {
      throw new Error(
        `Windows 产物缺失: *-setup.exe（release/ 现含: ${products.join(", ") || "无"}）`,
      );
    }
    if (!products.some((f) => f.endsWith(".sig"))) {
      console.warn(
        "[package] 警告: 未见 .sig 更新签名（发布用包需配置 TAURI_SIGNING_PRIVATE_KEY）",
      );
    }
  }

  if (!isWin && process.env.TAURI_SIGNING_PRIVATE_KEY) {
    for (const file of products.filter((file) => file.endsWith(".dmg"))) {
      run(
        "npx",
        ["tauri", "signer", "sign", path.join(release, file)],
        path.join(root, "frontend"),
      );
    }
  }
  if (process.env.LR_REQUIRE_SIGNATURE === "1") {
    for (const file of products.filter((file) => /\.(dmg|exe)$/.test(file))) {
      if (!existsSync(path.join(release, `${file}.sig`)))
        throw new Error(`Missing installer signature: ${file}`);
    }
  }

  rmSync(bundle, { recursive: true, force: true });
} catch (error) {
  console.error(
    `[package] 打包失败: ${error && error.message ? error.message : error}`,
  );
  if (!(error instanceof StepError) && error && error.stack)
    console.error(error.stack);
  exitCode = error instanceof StepError ? error.exitCode : 1;
} finally {
  restoreBackendDeps();
}

if (exitCode === 0) {
  console.log(
    `[package] 完成 ✅ 产物已输出到 release/: ${products.join(", ")}`,
  );
  console.log("[package] 装机校验…");
  const verify = spawnSync(
    process.execPath,
    ["scripts/check-installation.mjs"],
    { cwd: root, stdio: "inherit", shell: isWin },
  );
  if (verify.error || verify.status !== 0) {
    console.error(
      `[package] 装机校验失败: ${verify.error ? verify.error.message : `exit ${verify.status}`}`,
    );
    exitCode = (verify.status ?? 1) || 1;
  } else {
    console.log("[package] 装机校验通过 ✅");
  }
}
process.exit(exitCode);
