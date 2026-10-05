import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  appendFileSync,
  mkdirSync,
  linkSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyInstallerSignature } from "./verify-installer-signatures.mjs";
import {
  generateUpdateManifest,
  updaterPublicKey,
} from "./generate-update-manifest.mjs";

const STATE = "release-state.json";
const compareVersions = (a, b) => {
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

// The draft is the durable journal. Bind bytes before uploading any public CDN
// objects; a retry may fill gaps but must never replace an existing asset.
export async function publishRelease(state, remote, { sync = true } = {}) {
  remote.assertTag(state.commit);
  const latestVersion = remote.latestGitHubVersion();
  if (latestVersion && compareVersions(state.version, latestVersion) < 0)
    throw new Error("Refusing to publish an older version as latest");
  const pointer = remote.readObject("latest.json");
  if (pointer) {
    const current = JSON.parse(pointer);
    if (compareVersions(state.version, current.version) < 0)
      throw new Error("Refusing to roll back the update pointer");
    if (current.version === state.version) {
      for (const asset of Object.values(current.platforms)) {
        if (state.files[asset.filename] !== asset.sha256)
          throw new Error(
            "This version is already public with different bytes",
          );
      }
    }
  }
  remote.ensureDraft(state.commit);
  remote.assertTag(state.commit);
  const saved = remote.readAsset(STATE);
  if (saved) assertReleaseIdentity(JSON.parse(saved), state);
  else {
    if (!remote.isDraft())
      throw new Error(
        "Published release has no identity journal; refusing to modify it",
      );
    await remote.uploadState(state);
  }
  // Run one AWS batch concurrently with bounded GitHub asset uploads.
  // Drain all in-flight transfers on failure before cleaning up local resources.
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
  remote.assertTag(state.commit);
  console.log("Release phase: publishing GitHub Release");
  remote.publishGitHub(state.commit);
  remote.reportStatus?.("published_mirror_pending");
  if (sync) await syncRelease(state, remote);
}

// GitHub publication is the commit point. Mirrors may lag; retrying this phase
// never rebuilds installers or changes an already published Release.
export async function syncRelease(state, remote) {
  remote.assertTag(state.commit);
  if (remote.isDraft()) throw new Error("Cannot sync an unpublished release");
  const latest = remote.latestGitHubVersion();
  if (latest && compareVersions(state.version, latest) < 0)
    throw new Error("Refusing to sync an older release");
  const pointer = remote.readObject("latest.json");
  if (
    pointer &&
    compareVersions(state.version, JSON.parse(pointer).version) < 0
  )
    throw new Error("Refusing to roll back the update pointer");
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

async function transferFiles(entries, transfer) {
  for (let offset = 0; offset < entries.length; offset += 2) {
    const results = await Promise.allSettled(
      entries.slice(offset, offset + 2).map(transfer),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
  // The manifest generator has already read and hashed the two installers.
  const files = Object.fromEntries(
    Object.values(manifest.platforms).map((asset) => [
      asset.filename,
      asset.sha256,
    ]),
  );
  for (const name of readdirSync(directory)
    .filter((name) => ![STATE, "SHA256SUMS.txt"].includes(name))
    .sort()) {
    files[name] ??= await hashFile(join(directory, name));
  }
  const sums = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, digest]) => `${digest}  ${name}\n`)
    .join("");
  writeFileSync(join(directory, "SHA256SUMS.txt"), sums);
  files["SHA256SUMS.txt"] = hashBytes(sums);
  return files;
}

export async function verifyFrozenFiles(
  directory,
  version,
  pubkey = updaterPublicKey,
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
  for (const name of readdirSync(directory)
    .filter((name) => name !== STATE)
    .sort()) {
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
      const signature = readFileSync(
        join(directory, `${name}.sig`),
        "utf8",
      ).trim();
      if (signature !== asset.signature)
        throw new Error(`Frozen signature mismatch: ${name}`);
      verifyInstallerSignature(pubkey, signature, prehash.digest());
    }
  }
  if (
    ![...installers.keys(), "releases.json", "SHA256SUMS.txt"].every(
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

function command(program, args) {
  try {
    return execFileSync(program, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    });
  } catch (error) {
    throw new Error(
      `${program} ${args[0]} failed: ${error.stderr?.toString() || error.message}`,
    );
  }
}
export function asyncCommand(program, args, options = {}) {
  const { label = program, timeout = 300000, liveOutput = false, idleTimeout = 0, ...execution } = options;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let lastProgress = started, lastAmount = '', progress = 'waiting for output';
    let stdout = '', stderr = '', stopped, forceKill, settled = false;
    const child = spawn(program, args, { ...execution, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 10000);
    };
    const deadline = setTimeout(() => stop(`${label} timed out after ${Math.round(timeout / 1000)}s`), timeout);
    const heartbeat = setInterval(() => {
      console.log(`[${label}] ${Math.round((Date.now() - started) / 1000)}s: ${progress}`);
    }, 15000);
    const idle = idleTimeout ? setInterval(() => {
      if (Date.now() - lastProgress > idleTimeout) stop(`${label}: no upload progress for ${Math.round(idleTimeout / 1000)}s`);
    }, Math.min(15000, idleTimeout / 2)) : undefined;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(forceKill); clearInterval(heartbeat); clearInterval(idle);
      if (error) reject(error);
      else { console.log(`[${label}] completed in ${Math.round((Date.now() - started) / 1000)}s`); resolve(stdout); }
    };
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) stream.on('data', chunk => {
      const output = chunk.toString();
      if (isError) stderr += output; else stdout += output;
      if (stdout.length + stderr.length > 16 * 1024 * 1024) stop(`${label}: output limit exceeded`);
      if (liveOutput) process.stdout.write(output.replace(/\r/g, '\n'));
      progress = output.trim().split(/[\r\n]+/).at(-1) || progress;
      for (const match of output.matchAll(/Completed ([\d.]+) (Bytes|KiB|MiB|GiB)\//g)) {
        const amount = `${match[1]} ${match[2]}`;
        if (amount !== lastAmount) { lastAmount = amount; lastProgress = Date.now(); }
      }
    });
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
      if (stopped) finish(new Error(stopped));
      else if (code !== 0 || signal) finish(new Error(`${label} failed: ${stderr || signal || code}`));
      else finish();
    });
  });
}

