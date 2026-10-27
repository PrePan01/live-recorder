// 校验版本、发布记录和文件完整性，判断已有检查结果能否复用。
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyInstallerSignature } from "./verify-installer-signatures.mjs";
import { generateUpdateManifest, updaterPublicKey } from "./generate-update-manifest.mjs";

export const STATE = "release-state.json";
export const compareVersions = (a, b) => {
  const left = a.replace(/^v/, "").split(".").map(Number);
  const right = b.replace(/^v/, "").split(".").map(Number);
  if (![a, b].every((v) => /^v?\d+\.\d+\.\d+$/.test(v)))
    throw new Error("Invalid stable release version");
  for (let i = 0; i < 3; i++)
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
};

export function assertReleaseIdentity(saved, expected) {
  if (
    saved.version !== expected.version ||
    saved.commit !== expected.commit ||
    JSON.stringify(Object.entries(saved.files).sort()) !==
      JSON.stringify(Object.entries(expected.files).sort())
  ) {
    throw new Error(
      "Release identity changed. Re-run failed jobs with the original artifacts, or publish a new version.",
    );
  }
}

export function validateJournal(saved, tag, commit) {
  if (saved?.commit !== commit || `v${saved?.version}` !== tag ||
      !/^[a-f0-9]{40}$/.test(commit || "") ||
      (saved.publishedSnapshot !== true && (!Number.isSafeInteger(saved.runId) || saved.runId <= 0 ||
        !Number.isSafeInteger(saved.runAttempt) || saved.runAttempt <= 0)) ||
      !saved.files || Array.isArray(saved.files) || !saved.files["latest.json"] || !saved.files["releases.json"] ||
      Object.keys(saved.files).filter(name => name.endsWith(".dmg")).length !== 1 ||
      Object.keys(saved.files).filter(name => name.endsWith(".exe")).length !== 1 ||
      !Object.entries(saved.files).every(([name, digest]) =>
        /^[A-Za-z0-9_.-]+$/.test(name) && name !== "." && name !== ".." && /^[a-f0-9]{64}$/.test(digest)))
    throw new Error("Invalid frozen release checkpoint");
}

export function assertPointerIdentity(state, pointer) {
  if (!pointer) return;
  const current = JSON.parse(pointer);
  if (compareVersions(state.version, current.version) < 0)
    throw new Error("Refusing to roll back the update pointer");
  if (current.version === state.version) {
    for (const asset of Object.values(current.platforms || {}))
      if (state.files[asset.filename] !== asset.sha256)
        throw new Error("This version is already public with different bytes");
  }
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareReleaseFiles(
  directory,
  version,
  baseUrl,
  notesPath = "release-notes.json",
  pubkey,
) {
  const manifest = await generateUpdateManifest(
    directory,
    version,
    baseUrl,
    notesPath,
    pubkey,
  );
  // 复用生成清单时算出的安装包哈希。
  const files = Object.fromEntries(
    Object.values(manifest.platforms).map((asset) => [
      asset.filename,
      asset.sha256,
    ]),
  );
  for (const name of ["latest.json", "releases.json"])
    files[name] = await hashFile(join(directory, name));
  return files;
}

export async function verifyFrozenFiles(
  directory,
  version,
  pubkey = updaterPublicKey,
  expectedFiles,
) {
  const manifest = JSON.parse(readFileSync(join(directory, "latest.json")));
  if (
    manifest.version !== version ||
    !["macos-aarch64", "windows-x86_64"].every(
      (key) => manifest.platforms?.[key],
    )
  )
    throw new Error("Frozen manifest version/platform mismatch");
  const installers = new Map(
    Object.values(manifest.platforms).map((asset) => [asset.filename, asset]),
  );
  const files = {};
  const names = expectedFiles ? Object.keys(expectedFiles) : [...installers.keys(), "latest.json", "releases.json"];
  for (const name of names.sort()) {
    const asset = installers.get(name);
    const hash = createHash("sha256");
    const prehash = asset ? createHash("blake2b512") : null;
    for await (const chunk of createReadStream(join(directory, name))) {
      hash.update(chunk);
      prehash?.update(chunk);
    }
    files[name] = hash.digest("hex");
    if (asset) {
      if (
        statSync(join(directory, name)).size !== asset.size ||
        files[name] !== asset.sha256
      )
        throw new Error(`Frozen installer mismatch: ${name}`);
      const signature = asset.signature;
      if (!signature) throw new Error(`Missing frozen signature: ${name}`);
      verifyInstallerSignature(pubkey, signature, prehash.digest());
    }
  }
  if (
    ![...installers.keys(), "latest.json", "releases.json"].every(
      (name) => files[name],
    )
  )
    throw new Error("Missing frozen release files");
  return files;
}

export function checksMatchJournal(saved, commit, run, jobs) {
  if (
    !saved.runId ||
    !saved.runAttempt ||
    saved.commit !== commit ||
    run?.head_sha !== commit ||
    run.head_branch !== "release" ||
    run.path?.split("@")[0] !== ".github/workflows/release.yml" ||
    !["push", "workflow_dispatch"].includes(run.event)
  )
    return false;
  const successful = (name) =>
    jobs.some((job) => job.name === name && job.conclusion === "success");
  const builds = jobs.filter((job) => job.name.startsWith("build ("));
  return (
    successful("quality") &&
    successful("native-test (macos-15)") &&
    successful("native-test (windows-latest)") &&
    builds.length === 2 &&
    ["macos-15", "windows-latest"].every((os) =>
      builds.some((job) => job.name.startsWith(`build (${os}`)),
    ) &&
    builds.every((job) => job.conclusion === "success")
  );
}

