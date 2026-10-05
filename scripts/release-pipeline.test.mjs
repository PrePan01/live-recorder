import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseIdentity, publishRelease, ReleaseRemote, checksMatchJournal, prepareReleaseFiles, syncRelease, verifyFrozenFiles } from './release-pipeline.mjs';

import { pubkey, signature } from './test-fixtures/signatures.mjs';

const state = {
  version: '1.2.3', commit: 'commit-a',
  files: { 'app.dmg': 'mac-hash', 'app.exe': 'win-hash', 'latest.json': 'manifest-hash', 'releases.json': 'notes-hash' },
};

class FakeRemote {
  events = [];
  assets = new Map();
  objects = new Map();
  draft = true;
  tag = null;
  fail = null;
  event(name) {
    this.events.push(name);
    if (this.fail === name) throw new Error(`Injected failure: ${name}`);
  }
  assertTag(commit) { if (this.tag && this.tag !== commit) throw new Error('Tag commit mismatch'); }
  latestGitHubVersion() { return this.latestVersion; }
  readObject(key) { return this.objects.get(key); }
  ensureDraft(commit) { this.event('draft'); this.tag ??= commit; }
  isDraft() { return this.draft; }
  readAsset(name) { return this.assets.get(name); }
  uploadState(saved) { this.event('journal'); this.assets.set('release-state.json', JSON.stringify(saved)); }
  ensureAsset(name, digest) {
    this.event(`asset:${name}`);
    if (this.assets.has(name)) assert.equal(this.assets.get(name), digest);
    else this.assets.set(name, digest);
  }
  ensureObject(key, name, digest) {
    this.event(`object:${key}`);
    if (this.objects.has(key)) assert.equal(this.objects.get(key), digest);
    else this.objects.set(key, digest);
  }
  verifyStaged() { this.event('verify'); }
  verifyPointers() { this.event('verify-pointers'); }
  reportStatus(status) { this.status = status; }
  publishGitHub() { this.event('publish'); this.draft = false; }
  updatePointer(name) {
    this.event(`pointer:${name}`);
    this.objects.set(name, name === 'latest.json'
      ? JSON.stringify({ version: state.version, platforms: { mac: { filename: 'app.dmg', sha256: 'mac-hash' } } })
      : 'release history');
  }
}

test('verify before formal GitHub publication, then synchronize CDN indexes', async () => {
  const remote = new FakeRemote();
  await publishRelease(state, remote);
  assert(remote.events.indexOf('journal') < remote.events.indexOf('object:app.dmg'));
  assert(remote.events.indexOf('publish') > remote.events.indexOf('object:releases/v1.2.3/latest.json'));
  assert.deepEqual(remote.events.slice(-5), ['verify', 'publish', 'pointer:releases.json', 'pointer:latest.json', 'verify-pointers']);
  assert.equal(remote.status, 'published_mirror_synced');
});

test('GitHub publication failure leaves both public pointers unchanged', async () => {
  const remote = new FakeRemote();
  remote.objects.set('latest.json', JSON.stringify({ version: '1.2.2' }));
  remote.objects.set('releases.json', 'old history');
  remote.fail = 'publish';
  await assert.rejects(() => publishRelease(state, remote), /Injected failure/);
  assert.equal(JSON.parse(remote.objects.get('latest.json')).version, '1.2.2');
  assert.equal(remote.objects.get('releases.json'), 'old history');
});

test('CDN sync failure reports already published and resumes without installer transfers', async () => {
  const remote = new FakeRemote();
  remote.objects.set('latest.json', JSON.stringify({ version: '1.2.2' }));
  remote.fail = 'pointer:releases.json';
  await assert.rejects(() => publishRelease(state, remote), /Injected failure/);
  assert.equal(remote.draft, false);
  assert.equal(JSON.parse(remote.objects.get('latest.json')).version, '1.2.2');
  assert.equal(remote.status, 'published_mirror_pending');
  remote.fail = null;
  remote.events = [];
  await syncRelease(state, remote);
  assert.deepEqual(remote.events, ['pointer:releases.json', 'pointer:latest.json', 'verify-pointers']);
  assert.equal(JSON.parse(remote.objects.get('latest.json')).version, '1.2.3');
});

test('partial asset upload resumes without changing the frozen identity', async () => {
  const remote = new FakeRemote();
  remote.fail = 'asset:app.exe';
  await assert.rejects(() => publishRelease(state, remote), /Injected failure/);
  assert(remote.assets.has('release-state.json'));
  assert(!remote.objects.has('latest.json'));
  assert(!remote.events.includes('publish'));
  remote.fail = null;
  await publishRelease(state, remote);
  assert.equal(remote.assets.get('app.dmg'), 'mac-hash');
});

