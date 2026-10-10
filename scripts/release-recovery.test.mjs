import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReleaseRemote, prepareReleaseFiles, validateJournal, syncRelease, publishRelease } from './release-pipeline.mjs';
import { pubkey, signature } from './test-fixtures/signatures.mjs';

const commit = 'a'.repeat(40);
const version = '1.2.3';
const mac = `Live.Recorder_${version}_aarch64.dmg`;
const win = `Live.Recorder_${version}_x64-setup.exe`;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lr-recovery-fixture-'));
  const original = join(root, 'original');
  mkdirSync(original);
  for (const [name, body] of [[mac, 'original mac'], [win, 'original windows']]) {
    writeFileSync(join(original, name), body);
    writeFileSync(join(original, `${name}.sig`), signature(body));
  }
  const notes = join(root, 'notes.json');
  writeFileSync(notes, JSON.stringify({ releases: [{ version, publishedAt: '2026-10-05', notes: ['Fix'] }] }));
  const files = await prepareReleaseFiles(original, version, 'https://cdn.example.com', notes, pubkey);
  const state = { version, commit, files, runId: 123, runAttempt: 1 };
  return { root, original, state, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('partial release restores only the missing platform from the original run and rejects changed bytes', async () => {
  const f = await fixture();
  const restored = join(f.root, 'restored');
  const downloads = [];
  const remote = new ReleaseRemote(restored, version, async (program, args) => {
    assert.equal(program, 'gh');
    assert.equal(args[2], '123');
    const name = args[args.indexOf('--name') + 1];
    const directory = args[args.indexOf('--dir') + 1];
    downloads.push(name);
    assert.equal(name, `live-recorder-windows-${version}`);
    // Actual packaging artifact names contain spaces; restoration normalizes them.
    copyFileSync(join(f.original, win), join(directory, win.replace('Live.Recorder', 'Live Recorder')));
  });
  remote.assertTag = sha => assert.equal(sha, commit);
  remote.canReuseChecks = saved => saved.runId === 123;
  remote.readAsset = name => {
    if (name === 'release-state.json') return Buffer.from(JSON.stringify(f.state));
    if (name === win) return null;
    return readFileSync(join(f.original, name));
  };
  try {
    assert.deepEqual(await remote.restoreFrozen(commit, false, pubkey), f.state);
    assert.deepEqual(downloads, [`live-recorder-windows-${version}`]);
    assert.equal(readFileSync(join(restored, win), 'utf8'), 'original windows');
    assert.equal(readFileSync(join(restored, mac), 'utf8'), 'original mac');
    writeFileSync(join(restored, win), 'different rebuild');
    await assert.rejects(remote.restoreFrozen(commit, false, pubkey), /Frozen installer mismatch/);
  } finally { remote.close(); f.close(); }
});

test('published index recovery does not download installers or depend on old job records', async () => {
  const f = await fixture();
  const remote = new ReleaseRemote(join(f.root, 'indexes'), version, async () => assert.fail('installer download'));
  const read = [];
  remote.readAsset = name => {
    read.push(name);
    return name === 'release-state.json' ? Buffer.from(JSON.stringify(f.state)) : readFileSync(join(f.original, name));
  };
  remote.assertTag = () => {};
  remote.canReuseChecks = () => assert.fail('old job lookup');
  try {
    await remote.restoreFrozen(commit, true, pubkey);
    assert.deepEqual(read, ['release-state.json', 'latest.json', 'releases.json']);
  } finally { remote.close(); f.close(); }
});

test('internal checkpoint lookup binds tag, source commit and original run and caches one small download', async () => {
  const f = await fixture();
  const previous = process.env.RELEASE_SOURCE_COMMIT;
  process.env.RELEASE_SOURCE_COMMIT = commit;
  const remote = new ReleaseRemote('unused', version);
  let downloads = 0;
  remote.release = () => ({ draft: true, assets: [] });
  remote.api = path => {
    assert.match(path, /^actions\/artifacts\?name=release-state-v1\.2\.3-/);
    return { artifacts: [{ name: `release-state-v${version}-${commit}`, expired: false,
      workflow_run: { id: 123, head_sha: commit } }] };
  };
  remote.downloadRunArtifact = (runId, name, directory) => {
    downloads++;
    assert.equal(runId, 123);
    writeFileSync(join(directory, 'release-state.json'), JSON.stringify(f.state));
    copyFileSync(join(f.original, 'latest.json'), join(directory, 'latest.json'));
  };
  try {
    assert.deepEqual(JSON.parse(remote.readAsset('release-state.json')), f.state);
    assert(remote.readAsset('latest.json'));
    assert.equal(downloads, 1);
    validateJournal(f.state, `v${version}`, commit);
    assert.throws(() => validateJournal({ ...f.state, files: { '../installer': 'a'.repeat(64) } }, `v${version}`, commit), /Invalid frozen/);
  } finally {
    if (previous === undefined) delete process.env.RELEASE_SOURCE_COMMIT; else process.env.RELEASE_SOURCE_COMMIT = previous;
    remote.close(); f.close();
  }
});

test('missing release blocks index synchronization before any pointer changes', async () => {
  const remote = { assertTag() {}, release: () => null, updatePointer: () => assert.fail('pointer write') };
  await assert.rejects(syncRelease({ version, commit }, remote), /unpublished/);
});

test('missing checkpoint blocks publication before even creating a draft', async () => {
  const f = await fixture();
  const remote = new ReleaseRemote('unused', version);
  remote.assertTag = () => {};
  remote.latestGitHubVersion = () => null;
  remote.readObject = () => null;
  remote.readAsset = () => null;
  remote.release = () => null;
  remote.ensureDraft = () => assert.fail('draft creation');
  try {
    await assert.rejects(publishRelease(f.state, remote), /Missing internal release checkpoint/);
  } finally { remote.close(); f.close(); }
});

test('index recovery cannot replace the same version with different installer bytes', async () => {
  const remote = {
    assertTag() {}, release: () => ({ draft: false }), latestGitHubVersion: () => `v${version}`,
    readObject: () => JSON.stringify({ version, platforms: { mac: { filename: mac, sha256: 'old-bytes' } } }),
    updatePointer: () => assert.fail('pointer write'),
  };
  await assert.rejects(syncRelease({ version, commit, files: { [mac]: 'different-bytes' } }, remote), /different bytes/);
});

test('published index repair remains possible after internal artifacts expire', async () => {
  const f = await fixture();
  const remote = new ReleaseRemote('unused', version);
  const previous = process.env.RELEASE_SOURCE_COMMIT;
  process.env.RELEASE_SOURCE_COMMIT = commit;
  const release = { draft: false, assets: Object.entries(f.state.files)
    .map(([name, digest]) => ({ name, digest: `sha256:${digest}` })) };
  remote.readAsset = name => readFileSync(join(f.original, name));
  try {
    const saved = remote.publishedJournal(release);
    assert.deepEqual(saved.files, f.state.files);
    assert.equal(saved.publishedSnapshot, true);
    release.assets.find(asset => asset.name === win).digest = `sha256:${'0'.repeat(64)}`;
    assert.throws(() => remote.publishedJournal(release), /installer digest mismatch/);
  } finally {
    if (previous === undefined) delete process.env.RELEASE_SOURCE_COMMIT; else process.env.RELEASE_SOURCE_COMMIT = previous;
    remote.close(); f.close();
  }
});

test('publication requires a fresh public result after a successful edit, including uncertain edits', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { ReleaseRemote } from './scripts/release-pipeline.mjs';
    const directory = mkdtempSync(join(tmpdir(), 'lr-publication-'));
    const cli = join(directory, 'gh');
    writeFileSync(cli, '#!' + process.execPath + '\\nprocess.exit(process.env.UNCERTAIN_EDIT ? 1 : 0);');
    chmodSync(cli, 0o755);
    process.env.PATH = directory + ':' + process.env.PATH;
    const remote = new ReleaseRemote('unused', '1.2.3');
    remote.assertTag = () => {};
    try {
      let reads = 0;
      remote.release = () => ({ draft: ++reads === 1 });
      remote.publishGitHub('commit');
      assert.equal(reads, 2);
      process.env.UNCERTAIN_EDIT = '1';
      reads = 0;
      remote.release = () => ({ draft: ++reads === 1 });
      remote.publishGitHub('commit');
      assert(reads >= 3);
      delete process.env.UNCERTAIN_EDIT;
      remote.release = () => null;
      assert.throws(() => remote.publishGitHub('commit'), /Release missing/);
      remote.release = () => ({ draft: true });
      assert.throws(() => remote.publishGitHub('commit'), /could not be confirmed/);
    } finally { remote.close(); rmSync(directory, { recursive: true, force: true }); }
  `], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
});
