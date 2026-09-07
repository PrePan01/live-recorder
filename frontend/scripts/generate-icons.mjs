import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(frontend, 'src-tauri', 'icons');
const temporary = mkdtempSync(path.join(tmpdir(), 'live-recorder-icons-'));
const cli = path.join(frontend, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function generate(source, destination) {
  const result = spawnSync(process.execPath, [cli, 'icon', path.join(frontend, 'public', source), '-o', destination], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`生成 ${source} 图标失败`);
}

try {
  const transparent = path.join(temporary, 'transparent');
  const macos = path.join(temporary, 'macos');
  generate('icon1.png', transparent);
  generate('icon.png', macos);
  mkdirSync(output, { recursive: true });
  // 当前桌面平台的 PNG、Windows ICO 全部使用透明素材。
  for (const entry of readdirSync(transparent, { withFileTypes: true })) {
    if (entry.isFile() && /\.(png|ico)$/.test(entry.name)) {
      copyFileSync(path.join(transparent, entry.name), path.join(output, entry.name));
    }
  }
  // macOS Finder / Dock / 应用切换器使用白底 ICNS。
  copyFileSync(path.join(macos, 'icon.icns'), path.join(output, 'icon.icns'));
  console.log('桌面图标已更新：macOS 应用白底，其余透明底。');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
