import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, chmod, rename, mkdtemp, rm, readdir, readlink, lstat } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const YTDLP_VERSION = "2026.08.19";
export const MACOS_RUNTIME_TREE_SHA256 = 'd21a5dc259c4298e0c796b9e3bceeb823edde7e409ebc163cb5306ef7c80885a';
export const YTDLP_ASSETS = {
  darwin: [
    "yt-dlp_macos.zip",
    "07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8",
  ],
  win32: [
    "yt-dlp.exe",
    "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a",
  ],
  linux: [
    "yt-dlp_linux",
    "58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a",
  ],
  linux_arm64: [
    "yt-dlp_linux_aarch64",
    "b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc",
  ],
};
const digest = data => createHash('sha256').update(data).digest('hex');

export async function runtimeFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === 'runtime-manifest.json') continue;
    const name = join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await runtimeFiles(root, name));
    else if (entry.isSymbolicLink()) {
      const link = await readlink(join(root, name));
      if (!resolve(dirname(join(root, name)), link).startsWith(resolve(root) + sep))
        throw new Error('yt-dlp runtime link escapes package');
      files.push({ name, link });
    } else files.push({ name, sha256: digest(await readFile(join(root, name))) });
  }
  return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function verifyYoutubeRuntime(root, receipt, expectedTree = MACOS_RUNTIME_TREE_SHA256) {
  try {
    if (!Array.isArray(receipt.files) || !receipt.files.length) return false;
    if (digest(JSON.stringify(receipt.files)) !== expectedTree) return false;
    return digest(JSON.stringify(await runtimeFiles(root))) === expectedTree;
  } catch { return false; }
}
export async function bundleYoutube(
  directory,
  platform = process.platform,
  arch = process.arch,
) {
  const asset =
    YTDLP_ASSETS[
      platform === "linux" && arch === "arm64" ? "linux_arm64" : platform
    ];
  if (!asset)
    throw new Error(`Unsupported YouTube runtime: ${platform}/${arch}`);
  const [name, expected] = asset;
  if (platform === 'darwin') {
    const runtime = join(directory, 'youtube-runtime');
    const receiptPath = join(runtime, 'runtime-manifest.json');
    const receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null);
    if (receipt?.archiveSha256 === expected && await verifyYoutubeRuntime(runtime, receipt))
      return join(runtime, 'yt-dlp_macos');
    await mkdir(directory, { recursive: true });
    const stage = await mkdtemp(join(directory, '.youtube-runtime-'));
    try {
      const cache = join(directory, `.youtube-runtime-${YTDLP_VERSION}.zip`);
      let bytes = await readFile(cache).catch(() => null);
      if (!bytes || digest(bytes) !== expected) {
        const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${name}`,
          { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`yt-dlp download failed: HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
        if (digest(bytes) !== expected) throw new Error('yt-dlp SHA256 mismatch; refusing to package');
        await writeFile(cache, bytes);
      }
      const archive = join(stage, 'runtime.zip'), unpacked = join(stage, 'unpacked');
      await writeFile(archive, bytes);
      await mkdir(unpacked);
      if (process.platform === 'darwin') execFileSync('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
      else execFileSync('tar', ['-xf', archive, '-C', unpacked]);
      const executable = join(unpacked, 'yt-dlp_macos');
      await chmod(executable, 0o755);
      await lstat(join(unpacked, '_internal', 'Python'));
      const files = await runtimeFiles(unpacked);
      if (digest(JSON.stringify(files)) !== MACOS_RUNTIME_TREE_SHA256)
        throw new Error('yt-dlp expanded runtime integrity mismatch; refusing to package');
      await writeFile(join(unpacked, 'runtime-manifest.json'), JSON.stringify({ version: YTDLP_VERSION, archiveSha256: expected, files }));
      await rm(runtime, { recursive: true, force: true });
      await rename(unpacked, runtime);
      return join(runtime, 'yt-dlp_macos');
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  const file = join(directory, platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const valid = (data) =>
    createHash("sha256").update(data).digest("hex") === expected;
  await mkdir(directory, { recursive: true });
  const previous = await readFile(file).catch(() => null);
  if (previous && valid(previous)) return file;
  const response = await fetch(
    `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${name}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok)
    throw new Error(`yt-dlp download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes))
    throw new Error("yt-dlp SHA256 mismatch; refusing to package");
  await writeFile(`${file}.tmp`, bytes, { mode: 0o755 });
  await rename(`${file}.tmp`, file);
  await chmod(file, 0o755);
  return file;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    await bundleYoutube(
      resolve(
        process.argv[2] ??
          fileURLToPath(new URL("../src-tauri/.bundle", import.meta.url)),
      ),
    ),
  );
}
