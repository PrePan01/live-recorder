#!/usr/bin/env bash
# 打包后把产物同步到仓库根 release/（供 PrePan 验收）。
# 供 npm run tauri:build 之后自动调用；package:release 脚本内部已内联相同逻辑。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RELEASE="$ROOT/release"
BUNDLE="$ROOT/frontend/src-tauri/target/release/bundle"
APP_SRC="$BUNDLE/macos/Live Recorder.app"
DMG_SRC="$BUNDLE/dmg/Live Recorder_0.5.42_aarch64.dmg"

# 校验源 .app 完整（关键资源 node 二进制存在），避免打包未完成/损坏时拷贝出残件。
if [ -d "$APP_SRC" ] && [ ! -f "$APP_SRC/Contents/Resources/node" ]; then
  echo "[sync-release] 警告：源 .app 缺少 node 运行时，跳过 .app 同步" >&2
  APP_SRC=""
fi

mkdir -p "$RELEASE"

if [ -n "$APP_SRC" ]; then
  rm -rf "$RELEASE/Live Recorder.app"
  # ditto 保留符号链接/扩展属性，比 cp -R 对 .app bundle 更可靠
  ditto "$APP_SRC" "$RELEASE/Live Recorder.app"
  echo "[sync-release] .app -> $RELEASE/Live Recorder.app"
fi

if [ -f "$DMG_SRC" ]; then
  rm -f "$RELEASE/Live Recorder_0.5.42_aarch64.dmg"
  cp "$DMG_SRC" "$RELEASE/"
  echo "[sync-release] .dmg -> $RELEASE/Live Recorder_0.5.42_aarch64.dmg"
fi

echo "[sync-release] release/ 已同步：" && ls -lah "$RELEASE" | tail -3