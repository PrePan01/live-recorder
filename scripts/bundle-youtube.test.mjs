import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyYoutubeRuntime } from '../frontend/scripts/bundle-youtube.mjs';
const hash = data => createHash('sha256').update(data).digest('hex');

test('bundled directory runtime detects changed binaries, missing dependencies and forged receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lr-runtime-integrity-'));
  try {
    await writeFile(path.join(root, 'binary'), 'official binary');
    await writeFile(path.join(root, 'dependency'), 'official library');
    const receipt = { files: [{ name: 'binary', sha256: hash('official binary') }, { name: 'dependency', sha256: hash('official library') }] };
    const expected = hash(JSON.stringify(receipt.files));
    assert.equal(await verifyYoutubeRuntime(root, receipt, expected), true);
    await writeFile(path.join(root, 'binary'), 'modified binary');
    assert.equal(await verifyYoutubeRuntime(root, receipt, expected), false);
    const forged = structuredClone(receipt); forged.files[0].sha256 = hash('modified binary');
    assert.equal(await verifyYoutubeRuntime(root, forged, expected), false);
    await writeFile(path.join(root, 'binary'), 'official binary');
    await writeFile(path.join(root, 'unexpected-library'), 'injected library');
    assert.equal(await verifyYoutubeRuntime(root, receipt, expected), false);
    await rm(path.join(root, 'unexpected-library'));
    await rm(path.join(root, 'dependency'));
    assert.equal(await verifyYoutubeRuntime(root, receipt, expected), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime receipts cannot read paths outside their package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lr-runtime-path-'));
  try {
    const receipt = { files: [{ name: '../outside', sha256: hash('') }] };
    assert.equal(await verifyYoutubeRuntime(root, receipt, hash(JSON.stringify(receipt.files))), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
