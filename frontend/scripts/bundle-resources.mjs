#!/usr/bin/env node
import { copyFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";
if (process.env.LR_SKIP_BACKEND_BUILD !== "1") {
  const r = spawnSync("npm", ["--prefix", "../backend", "run", "build"], {
    stdio: "inherit",
    shell: isWin,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "src-tauri", ".bundle");
const dest = join(destDir, isWin ? "node.exe" : "node");

const candidates = [
  process.env.LR_NODE_PATH,
  process.execPath,
  // Windows 常见安装路径
  ...(isWin
    ? [
        join(
          process.env.PROGRAMFILES ?? "C:\\Program Files",
          "nodejs",
          "node.exe",
        ),
        join(process.env.LOCALAPPDATA ?? "", "Programs", "nodejs", "node.exe"),
        join(process.env.ProgramW6432 ?? "", "nodejs", "node.exe"),
      ]
    : []),
  "/usr/local/bin/node",
  "/opt/homebrew/bin/node",
  join(process.env.HOME ?? "", ".local", "bin", "node"),
];
// nvm 最高版本
try {
  const nvmDir = join(process.env.HOME ?? "", ".nvm", "versions", "node");
  const { readdirSync } = await import("node:fs");
  if (existsSync(nvmDir)) {
    const versions = readdirSync(nvmDir)
      .filter((v) => existsSync(join(nvmDir, v, "bin", "node")))
      .sort();
    if (versions.length > 0)
      candidates.push(
        join(nvmDir, versions[versions.length - 1], "bin", "node"),
      );
  }
} catch {
  /* 忽略 */
}

const src = candidates.find((p) => p && existsSync(p));
if (!src) {
  console.error("[bundle-resources] 未找到 Node 运行时，停止打包");
  process.exit(1);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[bundle-resources] node -> ${dest}`);

// 使用实际随包运行时检查原生依赖、迁移和路由编译；原生崩溃同样使打包失败。
const smoke = spawnSync(
  dest,
  ["--expose-gc", join(root, "../backend/scripts/check-runtime.mjs")],
  {
    cwd: join(root, "../backend"),
    stdio: "inherit",
    timeout: 30_000,
    windowsHide: true,
  },
);
if (smoke.status !== 0 || smoke.error) {
  console.error(
    "[bundle-resources] 随包 Node 运行时自检失败",
    smoke.error ?? smoke.signal ?? smoke.status,
  );
  process.exit(1);
}

async function ensureWebView2Loader() {
  const dest = join(root, "src-tauri", ".bundle", "WebView2Loader.dll");
  if (existsSync(dest)) {
    console.log("[bundle-resources] WebView2Loader.dll 已就位（缓存）");
    return;
  }
  const targetRoot = join(root, "src-tauri", "target");
  // ① cargo target 内查找（构建脚本通常已把 NuGet 里的 DLL 拷到 out/release 目录）。
  for (const base of [
    join(targetRoot, "release"),
    join(targetRoot, "x86_64-pc-windows-msvc", "release"),
    join(targetRoot, "x86_64-pc-windows-gnu", "release"),
  ]) {
    if (!existsSync(base)) continue;
    let names = [];
    try {
      names = readdirSync(base, { recursive: true });
    } catch {
      continue;
    }
    const hit = names.find((n) => String(n).endsWith("WebView2Loader.dll"));
    if (hit) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(base, String(hit)), dest);
      console.log(
        `[bundle-resources] WebView2Loader.dll 取自 cargo target：${hit}`,
      );
      return;
    }
  }

  const version = process.env.WEBVIEW2_LOADER_VERSION || "1.0.3405.78";
  const url = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${version}/microsoft.web.webview2.${version}.nupkg`;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  console.log(
    `[bundle-resources] cargo target 未找到，下载 WebView2Loader ${version} (${arch})…`,
  );
  const tmpDir = join(root, "src-tauri", ".bundle", ".wv2tmp");
  try {
    mkdirSync(tmpDir, { recursive: true });
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`nuget HTTP ${resp.status}`);
    writeFileSync(
      join(tmpDir, "pkg.nupkg"),
      Buffer.from(await resp.arrayBuffer()),
    );
    const extract = spawnSync(
      "tar",
      ["-xf", join(tmpDir, "pkg.nupkg"), "-C", tmpDir],
      { encoding: "utf8" },
    );
    if (extract.status !== 0)
      throw new Error(`解包失败：${extract.stderr ?? extract.status}`);
    const dll = join(
      tmpDir,
      "runtimes",
      `win-${arch}`,
      "native",
      "WebView2Loader.dll",
    );
    if (!existsSync(dll))
      throw new Error(`nupkg 内未找到 runtimes/win-${arch}/WebView2Loader.dll`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(dll, dest);
    console.log(
      `[bundle-resources] WebView2Loader.dll 已从 NuGet 解包就位（${arch}）`,
    );
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
  if (!existsSync(dest)) {
    console.error(
      "[bundle-resources] WebView2Loader.dll 获取失败：打包中止（拒绝静默缺件）",
    );
    process.exit(1);
  }
}

if (isWin) {
  await ensureWebView2Loader();
  console.log("[bundle-resources] Windows 平台跳过 dmg 残留清理");
  process.exit(0);
}

import { readdirSync, rmSync } from "node:fs";

const dmgDir = join(root, "src-tauri", "target", "release", "bundle", "dmg");
try {
  if (existsSync(dmgDir)) {
    const stale = readdirSync(dmgDir).filter((f) => /^rw\./.test(f));
    for (const f of stale) {
      try {
        rmSync(join(dmgDir, f), { force: true });
        console.log(`[bundle-resources] 清理残留 dmg 临时文件 ${f}`);
      } catch {
        /* 忽略单文件删除失败 */
      }
    }
  }
} catch {
  /* dmg 目录不存在则无需清理 */
}

try {
  const { stdout } = spawnSync("hdiutil", ["info"], { encoding: "utf8" });
  if (stdout) {
    // 卸载残留的 Live Recorder 挂载点（幂等：已挂载才卸载，未挂载静默跳过）
    const mounts = stdout
      .split("\n")
      .filter((l) => l.includes("/Volumes/Live Recorder"));
    for (const m of mounts) {
      const mountPoint = m.trim().split(/\s+/).pop();
      if (mountPoint) {
        spawnSync("hdiutil", ["detach", mountPoint, "-force"], {
          encoding: "utf8",
        });
        console.log(`[bundle-resources] 卸载残留挂载 ${mountPoint}`);
      }
    }
  }
} catch {
  /* hdiutil 不可用时忽略 */
}
