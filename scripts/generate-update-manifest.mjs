import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { verifyInstallerSignature } from "./verify-installer-signatures.mjs";
export const updaterPublicKey = JSON.parse(
  readFileSync(
    new URL("../frontend/src-tauri/tauri.conf.json", import.meta.url),
  ),
).plugins.updater.pubkey;

export function validateReleaseNotes(value, version) {
  const releases =
    value && typeof value === "object" && Array.isArray(value.releases)
      ? value.releases
      : null;
  if (!releases) throw new Error("Release notes must contain a releases array");
  const seen = new Set();
  for (const release of releases) {
    if (
      !release ||
      typeof release !== "object" ||
      typeof release.version !== "string" ||
      !/^\d+\.\d+\.\d+$/.test(release.version) ||
      seen.has(release.version) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(release.publishedAt) ||
      !Array.isArray(release.notes) ||
      release.notes.length === 0 ||
      !release.notes.every(
        (note) => typeof note === "string" && note.trim().length > 0,
      )
    ) {
      throw new Error("Release notes format is invalid");
    }
    seen.add(release.version);
  }
  const current = releases.find((release) => release.version === version);
  if (!current) throw new Error(`Missing release notes for ${version}`);
  return { releases, current };
}

/** 读取 tauri build 产出的 `.sig` 内容（客户端清单的 signature 字段要求是签名本身，不是路径）。 */
async function readUpdaterSignature(directory, filename) {
  let raw;
  try {
    raw = await readFile(join(directory, `${filename}.sig`), "utf8");
  } catch {
    throw new Error(
      `Missing updater signature for ${filename}: sign the final installer with TAURI_SIGNING_PRIVATE_KEY`,
    );
  }
  const signature = raw.trim();
  if (!signature) throw new Error(`Empty updater signature: ${filename}.sig`);
  return signature;
}

export async function generateUpdateManifest(
  directory,
  version,
  baseUrl,
  releaseNotesPath = "release-notes.json",
  pubkey = updaterPublicKey,
) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("A stable semantic release version is required");
  // 可选的安装包基址（如七牛 S3 公开读域名）：设置后清单 asset.url 指向对象存储加速下载；
  // 客户端仍以清单内 SHA256 校验，并在对象存储不可达时回退 GitHub release。
  const base =
    typeof baseUrl === "string" && baseUrl.length > 0
      ? baseUrl.replace(/\/+$/, "")
      : "";
  const notesPath = resolve(releaseNotesPath);
  const notes = validateReleaseNotes(
    JSON.parse(await readFile(notesPath, "utf8")),
    version,
  );
  const files = await readdir(directory);
  const platforms = {};
  // NSIS emits an executable setup package; public names are normalized by the
  // release workflow before this manifest is generated.
  for (const [platform, suffix] of [
    ["macos-aarch64", "_aarch64.dmg"],
    ["windows-x86_64", "_x64-setup.exe"],
  ]) {
    const candidates = files.filter(
      (name) => name.endsWith(suffix) && name.includes(`_${version}_`),
    );
    if (candidates.length !== 1)
      throw new Error(
        `Expected exactly one ${platform} installer for ${version}`,
      );
    const filename = candidates[0];
    // GitHub rewrites whitespace in release-asset names. Refuse to produce a
    // manifest for an unnormalized staging directory, otherwise its URL would
    // not match the uploaded asset and clients would receive a 404.
    if (/\s/.test(filename))
      throw new Error(
        `Release asset filename must not contain whitespace: ${filename}`,
      );
    const path = join(directory, filename);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0)
      throw new Error(`Empty installer: ${filename}`);
    const hash = createHash("sha256");
    const prehash = createHash("blake2b512");
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
      prehash.update(chunk);
    }
    const signature = await readUpdaterSignature(directory, filename);
    verifyInstallerSignature(pubkey, signature, prehash.digest());
    const encoded = encodeURIComponent(filename);
    platforms[platform] = {
      filename: basename(filename),
      url: base
        ? `${base}/${encoded}`
        : `https://github.com/PrePan01/live-recorder/releases/download/v${version}/${encoded}`,
      size: info.size,
      sha256: hash.digest("hex"),
      signature,
    };
  }
  const manifest = {
    version,
    publishedAt: notes.current.publishedAt,
    notes: notes.current.notes,
    platforms,
  };
  await writeFile(
    join(directory, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(directory, "releases.json"),
    `${JSON.stringify({ releases: notes.releases }, null, 2)}\n`,
  );
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await generateUpdateManifest(
    process.argv[2],
    process.argv[3],
    process.env.UPDATE_BASE_URL,
    process.argv[4] ?? "release-notes.json",
  );
}
