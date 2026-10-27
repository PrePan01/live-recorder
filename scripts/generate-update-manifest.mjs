import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readProjectJson } from "./project-utils.mjs";
import { verifyInstallerSignature } from "./verify-installer-signatures.mjs";
export const updaterPublicKey = readProjectJson("frontend/src-tauri/tauri.conf.json").plugins.updater.pubkey;

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

// 清单中的 signature 必须是签名内容，不能是文件路径。
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
  // 配置镜像地址时优先使用镜像，否则使用 GitHub 下载地址。
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
    // GitHub 会改写文件名中的空白，必须提前统一名称，避免下载地址失效。
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
