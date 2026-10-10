import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseIdentity, publishRelease, ReleaseRemote, checksMatchJournal, prepareReleaseFiles, syncRelease, verifyFrozenFiles, asyncCommand } from './release-pipeline.mjs';

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
  release() { return { draft: this.draft }; }
  readAsset(name) { return name === 'release-state.json' ? this.journal ?? this.assets.get(name) : this.assets.get(name); }
  requireCheckpoint(saved) { this.event('journal'); this.journal = JSON.stringify(saved); }
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
  async ensureObjects(entries) { for (const [key, name, digest] of entries) await this.ensureObject(key, name, digest); }
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
  assert(remote.journal);
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

test('AWS batch overlaps GitHub uploads with bounded GitHub concurrency', async () => {
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
  assert.deepEqual(peak, { github: 2, cdn: 1 });
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

test('CDN uploads use one recursive AWS batch, native progress and transfer defaults', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lr-transfer-test-'));
  const calls = [];
  const remote = new ReleaseRemote(directory, state.version, async (...args) => calls.push(args));
  try {
    writeFileSync(join(directory, 'app.dmg'), 'mac bytes');
    writeFileSync(join(directory, 'latest.json'), '{}');
    remote.objectHead = () => null;
    await remote.ensureObjects([['app.dmg', 'app.dmg', 'mac-hash'], ['releases/v1.2.3/latest.json', 'latest.json', 'manifest-hash']]);
    const [program, args, options] = calls[0];
    assert.equal(program, 'aws');
    assert.equal(args[args.indexOf('s3') + 1], 'cp');
    assert(!args.includes('--cli-connect-timeout'));
    assert(!args.includes('--cli-read-timeout'));
    assert(!args.includes('--metadata'));
    assert(!args.includes('--only-show-errors'));
    assert(options.timeout > 19 * 60 * 1000);
    assert.equal(options.idleTimeout, 180000);
    assert(args.includes('--recursive'));
    assert.equal(options.liveOutput, true);
    const staging = args[args.indexOf('cp') + 1];
    assert.equal(readFileSync(join(staging, 'app.dmg'), 'utf8'), 'mac bytes');
    assert.equal(readFileSync(join(staging, 'releases/v1.2.3/latest.json'), 'utf8'), '{}');
    assert.throws(() => readFileSync(join(staging, 'latest.json')));
    assert(args.includes('public, max-age=31536000, immutable'));
    assert(!args.includes('--profile'));
    assert.equal(options.env, undefined);
    const metadata = { 'release-set-sha256': createHash('sha256').update(JSON.stringify([
      ['app.dmg', 'app.dmg', 'mac-hash'], ['releases/v1.2.3/latest.json', 'latest.json', 'manifest-hash'],
    ].sort())).digest('hex') };
    remote.objectHead = key => ({ Metadata: metadata, ContentLength: key === 'app.dmg' ? 9 : 2 });
    await remote.ensureObjects([['app.dmg', 'app.dmg', 'mac-hash'], ['releases/v1.2.3/latest.json', 'latest.json', 'manifest-hash']]);
    assert.equal(calls.length, 1);
    remote.objectHead = () => ({ Metadata: { sha256: 'mac-hash' } });
    await assert.rejects(remote.ensureObjects([['app.dmg', 'app.dmg', 'changed-hash']]), /Refusing to overwrite/);
    assert.equal(calls.length, 1);
  } finally { remote.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('public allowlist contains only two installers and required manifests', async () => {
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
      assert.deepEqual(Object.keys(files).sort(), [mac, win, 'latest.json', 'releases.json'].sort());
      rmSync(join(directory, `${mac}.sig`));
      rmSync(join(directory, `${win}.sig`));
      assert.deepEqual(await verifyFrozenFiles(directory, '1.2.3', pubkey), files);
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
  remote.api = () => { reads++; return [{ tag_name: remote.tag, draft: true, assets: [] }]; };
  try {
    remote.release(); remote.release(); remote.isDraft(); remote.readAsset('missing');
    assert.equal(reads, 1);
    remote.release(true);
    assert.equal(reads, 2);
  } finally { remote.close(); }
});

test('draft lookup uses the release list without a redundant by-tag request', () => {
  const remote = new ReleaseRemote('unused', state.version);
  // This fixture has no internal checkpoint. Model that explicitly so a CI
  // GITHUB_SHA does not trigger an unrelated Actions artifact lookup.
  remote.journalBundle = () => null;
  const draft = { id: 123, tag_name: 'v1.2.3', draft: true, assets: [] };
  const reads = [];
  remote.api = (path) => {
    reads.push(path);
    if (path === 'releases?per_page=100&page=1') return [draft];
    throw new Error(`Unexpected API access: ${path}`);
  };
  try {
    assert.equal(remote.release(), draft);
    assert.equal(remote.isDraft(), true);
    assert.equal(remote.readAsset('release-state.json'), null);
    assert.equal(reads.length, 1);
    // Existing drafts must not be recreated or mistaken for published releases.
    remote.ensureDraft(state.commit);
    assert.equal(remote.release(), draft);
    assert.equal(reads.length, 2);
  } finally { remote.close(); }
});

test('draft lookup paginates and refreshes after a cached missing release', () => {
  const remote = new ReleaseRemote('unused', state.version);
  const draft = { id: 123, tag_name: 'v1.2.3', draft: true, assets: [] };
  let visible = false;
  const reads = [];
  remote.api = (path) => {
    reads.push(path);
    if (path === 'releases?per_page=100&page=1') {
      return visible ? Array.from({ length: 100 }, (_, i) => ({ tag_name: `other-${i}` })) : [];
    }
    if (path === 'releases?per_page=100&page=2') return [draft];
    throw new Error(`Unexpected API access: ${path}`);
  };
  try {
    assert.equal(remote.release(), null);
    visible = true;
    assert.equal(remote.release(), null);
    assert.equal(reads.length, 1);
    assert.equal(remote.release(true), draft);
    assert(reads.includes('releases?per_page=100&page=2'));
  } finally { remote.close(); }
});

test('invalid release-list responses cannot be cached as a missing draft', () => {
  const remote = new ReleaseRemote('unused', state.version);
  remote.api = () => ({ message: 'Not Found' });
  try {
    assert.throws(() => remote.release(), /Unable to list releases/);
    assert.equal(remote.releaseSnapshot, undefined);
  } finally { remote.close(); }
});

test('published releases also use the list and retain snapshot caching', () => {
  const remote = new ReleaseRemote('unused', state.version);
  const published = { tag_name: remote.tag, draft: false, assets: [] };
  let calls = 0;
  remote.api = path => {
    assert.equal(path, 'releases?per_page=100&page=1');
    calls++;
    return [published];
  };
  try {
    assert.equal(remote.release(), published);
    assert.equal(remote.release(), published);
    assert.equal(calls, 1);
  } finally { remote.close(); }
});

for (const missing of [true, false]) {
  test(`CLI ${missing ? '404 probes remain quiet' : 'permission errors remain fatal'}`, () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { ReleaseRemote } from './scripts/release-pipeline.mjs';
      const directory = mkdtempSync(join(tmpdir(), 'lr-cli-probes-'));
      const missing = ${missing};
      for (const name of ['gh', 'aws']) {
        const file = join(directory, name);
        const message = name === 'gh'
          ? (missing ? 'gh: Not Found (HTTP 404)' : 'gh: Forbidden (HTTP 403)')
          : (missing ? 'An error occurred (404) when calling the HeadObject operation: Not Found'
                     : 'An error occurred (AccessDenied) when calling the HeadObject operation: Forbidden');
        writeFileSync(file, '#!' + process.execPath + '\\nprocess.stderr.write(' + JSON.stringify(message + '\\n') + ');process.exit(1);');
        chmodSync(file, 0o755);
      }
      process.env.PATH = directory + ':' + process.env.PATH;
      process.env.GITHUB_REPOSITORY = 'fixture/repository';
      process.env.QINIU_ENDPOINT = 'https://fixture.invalid';
      process.env.QINIU_BUCKET = 'fixture';
      const remote = new ReleaseRemote(directory, '1.2.3');
      try {
        if (missing) {
          assert.equal(remote.api('git/ref/tags/v1.2.3'), null);
          assert.equal(remote.objectHead('app.dmg'), null);
        } else {
          assert.throws(() => remote.api('git/ref/tags/v1.2.3'), /HTTP 403/);
          assert.throws(() => remote.objectHead('app.dmg'), /AccessDenied/);
        }
      } finally { remote.close(); rmSync(directory, { recursive: true, force: true }); }
    `], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
}


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


test('upload subprocesses stop on timeout and close interactive input', async () => {
  await assert.rejects(asyncCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 50, label: 'timeout fixture' }), /timed out/);
  const result = await asyncCommand(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("closed"))'], { timeout: 2000, label: 'stdin fixture' });
  assert.match(result, /closed/);
});

test('uncertain CDN upload is checked before retry, preserving a completed object', async () => {
  let calls = 0;
  let heads = 0;
  const directory = mkdtempSync(join(tmpdir(), 'lr-batch-retry-'));
  writeFileSync(join(directory, 'app.dmg'), 'fixture');
  const remote = new ReleaseRemote(directory, state.version, async () => { calls++; throw new Error('upload connection interrupted'); });
  remote.objectHead = () => ++heads === 1 ? null : { Metadata: { sha256: 'mac-hash' } };
  try {
    await remote.ensureObjects([['app.dmg', 'app.dmg', 'mac-hash']]);
    assert.equal(calls, 1);
    assert.equal(heads, 2);
  } finally { remote.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a partially completed AWS batch retries only missing files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lr-partial-batch-'));
  const uploaded = new Map();
  const batches = [];
  const reads = [];
  for (const name of ['app.dmg', 'app.exe']) writeFileSync(join(directory, name), name);
  const remote = new ReleaseRemote(directory, state.version, async (program, args) => {
    const staging = args[args.indexOf('cp') + 1];
    assert(!args.includes('--metadata'));
    const names = ['app.dmg', 'app.exe'].filter(name => {
      try { readFileSync(join(staging, name)); return true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
    });
    batches.push(names);
    // Native uploads carry no custom metadata; retries must verify their bytes.
    uploaded.set(names[0], { ContentLength: Buffer.byteLength(names[0]) });
    if (batches.length === 1) throw new Error('connection interrupted after first file');
  });
  remote.objectHead = key => uploaded.get(key) ?? null;
  remote.readObject = key => { reads.push(key); return Buffer.from(key); };
  try {
    await remote.ensureObjects(['app.dmg', 'app.exe'].map(name => [name, name, createHash('sha256').update(name).digest('hex')]));
    assert.deepEqual(batches, [['app.dmg', 'app.exe'], ['app.exe']]);
    assert.deepEqual(reads, ['app.dmg']);
    assert.equal(uploaded.size, 2);
  } finally { remote.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('native upload progress is visible even when the subprocess fails', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { asyncCommand } from './scripts/release-pipeline.mjs';
    try {
      await asyncCommand(process.execPath, ['-e', 'process.stdout.write("Completed 8 MiB/64 MiB\\r");process.exit(1)'], { liveOutput: true });
    } catch { process.exitCode = 1; }
  `], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Completed 8 MiB\/64 MiB\n/);
});

test('active byte progress extends the idle window while stalled uploads stop', async () => {
  const result = await asyncCommand(process.execPath, ['-e', 'let n=0;const timer=setInterval(()=>{console.log(`Completed ${++n}.0 MiB/9.0 MiB`);if(n===5){clearInterval(timer)}},150)'], { timeout: 3000, idleTimeout: 500 });
  assert.match(result, /Completed 5.0 MiB/);
  await assert.rejects(asyncCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 2000, idleTimeout: 80 }), /no upload progress/);
});
