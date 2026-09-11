import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function generateUpdateManifest(directory, version, baseUrl) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable semantic release version is required');
  // 可选的安装包基址（如七牛 S3 公开读域名）：设置后清单 asset.url 指向对象存储加速下载；
  // 客户端仍以清单内 SHA256 校验，并在对象存储不可达时回退 GitHub release。
  const base = typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl.replace(/\/+$/, '') : '';
  const files = await readdir(directory);
  const platforms = {};
  // scripts/package.mjs removes WiX's internal `_en-US` locale suffix before
  // copying the installer into release/. Match the public artifact name.
  for (const [platform, suffix] of [['macos-aarch64', '_aarch64.dmg'], ['windows-x86_64', '_x64.msi']]) {
    const candidates = files.filter((name) => name.endsWith(suffix) && name.includes(`_${version}_`));
    if (candidates.length !== 1) throw new Error(`Expected exactly one ${platform} installer for ${version}`);
    const filename = candidates[0];
    // GitHub rewrites whitespace in release-asset names. Refuse to produce a
    // manifest for an unnormalized staging directory, otherwise its URL would
    // not match the uploaded asset and clients would receive a 404.
    if (/\s/.test(filename)) throw new Error(`Release asset filename must not contain whitespace: ${filename}`);
    const path = join(directory, filename);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) throw new Error(`Empty installer: ${filename}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const encoded = encodeURIComponent(filename);
    platforms[platform] = {
      filename: basename(filename),
      url: base
        ? `${base}/${encoded}`
        : `https://github.com/PrePan01/live-recorder/releases/download/v${version}/${encoded}`,
      size: info.size,
      sha256: hash.digest('hex'),
    };
  }
  const manifest = { version, platforms };
  await writeFile(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await generateUpdateManifest(process.argv[2], process.argv[3], process.env.UPDATE_BASE_URL);
}
