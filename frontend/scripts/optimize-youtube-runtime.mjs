import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { MACOS_RUNTIME_TREE_SHA256, runtimeFiles, verifyYoutubeRuntime } from './bundle-youtube.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const CPUS = { x64: 0x01000007, arm64: 0x0100000c };
const VERSION = 1;

export function machoArchitectures(bytes) {
  if (bytes.length < 8) return [];
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcffaedfe) return [bytes.readUInt32LE(4)];
  if (magic !== 0xcafebabe) {
    if (magic === 0xcafebabf || magic === 0xfeedfacf) throw new Error('Unsupported Mach-O layout');
    return [];
  }
  const count = bytes.readUInt32BE(4);
  if (!count || count > 8 || bytes.length < 8 + count * 20) throw new Error('Invalid universal Mach-O');
  return Array.from({ length: count }, (_, i) => bytes.readUInt32BE(8 + i * 20));
}

export async function verifyOptimizedYoutubeRuntime(directory, receipt, arch) {
  if (receipt?.optimizationVersion !== VERSION || receipt.architecture !== arch ||
      receipt.sourceTreeSha256 !== MACOS_RUNTIME_TREE_SHA256 ||
      !/^[a-f0-9]{64}$/.test(receipt.treeSha256 ?? '')) return false;
  return verifyYoutubeRuntime(directory, receipt, receipt.treeSha256);
}

// Run on the final .app, before resource sealing. Tauri may dereference resource
// symlinks, so optimizing the download cache would not reliably remove duplicates.
// receiptPath is a trusted BUILD-SIDE checkpoint, never read from the installer.
export async function optimizeYoutubeRuntime(directory, { arch = process.arch, receiptPath } = {}) {
  if (process.platform !== 'darwin' || !CPUS[arch]) throw new Error(`Unsupported macOS target: ${arch}`);
  if (!receiptPath) throw new Error('Build-side YouTube receipt path is required');
  const manifestPath = join(directory, 'runtime-manifest.json');
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (original.optimizationVersion) {
    const expected = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(() => null);
    if (!await verifyOptimizedYoutubeRuntime(directory, expected, arch))
      throw new Error('Optimized YouTube runtime differs from its build checkpoint');
    return expected;
  }
  if (!await verifyYoutubeRuntime(directory, original))
    throw new Error('Original YouTube runtime integrity mismatch; refusing to optimize');
  const files = await runtimeFiles(directory);
  const signing = await mkdtemp(join(dirname(directory), '.youtube-sign-'));
  try {
    for (const file of files) {
      if (file.link !== undefined) continue;
      const path = join(directory, file.name);
      const architectures = machoArchitectures(await readFile(path));
      if (!architectures.length) continue;
      if (!architectures.includes(CPUS[arch])) throw new Error(`Missing ${arch} slice: ${file.name}`);
      if (architectures.length === 1) continue;
      // Sign outside Python.framework: codesign otherwise treats this bare
      // library as an ambiguous framework bundle rather than a Mach-O file.
      const output = join(signing, basename(path));
      execFileSync('/usr/bin/lipo', [path, '-thin', arch === 'x64' ? 'x86_64' : arch, '-output', output]);
      await chmod(output, (await lstat(path)).mode & 0o777);
      execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', output], { stdio: 'pipe' });
      const selected = machoArchitectures(await readFile(output));
      if (selected.length !== 1 || selected[0] !== CPUS[arch]) throw new Error(`Invalid thinned binary: ${file.name}`);
      await rename(output, path);
    }
    const canonical = join(directory, '_internal/Python.framework/Versions/3.14/Python');
    const expected = digest(await readFile(canonical));
    for (const name of ['_internal/Python', '_internal/Python.framework/Python', '_internal/Python.framework/Versions/Current/Python']) {
      const file = join(directory, name);
      if (digest(await readFile(file)) !== expected) throw new Error(`Python runtime layout changed: ${name}`);
      await rm(file);
      await symlink(relative(dirname(file), canonical), file);
    }
    // Also checks that the PyInstaller bootloader still finds its appended
    // archive and loads Python after thinning, signing and library deduplication.
    const version = execFileSync(join(directory, 'yt-dlp_macos'), ['--ignore-config', '--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
    if (version !== original.version) throw new Error(`Unexpected optimized yt-dlp version: ${version}`);
    const optimizedFiles = await runtimeFiles(directory);
    const receipt = {
      version: original.version, archiveSha256: original.archiveSha256,
      sourceTreeSha256: MACOS_RUNTIME_TREE_SHA256, optimizationVersion: VERSION,
      architecture: arch, files: optimizedFiles, treeSha256: digest(JSON.stringify(optimizedFiles)),
    };
    await writeFile(manifestPath, JSON.stringify(receipt));
    await writeFile(receiptPath, JSON.stringify(receipt));
    return receipt;
  } finally {
    await rm(signing, { recursive: true, force: true });
  }
}