async function retryTransfer(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (
        attempt === 3 ||
        /HTTP 404|\((404|NoSuchKey|NotFound)\)|Refusing to overwrite|refusing to modify|upload budget exceeded/.test(
          error.message,
        )
      )
        throw error;
      console.warn(`Transfer failed; retry ${attempt + 2}/4 in ${2 ** attempt}s: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}
function retry(fn) {
  let error;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return fn();
    } catch (e) {
      error = e;
      if (/HTTP 404|\((404|NoSuchKey|NotFound)\)/.test(e.message)) throw e;
      if (attempt < 3)
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          1000 * 2 ** attempt,
        );
    }
  }
  throw error;
}

export class ReleaseRemote {
  constructor(directory, version, runAsync = asyncCommand) {
    this.directory = directory;
    this.tag = `v${version}`;
    this.repo = process.env.GITHUB_REPOSITORY;
    this.scratch = mkdtempSync(join(tmpdir(), "lr-publish-"));
    this.runAsync = runAsync;
  }
  close() {
    rmSync(this.scratch, { recursive: true, force: true });
  }
  api(path) {
    try {
      return JSON.parse(
        retry(() => command("gh", ["api", `repos/${this.repo}/${path}`])),
      );
    } catch (error) {
      if (/HTTP 404/.test(error.message)) return null;
      throw error;
    }
  }
  release(refresh = false) {
    if (refresh || this.releaseSnapshot === undefined) {
      // The release list covers both drafts and published releases. Looking up
      // a draft through the published-by-tag endpoint adds an expected 404.
      let release = null;
      for (let page = 1; ; page++) {
        const releases = this.api(`releases?per_page=100&page=${page}`);
        if (!Array.isArray(releases))
          throw new Error(
            "Unable to list releases while checking for a draft",
          );
        release =
          releases.find((candidate) => candidate.tag_name === this.tag) ??
          null;
        if (release || releases.length < 100) break;
      }
      this.releaseSnapshot = release;
    }
    return this.releaseSnapshot;
  }
  assertTag(commit) {
    let ref = this.api(`git/ref/tags/${this.tag}`)?.object;
    for (let depth = 0; ref?.type === "tag" && depth < 10; depth++)
      ref = this.api(`git/tags/${ref.sha}`)?.object;
    if (ref && (ref.type !== "commit" || ref.sha !== commit))
      throw new Error(
        `Tag ${this.tag} does not point to this commit. Publish a new version.`,
      );
    if (!ref && this.release())
      throw new Error("Release exists without its tag");
  }
  latestGitHubVersion() {
    return this.api("releases/latest")?.tag_name;
  }
  isDraft() {
    return this.release()?.draft === true;
  }
  ensureDraft(commit) {
    retry(() => {
      if (this.release(true)) return;
      // Create the ref explicitly: GitHub may defer tag creation for drafts.
      // An interrupted run can safely resume this orphan ref at the same SHA.
      this.assertTag(commit);
      if (!this.api(`git/ref/tags/${this.tag}`)) {
        command("gh", [
          "api",
          `repos/${this.repo}/git/refs`,
          "--method",
          "POST",
          "-f",
          `ref=refs/tags/${this.tag}`,
          "-f",
          `sha=${commit}`,
        ]);
      }
      command("gh", [
        "release",
        "create",
        this.tag,
        "--repo",
        this.repo,
        "--target",
        commit,
        "--title",
        this.tag,
        "--generate-notes",
        "--draft",
      ]);
      if (!this.release(true)?.draft)
        throw new Error("Created release draft could not be confirmed");
    });
  }
  readAsset(name) {
    if (!this.release()?.assets.some((asset) => asset.name === name))
      return null;
    const file = join(this.scratch, name);
    retry(() =>
      command("gh", [
        "release",
        "download",
        this.tag,
        "--repo",
        this.repo,
        "--pattern",
        name,
        "--dir",
        this.scratch,
        "--clobber",
      ]),
    );
    return readFileSync(file);
  }
  async uploadState(state) {
    writeFileSync(
      join(this.directory, STATE),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    await this.ensureAsset(
      STATE,
      hashBytes(readFileSync(join(this.directory, STATE))),
    );
  }
  async ensureAsset(name, digest) {
    const started = Date.now();
    const budget = 8 * 60 * 1000;
    let refresh = false;
    await retryTransfer(async () => {
      const release = this.release(refresh);
      refresh = true;
      const asset = release.assets.find((a) => a.name === name);
      if (asset) {
        const actual =
          asset.digest || `sha256:${hashBytes(this.readAsset(name))}`;
        if (actual !== `sha256:${digest}`)
          throw new Error(`Refusing to overwrite GitHub asset ${name}`);
        return;
      }
      if (!release.draft)
        throw new Error(
          `Published release is missing ${name}; refusing to modify it`,
        );
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) throw new Error(`GitHub upload budget exceeded: ${name}`);
      await this.runAsync("gh", [
        "release",
        "upload",
        this.tag,
        join(this.directory, name),
        "--repo",
        this.repo,
      ], { label: `GitHub ${name}`, timeout: Math.min(300000, remaining) });
      // Update this phase's snapshot without another full Release request.
      const current = this.release();
      if (!current.assets.some((asset) => asset.name === name))
        current.assets.push({ name, digest: `sha256:${digest}` });
    });
  }
  aws(args) {
    return command("aws", [
      "--endpoint-url",
      process.env.QINIU_ENDPOINT,
      "s3api",
      ...args,
      "--bucket",
      process.env.QINIU_BUCKET,
    ]);
  }
  objectHead(key) {
    try {
      return JSON.parse(retry(() => this.aws(["head-object", "--key", key])));
    } catch (error) {
      if (/\((404|NoSuchKey|NotFound)\)/.test(error.message)) return null;
      throw error;
    }
  }
  readObject(key, head = this.objectHead(key)) {
    if (!head) return null;
    const file = join(this.scratch, "object");
    retry(() => this.aws(["get-object", "--key", key, file]));
    return readFileSync(file);
  }
  async ensureObjects(entries) {
    // One native AWS recursive transfer, as in the previous working workflow.
    // Stage only missing immutable objects, keeping public version indexes out
    // of the batch. Hard links avoid rereading/copying large installers.
    const fingerprint = hashBytes(JSON.stringify([...entries].sort()));
    const staging = join(this.scratch, "cdn-upload");
    const started = Date.now();
    const budget = 20 * 60 * 1000;
    await retryTransfer(async () => {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      let pending = 0;
      for (const [key, name, digest] of entries) {
        const head = this.objectHead(key);
        if (head) {
          if (head.Metadata?.["release-set-sha256"] === fingerprint) continue;
          const actual = head.Metadata?.sha256 || hashBytes(this.readObject(key, head));
          if (actual !== digest) throw new Error(`Refusing to overwrite CDN object ${key}`);
          continue;
        }
        const target = join(staging, key);
        mkdirSync(dirname(target), { recursive: true });
        try { linkSync(join(this.directory, name), target); }
        catch (error) {
          if (error.code !== "EXDEV") throw error;
          copyFileSync(join(this.directory, name), target);
        }
        pending++;
      }
      if (!pending) return;
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) throw new Error("CDN upload budget exceeded");
      console.log(`Uploading ${pending} CDN objects in one AWS recursive batch`);
      await this.runAsync("aws", [
        "--endpoint-url", process.env.QINIU_ENDPOINT,
        "s3", "cp", staging, `s3://${process.env.QINIU_BUCKET}/`, "--recursive",
        "--cache-control", "public, max-age=31536000, immutable",
      ], {
        label: "CDN batch upload", liveOutput: true, timeout: remaining, idleTimeout: 180000,
      });
    });
  }

  reportStatus(status) {
    console.log(`Release status: ${status}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\nRelease ${this.tag}: **${status}**\n`,
      );
  }
  async verifyPublic(key, name, sampled = false) {
    const file = join(this.directory, name);
    const size = statSync(file).size;
    const width = Math.min(size, 65536);
    const starts = sampled
      ? [...new Set([0, Math.floor((size - width) / 2), size - width])]
      : [0];
    const url = `${process.env.UPDATE_BASE_URL.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
    for (const start of starts) {
      await retryTransfer(async () => {
        const end = sampled ? start + width - 1 : size - 1;
        const response = await fetch(url, {
          headers: {
            "Accept-Encoding": "identity",
            ...(sampled ? { Range: `bytes=${start}-${end}` } : {}),
          },
          signal: AbortSignal.timeout(30000),
        });
        try {
          if (response.status !== (sampled ? 206 : 200))
            throw new Error(`CDN HTTP ${response.status}: ${key}`);
          if (
            sampled &&
            response.headers.get("content-range") !==
              `bytes ${start}-${end}/${size}`
          )
            throw new Error(`CDN range mismatch: ${key}`);
          const expectedSize = end - start + 1;
          if (
            response.headers.has("content-length") &&
            Number(response.headers.get("content-length")) !== expectedSize
          )
            throw new Error(`CDN size mismatch: ${key}`);
          const chunks = [];
          let total = 0;
          for await (const chunk of response.body) {
            total += chunk.length;
            if (total > expectedSize)
              throw new Error(`CDN response too large: ${key}`);
            chunks.push(chunk);
          }
          const expected = Buffer.alloc(expectedSize);
          const fd = openSync(file, "r");
          try {
            if (readSync(fd, expected, 0, expectedSize, start) !== expectedSize)
              throw new Error("Local file changed");
          } finally {
            closeSync(fd);
          }
          if (!Buffer.concat(chunks).equals(expected))
            throw new Error(`CDN bytes mismatch: ${key}`);
        } finally {
          if (!response.bodyUsed) await response.body?.cancel();
        }
      });
    }
  }
  async verifyStaged(state) {
    // A fresh server snapshot supplies GitHub's actual asset digest; never trust
    // the synthetic cache entries populated after an upload.
    const release = this.release(true);
    for (const [name, digest] of Object.entries(state.files)) {
      const asset = release.assets.find((asset) => asset.name === name);
      if (
        !asset ||
        (asset.digest || `sha256:${hashBytes(this.readAsset(name))}`) !==
          `sha256:${digest}`
      )
        throw new Error(`GitHub asset verification failed: ${name}`);
    }
    await transferFiles(Object.entries(state.files), async ([name]) => {
      const key = ["latest.json", "releases.json", "SHA256SUMS.txt"].includes(
        name,
      )
        ? `releases/${this.tag}/${name}`
        : name;
      await this.verifyPublic(key, name, /\.(dmg|exe)$/.test(name));
    });
  }
  async verifyPointers() {
    await Promise.all(
      ["latest.json", "releases.json"].map((name) =>
        this.verifyPublic(name, name),
      ),
    );
  }
  publishGitHub(commit) {
    retry(() => {
      // Refresh at the publication boundary and after any uncertain edit.
      this.assertTag(commit);
      this.release(true);
      if (this.isDraft())
        command("gh", [
          "release",
          "edit",
          this.tag,
          "--repo",
          this.repo,
          "--draft=false",
          "--latest",
        ]);
      this.releaseSnapshot = undefined;
    });
  }
  canReuseChecks(saved, commit) {
    if (
      !Number.isSafeInteger(saved.runId) ||
      !Number.isSafeInteger(saved.runAttempt) ||
      saved.runId <= 0 ||
      saved.runAttempt <= 0
    )
      return false;
    const run = this.api(`actions/runs/${saved.runId}`);
    const jobs = [];
    for (let page = 1; ; page++) {
      const result = this.api(
        `actions/runs/${saved.runId}/jobs?filter=all&per_page=100&page=${page}`,
      );
      if (!result) return false;
      jobs.push(...result.jobs);
      if (result.jobs.length < 100) break;
    }
    // Failed-job reruns retain successful gates from earlier attempts. Select
    // the latest result per job up to the attempt that froze these artifacts.
    const latest = new Map();
    for (const job of jobs) {
      if (job.run_attempt > saved.runAttempt) continue;
      if (!latest.has(job.name) || job.id > latest.get(job.name).id)
        latest.set(job.name, job);
    }
    return checksMatchJournal(saved, commit, run, [...latest.values()]);
  }
  updatePointer(name) {
    retry(() => {
      this.aws([
        "put-object",
        "--key",
        name,
        "--body",
        join(this.directory, name),
        "--cache-control",
        "no-cache, no-store, must-revalidate, max-age=0",
        "--content-type",
        "application/json",
      ]);
      if (
        !this.readObject(name)?.equals(readFileSync(join(this.directory, name)))
      )
        throw new Error(`Pointer read-back failed: ${name}`);
    });
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
      if (published) {
        const journal = remote.readAsset(STATE);
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
      process.stdout.write(`published=${published}\n`);
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
        // Legacy published versions remain a no-op. New releases with a journal
        // can resume the final pointer update after GitHub publication.
        if (
          release &&
          !release.draft &&
          !release.assets.some((a) => a.name === STATE)
        )
          shouldRelease = false;
        if (release?.assets.some((a) => a.name === STATE)) {
          const saved = JSON.parse(remote.readAsset(STATE));
          if (
            saved.commit !== sourceCommit ||
            saved.version !== version
          )
            throw new Error(
              "Release journal belongs to another commit or version",
            );
          reuseRelease = Object.keys(saved.files).every((name) =>
            release.assets.some((a) => a.name === name),
          );
          published = !release.draft;
          if (published && !reuseRelease)
            throw new Error("Published release has missing frozen assets");
          if (reuseRelease)
            reuseChecks =
              published || remote.canReuseChecks(saved, sourceCommit);
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
  let files;
  if (process.env.PREPARE_RELEASE_ASSETS === "true") {
    files = await prepareReleaseFiles(
      directory,
      version,
      process.env.UPDATE_BASE_URL,
    );
  } else {
    // Hash + authenticate restored installers in the same streaming pass.
    files = await verifyFrozenFiles(directory, version);
  }
  const state = {
    version,
    commit: sourceCommit,
    files,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  writeFileSync(join(directory, STATE), `${JSON.stringify(state, null, 2)}\n`);
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
