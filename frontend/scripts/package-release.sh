#!/usr/bin/env bash
# 可靠的桌面生产打包脚本（绕过偶发的 bundle_dmg.sh 失败）：
#   1) 后端构建 backend/dist 到最新 main
#   2) tauri 只打 .app（dmg 目标临时移除，避免 flaky bundle_dmg.sh）
#   3) 用 hdiutil create 直接生成 .dmg（稳定，不依赖 create-dmg 的 rw 临时镜像流程）
#   4) 产物拷贝到仓库根 release/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FRONTEND="$ROOT/frontend"
BACKEND="$ROOT/backend"
RELEASE="$ROOT/release"
TAURI_CONF="$FRONTEND/src-tauri/tauri.conf.json"
DIST_APP="$FRONTEND/src-tauri/target/release/bundle/macos/Live Recorder.app"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$TAURI_CONF")"

echo "[package-release] 1/4 构建后端 dist（最新 main）…"
(cd "$BACKEND" && npm run build)

echo "[package-release] 2/4 tauri 构建 .app（临时移除 dmg target，规避 bundle_dmg.sh 偶发失败）…"
# 备份 tauri.conf.json，临时把 bundle.targets 中的 dmg 去掉
cp "$TAURI_CONF" "$TAURI_CONF.bak"
node -e '
const fs = require("fs");
const p = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.bundle.targets = (cfg.bundle.targets || []).filter((t) => t !== "dmg");
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$TAURI_CONF"
# 清理上次 dmg 失败残留，避免干扰
rm -rf "$FRONTEND/src-tauri/target/release/bundle/dmg"
trap 'mv "$TAURI_CONF.bak" "$TAURI_CONF"' EXIT

(cd "$FRONTEND" && npm run tauri:build)

echo "[package-release] 3/4 hdiutil 生成 .dmg（稳定路径）…"
rm -rf "$FRONTEND/src-tauri/target/release/bundle/dmg"
mkdir -p "$FRONTEND/src-tauri/target/release/bundle/dmg"
STAGING="$(mktemp -d)"
cp -R "$DIST_APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
DMG_PATH="$FRONTEND/src-tauri/target/release/bundle/dmg/Live Recorder_${VERSION}_aarch64.dmg"
hdiutil create -volname "Live Recorder" -srcfolder "$STAGING" -ov -format UDZO "$DMG_PATH"
rm -rf "$STAGING"

echo "[package-release] 4/4 拷贝产物到 release/ …"
mkdir -p "$RELEASE"
rm -rf "$RELEASE/Live Recorder.app"
cp -R "$DIST_APP" "$RELEASE/"
rm -f "$RELEASE/Live Recorder_${VERSION}_aarch64.dmg"
cp "$DMG_PATH" "$RELEASE/"

echo "[package-release] 完成 ✅"
echo "  .app: $RELEASE/Live Recorder.app"
echo "  .dmg: $RELEASE/Live Recorder_${VERSION}_aarch64.dmg"