test('new commit cannot resume a draft tagged with the previous commit', async () => {
  const remote = new FakeRemote();
  remote.tag = 'commit-a';
  await assert.rejects(() => publishRelease({ ...state, commit: 'commit-b' }, remote), /Tag commit mismatch/);
  assert.deepEqual(remote.events, []);
});

test('rebuilt bytes cannot overwrite a frozen version even at the same commit', async () => {
  const remote = new FakeRemote();
  remote.assets.set('release-state.json', JSON.stringify(state));
  await assert.rejects(() => publishRelease({ ...state, files: { ...state.files, 'app.dmg': 'changed' } }, remote), /Release identity changed/);
  assert(!remote.events.some((event) => event.startsWith('asset:') || event.startsWith('object:')));
});

test('older releases cannot replace either the GitHub latest version or CDN pointer', async () => {
  for (const source of ['github', 'cdn']) {
    const remote = new FakeRemote();
    if (source === 'github') remote.latestVersion = 'v1.2.4';
    else remote.objects.set('latest.json', JSON.stringify({ version: '1.2.4' }));
    await assert.rejects(() => publishRelease(state, remote), /older version|roll back/);
    assert.deepEqual(remote.events, []);
  }
});

test('existing CDN bytes and legacy published releases are not overwritten', async () => {
  const remote = new FakeRemote();
  remote.objects.set('app.dmg', 'previously-public-bytes');
  await assert.rejects(() => publishRelease(state, remote));
  assert.equal(remote.objects.get('app.dmg'), 'previously-public-bytes');
  assert(!remote.events.includes('publish'));
  const legacy = new FakeRemote();
  legacy.draft = false;
  await assert.rejects(() => publishRelease(state, legacy), /no identity journal/);
});

test('repeat publication with the same identity is safe', async () => {
  const remote = new FakeRemote();
  await publishRelease(state, remote);
  await publishRelease(state, remote);
  assert.equal(remote.assets.get('app.exe'), 'win-hash');
  assertReleaseIdentity({ ...state, files: Object.fromEntries(Object.entries(state.files).reverse()) }, state);
});

