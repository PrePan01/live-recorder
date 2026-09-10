import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateUpdateManifest } from './generate-update-manifest.mjs';

test('release manifest requires both platforms and describes real bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lr-manifest-'));
  try {
    await writeFile(join(dir, 'Live Recorder_0.5.112_aarch64.dmg'), 'abc');
    await assert.rejects(generateUpdateManifest(dir, '0.5.112'), /windows/);
    await assert.rejects(readFile(join(dir, 'latest.json')));
    await writeFile(join(dir, 'Live Recorder_0.5.112_x64.msi'), 'abcd');
    const result = await generateUpdateManifest(dir, '0.5.112');
    assert.equal(result.platforms['macos-aarch64'].size, 3);
    assert.equal(result.platforms['windows-x86_64'].sha256, createHash('sha256').update('abcd').digest('hex'));
    assert.match(result.platforms['macos-aarch64'].url, /v0.5.112\/Live%20Recorder/);
    await assert.rejects(generateUpdateManifest(dir, '0.5.113'), /macos/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
