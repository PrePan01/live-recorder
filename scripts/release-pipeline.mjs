// 发布流程和命令入口，串联检查、上传、正式发布及 CDN 索引同步。
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  STATE, compareVersions, assertPointerIdentity, assertReleaseIdentity,
  validateJournal, prepareReleaseFiles, hashBytes,
} from "./release-state.mjs";
import { transferFiles } from "./release-command.mjs";
import { ReleaseRemote } from "./release-remote.mjs";

export {
  assertReleaseIdentity, validateJournal, prepareReleaseFiles,
  verifyFrozenFiles, checksMatchJournal,
} from "./release-state.mjs";
export { asyncCommand } from "./release-command.mjs";
export { ReleaseRemote } from "./release-remote.mjs";

// 上传前先保存发布记录；重试只补缺失文件，不覆盖已有文件。
export async function publishRelease(state, remote, { sync = true } = {}) {
  remote.assertTag(state.commit);
  const latestVersion = remote.latestGitHubVersion();
  if (latestVersion && compareVersions(state.version, latestVersion) < 0)
    throw new Error("Refusing to publish an older version as latest");
  assertPointerIdentity(state, remote.readObject("latest.json"));
  const saved = remote.readAsset(STATE);
  if (saved) assertReleaseIdentity(JSON.parse(saved), state);
  else {
    if (remote.release()?.draft === false)
      throw new Error(
        "Published release has no identity journal; refusing to modify it",
      );
    await remote.requireCheckpoint(state);
  }
  remote.ensureDraft(state.commit);
  remote.assertTag(state.commit);
  // 失败后也要等所有传输结束，才能清理临时文件。
  const entries = Object.entries(state.files);
  console.log("Release phase: uploading frozen assets to GitHub and CDN");
  const uploads = await Promise.allSettled([
    remote.ensureObjects(entries.map(([name, digest]) => [
      ["latest.json", "releases.json", "SHA256SUMS.txt"].includes(name)
        ? `releases/v${state.version}/${name}` : name,
      name, digest,
    ])),
    transferFiles(entries, ([name, digest]) =>
      remote.ensureAsset(name, digest),
    ),
  ]);
  const failure = uploads.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  console.log("Release phase: verifying uploaded assets");
  await remote.verifyStaged(state);
  console.log("Release phase: publishing GitHub Release");
  remote.publishGitHub(state.commit);
  remote.reportStatus?.("published_mirror_pending");
  if (sync) await syncRelease(state, remote);
}

// GitHub 发布后，此处只同步 CDN 索引，不再改动安装包。
export async function syncRelease(state, remote) {
  remote.assertTag(state.commit);
  if (remote.release()?.draft !== false) throw new Error("Cannot sync an unpublished release");
  const latest = remote.latestGitHubVersion();
  if (latest && compareVersions(state.version, latest) < 0)
    throw new Error("Refusing to sync an older release");
  assertPointerIdentity(state, remote.readObject("latest.json"));
  try {
    remote.updatePointer("releases.json");
    remote.updatePointer("latest.json");
    await remote.verifyPointers();
    remote.reportStatus?.("published_mirror_synced");
  } catch (error) {
    remote.reportStatus?.("published_mirror_pending");
    throw new Error(
      `Release v${state.version} is already published; CDN synchronization failed. Retry synchronization with the frozen assets. ${error.message}`,
    );
  }
}