test('manual publication from another branch is rejected before accessing secrets or remote services', async () => {
  for (const mode of ['preflight', 'publish', 'sync', 'status']) {
    const result = spawnSync(process.execPath, ['scripts/release-pipeline.mjs', mode, 'unused', '1.2.3'], {
      encoding: 'utf8', env: { ...process.env, GITHUB_REF: 'refs/heads/main', PUBLISH_RELEASE: 'true' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only allowed from the release branch/);
  }
});

test('validation builds on another branch do not reserve tags or publish', async () => {
  const result = spawnSync(process.execPath, ['scripts/release-pipeline.mjs', 'preflight', 'unused', '1.2.3'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_REF: 'refs/heads/main', PUBLISH_RELEASE: 'false' },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'should_release=true\nreuse_release=false\nreuse_checks=false\n');
});

test('both destinations transfer concurrently with a two-file limit per destination', async () => {
  const remote = new FakeRemote();
  const active = { github: 0, cdn: 0 };
  const peak = { github: 0, cdn: 0 };
  let destinationsOverlap = false;
  for (const [method, service] of [['ensureAsset', 'github'], ['ensureObject', 'cdn']]) {
    const original = remote[method].bind(remote);
    remote[method] = async (...args) => {
      active[service]++;
      peak[service] = Math.max(peak[service], active[service]);
      destinationsOverlap ||= active.github > 0 && active.cdn > 0;
      await new Promise((resolve) => setTimeout(resolve, 5));
      try { original(...args); } finally { active[service]--; }
    };
  }
  remote.publishGitHub = () => {
    assert.deepEqual(active, { github: 0, cdn: 0 });
    remote.events.push('publish');
    remote.draft = false;
  };
  await publishRelease(state, remote);
  assert.deepEqual(peak, { github: 2, cdn: 2 });
  assert(destinationsOverlap);
});

test('failed transfer drains other uploads before rejecting and never activates pointers', async () => {
  const remote = new FakeRemote();
  let active = 0;
  let finished = 0;
  remote.ensureObject = async () => {
    active++;
    try { await new Promise((resolve) => setTimeout(resolve, 5)); finished++; }
    finally { active--; }
  };
  remote.ensureAsset = async () => { throw new Error('upload failed'); };
  await assert.rejects(publishRelease(state, remote), /upload failed/);
  assert.equal(active, 0);
  assert.equal(finished, Object.keys(state.files).length);
  assert(!remote.events.includes('publish'));
  assert(!remote.objects.has('latest.json'));
});

test('CDN uploads use multipart CLI settings, preserve metadata, and skip matching objects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lr-transfer-test-'));
  const calls = [];
  const remote = new ReleaseRemote(directory, state.version, async (...args) => calls.push(args));
  try {
    remote.objectHead = () => null;
    await remote.ensureObject('app.dmg', 'app.dmg', 'mac-hash');
    const [program, args, options] = calls[0];
    assert.equal(program, 'aws');
    assert.deepEqual(args.slice(2, 4), ['s3', 'cp']);
    assert(args.includes('sha256=mac-hash'));
    assert(args.includes('public, max-age=31536000, immutable'));
    // Explicit --profile can disable environment credentials; use only the
    // isolated config file and environment-selected default profile instead.
    assert(!args.includes('--profile'));
    assert.equal(options.env.AWS_PROFILE, 'default');
    const config = readFileSync(options.env.AWS_CONFIG_FILE, 'utf8');
    assert.match(config, /multipart_threshold = 16MB/);
    assert.match(config, /multipart_chunksize = 16MB/);
    assert.match(config, /max_concurrent_requests = 4/);
    assert.match(config, /preferred_transfer_client = classic/);
    remote.objectHead = () => ({ Metadata: { sha256: 'mac-hash' } });
    await remote.ensureObject('app.dmg', 'app.dmg', 'mac-hash');
    assert.equal(calls.length, 1);
    await assert.rejects(remote.ensureObject('app.dmg', 'app.dmg', 'changed-hash'), /Refusing to overwrite/);
    assert.equal(calls.length, 1);
  } finally { remote.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('fresh manifests, checksums and journal share digests of the real installer bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lr-digests-'));
  const mac = 'Live.Recorder_1.2.3_aarch64.dmg';
  const win = 'Live.Recorder_1.2.3_x64-setup.exe';
  try {
    writeFileSync(join(directory, mac), 'mac installer');
    writeFileSync(join(directory, win), 'windows installer');
    writeFileSync(join(directory, `${win}.sig`), signature('windows installer'));
    writeFileSync(join(directory, `${mac}.sig`), signature('mac installer'));
    const notes = join(tmpdir(), `lr-notes-${process.pid}.json`);
    try {
      writeFileSync(notes, JSON.stringify({ releases: [{ version: '1.2.3', publishedAt: '2026-10-05', notes: ['Fix'] }] }));
      const files = await prepareReleaseFiles(directory, '1.2.3', 'https://cdn.example.com', notes, pubkey);
      assert.deepEqual(await verifyFrozenFiles(directory, '1.2.3', pubkey), files);
      const manifest = JSON.parse(readFileSync(join(directory, 'latest.json')));
      for (const asset of Object.values(manifest.platforms)) assert.equal(asset.sha256, files[asset.filename]);
      for (const [name, digest] of Object.entries(files)) {
        assert.equal(digest, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex'));
      }
      const sums = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8');
      assert(!sums.includes('SHA256SUMS.txt'));
      assert(!sums.includes('release-state.json'));
      for (const name of [mac, win, 'latest.json', 'releases.json', `${win}.sig`]) assert(sums.includes(`${files[name]}  ${name}\n`));
      writeFileSync(join(directory, mac), 'tampered installer');
      await assert.rejects(verifyFrozenFiles(directory, '1.2.3', pubkey), /Frozen installer mismatch/);
    } finally { rmSync(notes, { force: true }); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('checks can be reused only from the exact trusted release run with all platform gates passed', () => {
  const saved = { ...state, runId: 123, runAttempt: 1 };
  const run = { head_sha: state.commit, head_branch: 'release', path: '.github/workflows/release.yml', event: 'push' };
  const jobs = ['quality', 'native-test (macos-15)', 'native-test (windows-latest)', 'build (macos-15)', 'build (windows-latest)'].map((name) => ({ name, conclusion: 'success' }));
  assert(checksMatchJournal(saved, state.commit, run, jobs));
  assert(!checksMatchJournal(state, state.commit, run, jobs));
  for (const alteration of [{ head_sha: 'other' }, { head_branch: 'main' }, { path: '.github/workflows/ci.yml' }, { event: 'pull_request' }]) {
    assert(!checksMatchJournal(saved, state.commit, { ...run, ...alteration }, jobs));
  }
  for (let i = 0; i < jobs.length; i++) {
    assert(!checksMatchJournal(saved, state.commit, run, jobs.filter((_, index) => index !== i)));
    assert(!checksMatchJournal(saved, state.commit, run, jobs.map((job, index) => index === i ? { ...job, conclusion: 'failure' } : job)));
  }
});

test('release snapshot avoids repeated reads and refreshes only when requested', () => {
  const remote = new ReleaseRemote('unused', state.version);
  let reads = 0;
  remote.api = () => { reads++; return { draft: true, assets: [] }; };
  try {
    remote.release(); remote.release(); remote.isDraft(); remote.readAsset('missing');
    assert.equal(reads, 1);
    remote.release(true);
    assert.equal(reads, 2);
  } finally { remote.close(); }
});


test('failed CDN verification or a changed tag blocks publication', async () => {
  for (const failure of ['cdn', 'tag']) {
    const remote = new FakeRemote();
    remote.verifyStaged = () => {
      if (failure === 'cdn') throw new Error('CDN bytes mismatch');
      remote.tag = 'different-commit';
    };
    await assert.rejects(publishRelease(state, remote), /CDN bytes mismatch|Tag commit mismatch/);
    assert(remote.draft);
    assert(!remote.events.includes('publish'));
  }
});

test('published sync cannot roll back a newer version or sync a draft', async () => {
  const remote = new FakeRemote();
  await assert.rejects(syncRelease(state, remote), /unpublished/);
  remote.draft = false;
  remote.latestVersion = 'v1.2.4';
  await assert.rejects(syncRelease(state, remote), /older release/);
  assert.deepEqual(remote.events, []);
});

test('check reuse includes successful jobs from earlier attempts and rejects later jobs', () => {
  const remote = new ReleaseRemote('unused', state.version);
  const saved = { ...state, runId: 1, runAttempt: 2 };
  const gates = ['quality', 'native-test (macos-15)', 'native-test (windows-latest)', 'build (macos-15)', 'build (windows-latest)'];
  let jobs = gates.map((name, i) => ({ name, id: i + 1, conclusion: 'success', run_attempt: 1 }));
  remote.api = (path) => path.includes('/jobs?') ? { jobs } : { head_sha: state.commit, head_branch: 'release', path: '.github/workflows/release.yml', event: 'push' };
  try {
    assert(remote.canReuseChecks(saved, state.commit));
    jobs.push({ name: 'quality', id: 10, conclusion: 'failure', run_attempt: 2 });
    assert(!remote.canReuseChecks(saved, state.commit));
    jobs.push({ name: 'quality', id: 11, conclusion: 'success', run_attempt: 3 });
    assert(!remote.canReuseChecks(saved, state.commit));
  } finally { remote.close(); }
});


test('public CDN checks compare three bounded ranges with local bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lr-cdn-ranges-'));
  const body = Buffer.alloc(1024 * 1024, 42);
  writeFileSync(join(directory, 'app.dmg'), body);
  const remote = new ReleaseRemote(directory, state.version);
  const originalFetch = globalThis.fetch;
  const base = process.env.UPDATE_BASE_URL;
  process.env.UPDATE_BASE_URL = 'https://cdn.example.com';
  let transferred = 0;
  const offsets = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://cdn.example.com/app.dmg');
    const [, start, end] = options.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);
    offsets.push(start);
    const bytes = body.subarray(start, end + 1);
    transferred += bytes.length;
    return new Response(bytes, { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': String(bytes.length) } });
  };
  try {
    await remote.verifyPublic('app.dmg', 'app.dmg', true);
    assert.deepEqual(offsets, [0, (body.length - 65536) / 2, body.length - 65536]);
    assert.equal(transferred, 3 * 65536);
  } finally {
    globalThis.fetch = originalFetch;
    if (base === undefined) delete process.env.UPDATE_BASE_URL; else process.env.UPDATE_BASE_URL = base;
    remote.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('server GitHub digests are checked again before publication', async () => {
  const remote = new ReleaseRemote('unused', state.version);
  remote.release = () => ({ draft: true, assets: [{ name: 'app.dmg', digest: 'sha256:wrong' }] });
  try { await assert.rejects(remote.verifyStaged(state), /GitHub asset verification failed/); }
  finally { remote.close(); }
});
