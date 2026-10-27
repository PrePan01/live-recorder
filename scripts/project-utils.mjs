// 统一仓库路径、npm 命令、JSON 读取和需要同步版本的清单列表。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const JSON_VERSION_FILES = Object.freeze([
  'package.json',
  'backend/package.json',
  'frontend/package.json',
  'frontend/src-tauri/tauri.conf.json',
]);

export function readProjectJson(relativePath) {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'));
}