async function main() {
  const [mode, directory, version] = process.argv.slice(2);
  const sourceCommit = process.env.RELEASE_SOURCE_COMMIT || process.env.GITHUB_SHA;
  const publishing = process.env.PUBLISH_RELEASE === "true";
  if (mode === "status") {
    if (process.env.GITHUB_REF !== "refs/heads/release")
      throw new Error(
        "Official publication is only allowed from the release branch",
      );
    const remote = new ReleaseRemote(directory, version);
    try {
      remote.assertTag(sourceCommit);
      const release = remote.release();
      const published = release?.draft === false;
      const journal = remote.readAsset(STATE);
      if (journal) validateJournal(JSON.parse(journal), remote.tag, sourceCommit);
      if (published) {
        if (!journal)
          throw new Error("Published release has no identity journal");
        const saved = JSON.parse(journal);
        if (
          saved.version !== version ||
          saved.commit !== sourceCommit ||
          !Object.keys(saved.files).every((name) =>
            release.assets.some((asset) => asset.name === name),
          )
        )
          throw new Error("Published release identity or assets mismatch");
      }
      process.stdout.write(`published=${published}\nfrozen=${Boolean(journal)}\n`);
    } finally {
      remote.close();
    }
    return;
  }
  if (mode === "preflight") {
    if (publishing && process.env.GITHUB_REF !== "refs/heads/release")
      throw new Error(
        "Official publication is only allowed from the release branch",
      );
    let shouldRelease = true;
    let reuseRelease = false;
    let reuseChecks = false;
    let published = false;
    if (publishing) {
      const remote = new ReleaseRemote(directory, version);
      try {
        remote.assertTag(sourceCommit);
        const release = remote.release();
        // 已发布版本有记录则可补同步索引，无记录则跳过。
        const journal = remote.readAsset(STATE);
        if (release?.draft === false && !journal) shouldRelease = false;
        if (journal) {
          const saved = JSON.parse(journal);
          validateJournal(saved, remote.tag, sourceCommit);
          reuseRelease = true;
          published = release?.draft === false;
          if (published && !Object.keys(saved.files).every(name => release.assets.some(a => a.name === name)))
            throw new Error("Published release has missing frozen assets");
          reuseChecks = published || remote.canReuseChecks(saved, sourceCommit);
        }
      } finally {
        remote.close();
      }
    }
    process.stdout.write(
      `should_release=${shouldRelease}\nreuse_release=${reuseRelease}\nreuse_checks=${reuseChecks}\n`,
    );
    return;
  }
  if (["prepare", "restore"].includes(mode)) {
    if (process.env.GITHUB_REF !== "refs/heads/release")
      throw new Error("Official publication is only allowed from the release branch");
    const pubkey = JSON.parse(readFileSync("frontend/src-tauri/tauri.conf.json")).plugins.updater.pubkey;
    if (mode === "restore") {
      const remote = new ReleaseRemote(directory, version);
      try { await remote.restoreFrozen(sourceCommit, process.env.ALREADY_PUBLISHED === "true", pubkey); }
      finally { remote.close(); }
    } else {
      const files = await prepareReleaseFiles(directory, version, process.env.UPDATE_BASE_URL, "release-notes.json", pubkey);
      const state = { version, commit: sourceCommit, files, runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
      validateJournal(state, `v${version}`, sourceCommit);
      writeFileSync(join(directory, STATE), `${JSON.stringify(state, null, 2)}\n`);
    }
    return;
  }
  if (
    !["publish", "sync"].includes(mode) ||
    process.env.GITHUB_REF !== "refs/heads/release"
  )
    throw new Error(
      "Official publication is only allowed from the release branch",
    );
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "QINIU_BUCKET",
    "QINIU_ENDPOINT",
    "GITHUB_REPOSITORY",
    "GITHUB_SHA",
  ]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
  if (mode === "sync") {
    const saved = JSON.parse(readFileSync(join(directory, STATE)));
    if (saved.version !== version || saved.commit !== sourceCommit)
      throw new Error("Synchronization identity mismatch");
    for (const name of ["latest.json", "releases.json"]) {
      if (hashBytes(readFileSync(join(directory, name))) !== saved.files[name])
        throw new Error(`Frozen manifest mismatch: ${name}`);
    }
    const remote = new ReleaseRemote(directory, version);
    try {
      const journal = remote.readAsset(STATE);
      if (!journal) throw new Error("Missing release journal");
      assertReleaseIdentity(JSON.parse(journal), saved);
      await syncRelease(saved, remote);
    } finally {
      remote.close();
    }
    return;
  }
  const state = JSON.parse(readFileSync(join(directory, STATE)));
  validateJournal(state, `v${version}`, sourceCommit);
  // 文件已在准备或恢复时校验，此处不再重复计算哈希。
  const remote = new ReleaseRemote(directory, version);
  try {
    await publishRelease(state, remote, { sync: false });
  } finally {
    remote.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
