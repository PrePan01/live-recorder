import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { generateUpdateManifest } from './generate-update-manifest.mjs';
import { checkReleaseNotes } from './check-release-notes.mjs';

const execFile = promisify(execFileCallback);

test('release manifest requires both platforms and describes real bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-manifest-'));
  try {
    const notes = join(dir, 'release-notes.json');
    await writeFile(notes, JSON.stringify({ releases: [{ version: '0.5.112', publishedAt: '2026-09-13', notes: ['修复安装问题'] }] }));
    // Release assets must already use GitHub's public, space-free names.
    await writeFile(join(dir, 'Live.Recorder_0.5.112_aarch64.dmg'), 'abc');
    await assert.rejects(generateUpdateManifest(dir, '0.5.112', undefined, notes), /windows/);
    await assert.rejects(readFile(join(dir, 'latest.json')));
    await writeFile(join(dir, 'Live.Recorder_0.5.112_x64-setup.exe'), 'abcd');
    const result = await generateUpdateManifest(dir, '0.5.112', undefined, notes);
    assert.equal(result.platforms['macos-aarch64'].size, 3);
    assert.equal(result.platforms['windows-x86_64'].sha256, createHash('sha256').update('abcd').digest('hex'));
    assert.match(result.platforms['macos-aarch64'].url, /v0.5.112\/Live\.Recorder/);
    await assert.rejects(generateUpdateManifest(dir, '0.5.113', undefined, notes), /macos/);
    await writeFile(join(dir, 'Live Recorder_0.5.114_aarch64.dmg'), 'abc');
    await writeFile(join(dir, 'Live Recorder_0.5.114_x64-setup.exe'), 'abcd');
    await assert.rejects(generateUpdateManifest(dir, '0.5.114', undefined, notes), /must not contain whitespace/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manifest points asset urls at the mirror base when provided (#28)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-manifest-mirror-'));
  try {
    const notes = join(dir, 'release-notes.json');
    await writeFile(notes, JSON.stringify({ releases: [{ version: '0.5.112', publishedAt: '2026-09-13', notes: ['修复安装问题'] }] }));
    await writeFile(join(dir, 'Live.Recorder_0.5.112_aarch64.dmg'), 'abc');
    await writeFile(join(dir, 'Live.Recorder_0.5.112_x64-setup.exe'), 'abcd');
    const result = await generateUpdateManifest(dir, '0.5.112', 'https://live-recorder.s3.cn-south-1.qiniucs.com/', notes);
    assert.equal(
      result.platforms['macos-aarch64'].url,
      'https://live-recorder.s3.cn-south-1.qiniucs.com/Live.Recorder_0.5.112_aarch64.dmg',
    );
    assert.equal(
      result.platforms['windows-x86_64'].url,
      'https://live-recorder.s3.cn-south-1.qiniucs.com/Live.Recorder_0.5.112_x64-setup.exe',
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('release requires matching, well-formed notes and publishes the complete history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-manifest-notes-'));
  try {
    const notes = join(dir, 'release-notes.json');
    await writeFile(join(dir, 'Live.Recorder_0.5.112_aarch64.dmg'), 'abc');
    await writeFile(join(dir, 'Live.Recorder_0.5.112_x64-setup.exe'), 'abcd');
    await writeFile(notes, JSON.stringify({ releases: [{ version: '0.5.111', publishedAt: '2026-09-12', notes: ['旧版本'] }] }));
    await assert.rejects(generateUpdateManifest(dir, '0.5.112', undefined, notes), /Missing release notes/);
    await writeFile(notes, JSON.stringify({ releases: [
      { version: '0.5.112', publishedAt: '2026-09-13', notes: ['新功能'] },
      { version: '0.5.111', publishedAt: '2026-09-12', notes: ['旧版本'] },
    ] }));
    await generateUpdateManifest(dir, '0.5.112', undefined, notes);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).notes, ['新功能']);
    assert.equal(JSON.parse(await readFile(join(dir, 'releases.json'), 'utf8')).releases.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('release notes preflight rejects a missing current version before platform builds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-release-notes-check-'));
  try {
    const notes = join(dir, 'release-notes.json');
    await writeFile(notes, JSON.stringify({ releases: [{ version: '0.5.111', publishedAt: '2026-09-12', notes: ['旧版本'] }] }));
    await assert.rejects(checkReleaseNotes('0.5.112', notes), /Missing release notes/);
    await writeFile(notes, JSON.stringify({ releases: [{ version: '0.5.112', publishedAt: '2026-09-13', notes: ['新功能'] }] }));
    assert.deepEqual((await checkReleaseNotes('0.5.112', notes)).notes, ['新功能']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI treats its third argument as the release notes path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-manifest-cli-'));
  try {
    const notes = join(dir, 'notes.json');
    await writeFile(join(dir, 'Live.Recorder_0.5.112_aarch64.dmg'), 'abc');
    await writeFile(join(dir, 'Live.Recorder_0.5.112_x64-setup.exe'), 'abcd');
    await writeFile(notes, JSON.stringify({ releases: [{ version: '0.5.112', publishedAt: '2026-09-13', notes: ['命令行参数校验'] }] }));
    await execFile(process.execPath, ['scripts/generate-update-manifest.mjs', dir, '0.5.112', notes], { cwd: process.cwd() });
    assert.equal(JSON.parse(await readFile(join(dir, 'latest.json'), 'utf8')).version, '0.5.112');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
