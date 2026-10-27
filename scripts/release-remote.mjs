// 封装 GitHub 和 CDN 操作，负责文件上传、校验及发布恢复。
import {
  mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync,
  openSync, readSync, closeSync, appendFileSync, mkdirSync, linkSync,
  copyFileSync, existsSync, renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { generateUpdateManifest, updaterPublicKey } from "./generate-update-manifest.mjs";
import {
  STATE, assertReleaseIdentity, validateJournal, verifyFrozenFiles,
  checksMatchJournal, hashBytes, hashFile,
} from "./release-state.mjs";
import { asyncCommand, command, retry, retryTransfer, transferFiles } from "./release-command.mjs";

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
      // 发布列表包含草稿；按标签查询草稿会返回 404。
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
  ensureDraft(commit) {
    retry(() => {
      if (this.release(true)) return;
      // 草稿可能不立即创建标签，先显式绑定提交，便于中断后恢复。
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
    const release = this.release();
    if (!release?.assets.some((asset) => asset.name === name)) {
      if (name !== STATE && !["latest.json", "releases.json"].includes(name)) return null;
      if (name === STATE && release?.draft === false) {
        const snapshot = this.publishedJournal(release);
        if (snapshot) return Buffer.from(JSON.stringify(snapshot));
      }
      const bundle = this.journalBundle();
      const file = bundle && join(bundle, name);
      return file && existsSync(file) ? readFileSync(file) : null;
    }
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
  publishedJournal(release) {
    // 构建产物过期后，仍可用公开文件摘要和清单恢复发布记录。
    const commit = process.env.RELEASE_SOURCE_COMMIT || process.env.GITHUB_SHA;
    const metadata = release.assets.find(asset => asset.name === "latest.json");
    if (!metadata || !/^[a-f0-9]{40}$/.test(commit || "")) return null;
    const bytes = this.readAsset("latest.json");
    if (metadata.digest !== `sha256:${hashBytes(bytes)}`) throw new Error("Published manifest digest mismatch");
    const manifest = JSON.parse(bytes);
    const names = ["macos-aarch64", "windows-x86_64"].map(key => manifest.platforms?.[key]?.filename);
    if (`v${manifest.version}` !== this.tag || names.some(name => !name)) throw new Error("Published manifest identity mismatch");
    const files = {};
    for (const name of [...names, "latest.json", "releases.json"]) {
      const asset = release.assets.find(item => item.name === name);
      if (!/^sha256:[a-f0-9]{64}$/.test(asset?.digest || "")) throw new Error(`Missing published digest: ${name}`);
      files[name] = asset.digest.slice(7);
    }
    for (const item of Object.values(manifest.platforms))
      if (files[item.filename] !== item.sha256) throw new Error("Published installer digest mismatch");
    const saved = { version: manifest.version, commit, files, publishedSnapshot: true };
    validateJournal(saved, this.tag, commit);
    return saved;
  }
  journalBundle() {
    if (this.journalDirectory !== undefined) return this.journalDirectory;
    const commit = process.env.RELEASE_SOURCE_COMMIT || process.env.GITHUB_SHA;
    if (!/^[a-f0-9]{40}$/.test(commit || "")) return null;
    const name = `release-state-${this.tag}-${commit}`;
    let artifact;
    for (let page = 1; ; page++) {
      const result = this.api(`actions/artifacts?name=${name}&per_page=100&page=${page}`);
      if (!Array.isArray(result?.artifacts)) throw new Error("Unable to query internal release checkpoint");
      artifact = result.artifacts.find(item => item.name === name && !item.expired && item.workflow_run?.head_sha === commit);
      if (artifact || result.artifacts.length < 100) break;
    }
    if (!artifact) { this.journalDirectory = null; return null; }
    const directory = join(this.scratch, "checkpoint");
    mkdirSync(directory, { recursive: true });
    this.downloadRunArtifact(artifact.workflow_run.id, name, directory);
    const saved = JSON.parse(readFileSync(join(directory, STATE)));
    if (saved.commit !== commit || `v${saved.version}` !== this.tag || saved.runId !== artifact.workflow_run.id)
      throw new Error("Internal checkpoint identity mismatch");
    this.journalDirectory = directory;
    return directory;
  }
  downloadRunArtifact(runId, name, directory) {
    retry(() => command("gh", ["run", "download", String(runId), "--repo", this.repo,
      "--name", name, "--dir", directory]));
  }
  async requireCheckpoint(state) {
    const saved = this.readAsset(STATE);
    if (!saved) throw new Error("Missing internal release checkpoint; refusing to upload");
    assertReleaseIdentity(JSON.parse(saved), state);
  }
  async restoreFrozen(commit, published = false, pubkey = updaterPublicKey) {
    const raw = this.readAsset(STATE);
    if (!raw) throw new Error("Missing frozen release checkpoint (or expired Actions artifact)");
    const saved = JSON.parse(raw);
    validateJournal(saved, this.tag, commit);
    if (saved.publishedSnapshot && !published) throw new Error("Cannot restore a published snapshot as a draft");
    this.assertTag(commit);
    if (!published && !this.canReuseChecks(saved, commit))
      throw new Error("Original release quality and native checks must have passed");
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(join(this.directory, STATE), raw);
    for (const name of ["latest.json", "releases.json"]) {
      const bytes = this.readAsset(name);
      if (bytes) writeFileSync(join(this.directory, name), bytes);
      else if (published) throw new Error(`Missing published manifest: ${name}`);
    }
    if (published) {
      for (const name of ["latest.json", "releases.json"])
        if (hashBytes(readFileSync(join(this.directory, name))) !== saved.files[name])
          throw new Error(`Frozen manifest mismatch: ${name}`);
      return saved;
    }
    const missing = Object.keys(saved.files).filter(name => !existsSync(join(this.directory, name)));
    // 优先恢复 GitHub 文件，缺失时才下载原构建产物。
    let needBuild = false;
    for (const name of missing) {
      const bytes = this.readAsset(name);
      if (bytes) writeFileSync(join(this.directory, name), bytes);
      else needBuild = true;
    }
    if (needBuild) {
      const needed = Object.keys(saved.files).filter(name => !existsSync(join(this.directory, name)));
      const regenerate = !["latest.json", "releases.json"].every(name => existsSync(join(this.directory, name)));
      for (const [platform, suffix] of [["macos", ".dmg"], ["windows", ".exe"]]) {
        if (!regenerate && !needed.some(name => name.endsWith(suffix) || name.endsWith(`${suffix}.sig`))) continue;
        const extracted = join(this.scratch, `build-${platform}`);
        mkdirSync(extracted, { recursive: true });
        await this.runAsync("gh", ["run", "download", String(saved.runId), "--repo", this.repo,
          "--name", `live-recorder-${platform}-${saved.version}`, "--dir", extracted],
          { label: `Restore original ${platform} artifact`, timeout: 480000 });
        for (const name of readdirSync(extracted)) {
          const target = join(this.directory, name.replace(/ /g, "."));
          if (!existsSync(target)) copyFileSync(join(extracted, name), target);
        }
      }
      for (const name of readdirSync(this.directory)) {
        const normalized = name.replace(/ /g, ".");
        if (normalized !== name) renameSync(join(this.directory, name), join(this.directory, normalized));
      }
      if (!["latest.json", "releases.json"].every(name => existsSync(join(this.directory, name))))
        await generateUpdateManifest(this.directory, saved.version, process.env.UPDATE_BASE_URL, "release-notes.json", pubkey);
      // 兼容包含 SHA256SUMS.txt 的旧发布记录。
      if (saved.files["SHA256SUMS.txt"] && !existsSync(join(this.directory, "SHA256SUMS.txt")))
        writeFileSync(join(this.directory, "SHA256SUMS.txt"), Object.entries(saved.files)
          .filter(([name]) => name !== "SHA256SUMS.txt").sort(([a], [b]) => a.localeCompare(b))
          .map(([name, digest]) => `${digest}  ${name}\n`).join(""));
    }
    const files = await verifyFrozenFiles(this.directory, saved.version, pubkey, saved.files);
    assertReleaseIdentity(saved, { ...saved, files });
    return saved;
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
      if (/\((403|Forbidden|AccessDenied)\)/.test(error.message)) {
        try {
          const result = JSON.parse(
            this.aws([
              "get-object",
              "--key",
              key,
              "--range",
              "bytes=0-0",
              join(this.scratch, "head-probe"),
            ]),
          );
          const size = /^bytes 0-0\/(\d+)$/.exec(result.ContentRange || "");
          if (!size)
            throw new Error("GetObject returned no authoritative object size");
          return { ...result, ContentLength: Number(size[1]) };
        } catch (diagnostic) {
          if (/\((404|NoSuchKey|NotFound)\)/.test(diagnostic.message))
            return null;
          throw new Error(
            `Cannot inspect CDN object ${key}: ${error.message}; read-only GetObject diagnosis: ${diagnostic.message}`,
          );
        }
      }
      throw new Error(`Cannot inspect CDN object ${key}: ${error.message}`);
    }
  }
  readObject(key, head = this.objectHead(key)) {
    if (!head) return null;
    const file = join(this.scratch, "object");
    retry(() => this.aws(["get-object", "--key", key, file]));
    return readFileSync(file);
  }
  async objectDigest(key, timeout) {
    const file = join(this.scratch, "existing-object");
    try {
      await this.runAsync(
        "aws",
        [
          "--endpoint-url",
          process.env.QINIU_ENDPOINT,
          "s3api",
          "get-object",
          "--bucket",
          process.env.QINIU_BUCKET,
          "--key",
          key,
          file,
        ],
        {
          label: `Verify existing CDN object ${key}`,
          timeout,
        },
      );
      return await hashFile(file);
    } finally {
      rmSync(file, { force: true });
    }
  }
  async ensureObjects(entries) {
    // 只上传缺失的版本文件，公共索引单独更新；硬链接可避免复制大文件。
    const fingerprint = hashBytes(JSON.stringify([...entries].sort()));
    const staging = join(this.scratch, "cdn-upload");
    const started = Date.now();
    // 慢速上传最多允许 45 分钟；连续 5 分钟无进展则提前停止。
    const budget = 45 * 60 * 1000;
    await retryTransfer(async () => {
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      let pending = 0;
      for (const [key, name, digest] of entries) {
        const head = this.objectHead(key);
        if (head) {
          if (head.Metadata?.["release-set-sha256"] === fingerprint &&
              head.ContentLength === statSync(join(this.directory, name)).size) continue;
          const remaining = budget - (Date.now() - started);
          if (remaining <= 0) throw new Error("CDN upload budget exceeded");
          const actual = head.Metadata?.sha256 || await this.objectDigest(key, remaining);
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
        label: "CDN batch upload", liveOutput: true, timeout: remaining,
        idleTimeout: 5 * 60 * 1000,
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
    // 重新读取 GitHub 的真实摘要，不使用上传后本地填入的缓存值。
    const release = this.release(true);
    if (!release) throw new Error("Release missing during verification");
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
      // 每次发布尝试都重新核对标签和远端状态。
      this.assertTag(commit);
      const release = this.release(true);
      if (!release) throw new Error("Release missing at publication boundary");
      if (release.draft)
        command("gh", [
          "release",
          "edit",
          this.tag,
          "--repo",
          this.repo,
          "--draft=false",
          "--latest",
        ]);
      if (this.release(true)?.draft !== false)
        throw new Error("GitHub publication could not be confirmed");
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
    // 重跑会保留先前成功的任务，只取冻结产物时及之前各任务的最新结果。
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

