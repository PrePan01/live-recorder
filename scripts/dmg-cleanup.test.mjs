import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { detachDmg } from './dmg-cleanup.mjs';

const ok = { status: 0, stdout: 'ejected', stderr: '' };
const busy = { status: 16, stdout: '', stderr: "hdiutil: couldn't unmount disk - Resource busy" };
const mount = '/tmp/test DMG 中文';
function commands(results) {
  const calls = [], waits = [];
  return {
    calls, waits,
    options: {
      execute(program, args) {
        calls.push([program, args]);
        assert.ok(results.length, 'unexpected extra detach command');
        return results.shift();
      },
      pause: async ms => waits.push(ms), warn() {},
    },
  };
}

test('normal DMG detach succeeds without retries or force', async () => {
  const f = commands([ok]);
  await detachDmg(mount, f.options);
  assert.deepEqual(f.calls, [['hdiutil', ['detach', mount]]]);
  assert.deepEqual(f.waits, []);
});

test('transient Resource busy is retried normally', async () => {
  const f = commands([busy, busy, ok]);
  await detachDmg(mount, f.options);
  assert.equal(f.calls.length, 3);
  assert(f.calls.every(([, args]) => !args.includes('-force')));
  assert.deepEqual(f.waits, [500, 1000]);
});

test('persistent busy mount is force-detached only after bounded normal retries', async () => {
  const f = commands([busy, busy, busy, ok]);
  await detachDmg(mount, f.options);
  assert.deepEqual(f.calls.map(([, args]) => args), [
    ['detach', mount], ['detach', mount], ['detach', mount], ['detach', mount, '-force'],
  ]);
});

test('failed forced detach remains an error', async () => {
  const f = commands([busy, busy, busy, { status: 1, stderr: 'force detach denied' }]);
  await assert.rejects(detachDmg(mount, f.options), /Cannot detach DMG.*force detach denied/);
  assert.equal(f.calls.length, 4);
});

test('non-busy detach errors are not retried or forced', async () => {
  const f = commands([{ status: 1, stderr: 'invalid mount point' }]);
  await assert.rejects(detachDmg(mount, f.options), /invalid mount point/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.waits, []);
});

test('subprocess launch failures and timeouts are not mistaken for a busy mount', async () => {
  for (const error of [new Error('spawn ENOENT'), new Error('spawn ETIMEDOUT')]) {
    const f = commands([{ status: null, error }]);
    await assert.rejects(detachDmg(mount, f.options), error.message);
    assert.equal(f.calls.length, 1);
  }
});

for (const holdSeconds of [1, 30]) {
  test(`actual mounted DMG recovers from an occupied working directory (${holdSeconds}s)`, {
    skip: process.platform !== 'darwin', timeout: 60000,
  }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lr-dmg-cleanup-'));
    const source = join(directory, 'source'), mountPoint = join(directory, 'mounted');
    const image = join(directory, 'test.dmg');
    mkdirSync(source); mkdirSync(mountPoint); writeFileSync(join(source, 'fixture.txt'), 'DMG cleanup fixture');
    let attached = false, holder;
    const execute = args => {
      const result = spawnSync('hdiutil', args, { encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    };
    try {
      execute(['create', '-srcfolder', source, '-fs', 'HFS+', '-format', 'UDZO', image]);
      execute(['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, image]);
      attached = true;
      holder = spawn('/bin/sleep', [String(holdSeconds)], { cwd: mountPoint, stdio: 'ignore' });
      await once(holder, 'spawn');
      const calls = [];
      await detachDmg(mountPoint, {
        execute(program, args, options) {
          const result = spawnSync(program, args, options);
          calls.push({ args, status: result.status });
          return result;
        }, warn() {},
      });
      attached = false;
      assert.equal(calls[0].status, 16, 'fixture must reproduce the CI busy-mount error');
      assert.equal(calls.at(-1).status, 0);
      assert.equal(calls.at(-1).args.includes('-force'), holdSeconds === 30);
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        const exited = once(holder, 'exit'); holder.kill('SIGTERM'); await exited;
      }
      if (attached) {
        const result = spawnSync('hdiutil', ['detach', mountPoint, '-force'], { encoding: 'utf8', timeout: 15000 });
        attached = result.status !== 0;
      }
      if (!attached) rmSync(directory, { recursive: true, force: true });
    }
  });
}
