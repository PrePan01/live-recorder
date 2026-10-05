#!/usr/bin/env node
// 可靠生成 macOS DMG：用 hdiutil create 直接生成（绕开 tauri bundle_dmg.sh 的偶发失败）。
// 幂等：每次重建 rw 临时镜像→attach 放入 .app + Applications 快捷方式→detach→convert 为 UDZO→清理。
// 失败自动清理临时文件，下次可重跑。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfig = JSON.parse(
  readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
);
const productName = tauriConfig.productName;
const version = tauriConfig.version;
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const dmgName = `${productName}_${version}_${arch}.dmg`;
const appPath = join(
  root,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  `${productName}.app`,
);
const outDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
const tmpDir = join(outDir, ".dmg-stage");
const rwImage = join(outDir, "rw.live-recorder.dmg");
const mountPoint = join(tmpDir, "mount");
let attached = false;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return r;
};

function checked(cmd, args) {
  const result = sh(cmd, args);
  if (result.status !== 0)
    throw new Error(
      `${cmd} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  return result;
}

function cleanup() {
  const stale = sh("hdiutil", ["info"])
    .stdout.split("\n")
    .some((line) => line.trimEnd().endsWith(`\t${mountPoint}`));
  if (attached || stale) {
    checked("hdiutil", ["detach", mountPoint, "-force"]);
    attached = false;
  }
  // 清理临时目录/镜像
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(rwImage, { force: true });
  // 清理其它 rw.* 残留
  try {
    for (const f of readdirSync(outDir))
      if (/^rw\./.test(f)) rmSync(join(outDir, f), { force: true });
  } catch {
    /* ignore */
  }
}

function ensureValidAppSignature() {
  const verifyArgs = ["--verify", "--deep", "--strict", appPath];
  if (sh("codesign", verifyArgs).status === 0) {
    console.log("[bundle:dmg] .app 签名校验通过");
    return;
  }

  console.log("[bundle:dmg] .app 未完整签名，应用 ad-hoc 签名以封印所有资源");
  const sign = sh("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    appPath,
  ]);
  if (sign.status !== 0) {
    throw new Error(`codesign 失败：${sign.stderr || sign.stdout}`);
  }

  const verify = sh("codesign", verifyArgs);
  if (verify.status !== 0) {
    throw new Error(`codesign 校验失败：${verify.stderr || verify.stdout}`);
  }
}

function run() {
  if (!existsSync(appPath)) {
    console.error(`[bundle:dmg] 未找到 ${appPath}，请先 tauri build 产出 .app`);
    process.exit(1);
  }
  ensureValidAppSignature();
  console.log(`[bundle:dmg] 生成 ${dmgName}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // 1. 暂存 .app + Applications 快捷方式
  cpSync(appPath, join(tmpDir, `${productName}.app`), { recursive: true });
  try {
    rmSync(join(tmpDir, "Applications"), { force: true });
  } catch {}
  symlinkSync("/Applications", join(tmpDir, "Applications"));

  // 2. 创建 rw 镜像并 attach
  checked("hdiutil", [
    "create",
    "-volname",
    productName,
    "-srcfolder",
    tmpDir,
    "-ov",
    "-format",
    "UDRW",
    "-nospotlight",
    "-fs",
    "HFS+",
    rwImage,
  ]);
  mkdirSync(mountPoint, { recursive: true });
  checked("hdiutil", [
    "attach",
    "-readwrite",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    mountPoint,
    rwImage,
  ]);
  attached = true;

  // 3. 应用图标/布局（可选，保持最小）
  // 4. detach
  const det = sh("hdiutil", ["detach", mountPoint]);
  if (det.status !== 0) {
    // detach 可能因 busy 失败，强制
    checked("hdiutil", ["detach", mountPoint, "-force"]);
  }

  attached = false;

  // 5. 转换 UDZO（压缩只读）
  checked("hdiutil", [
    "convert",
    rwImage,
    "-format",
    "UDZO",
    "-o",
    join(outDir, dmgName),
    "-ov",
  ]);

  // 6. 清理
  cleanup();
  console.log(`[bundle:dmg] OK -> ${join(outDir, dmgName)}`);
}

try {
  cleanup();
  run();
} catch (err) {
  console.error(`[bundle:dmg] 失败: ${err.message}`);
  cleanup();
  process.exit(1);
}
