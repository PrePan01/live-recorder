import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, linkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ReleaseRemote, verifyFrozenFiles, assertReleaseIdentity } from './release-pipeline.mjs';

// Recovery only: compare the original native AWS command with the publisher's
// child-process adapter. Keep raw debug headers private; print only error types
// and HTTP status counts, never request headers, bodies, URLs or credentials.
async function main() {
  const [directory, version] = process.argv.slice(2);
  if (process.env.GITHUB_REF !== 'refs/heads/release' || !/^\d+\.\d+\.\d+$/.test(version))
    throw new Error('Native recovery requires the release branch and a valid version');
  const state = JSON.parse(readFileSync(join(directory, 'release-state.json')));
  const files = await verifyFrozenFiles(directory, version);
  assertReleaseIdentity(state, { version, commit: process.env.RELEASE_SOURCE_COMMIT, files });
  const remote = new ReleaseRemote(directory, version);
  const scratch = mkdtempSync(join(tmpdir(), 'lr-native-upload-'));
  try {
    remote.assertTag(state.commit);
    const journal = remote.readAsset('release-state.json');
    if (!journal) throw new Error('Missing frozen release journal');
    assertReleaseIdentity(JSON.parse(journal), state);
    const entries = Object.entries(files).map(([name, digest]) => [
      ['latest.json', 'releases.json', 'SHA256SUMS.txt'].includes(name)
        ? `releases/v${version}/${name}` : name, name, digest,
    ]);
    const fingerprint = createHash('sha256').update(JSON.stringify([...entries].sort())).digest('hex');
    const pending = [];
    for (const [key, name, digest] of entries) {
      const head = remote.objectHead(key);
      if (head) {
        if (head.Metadata?.['release-set-sha256'] === fingerprint) continue;
        const actual = head.Metadata?.sha256 || createHash('sha256').update(remote.readObject(key, head)).digest('hex');
        if (actual !== digest) throw new Error(`Refusing to overwrite CDN object ${key}`);
        continue;
      }
      const target = join(scratch, key);
      mkdirSync(dirname(target), { recursive: true });
      linkSync(join(directory, name), target);
      pending.push(key);
    }
    if (!pending.length) return;
    console.log(execFileSync('aws', ['--version'], { encoding: 'utf8' }).trim());
    console.log(`Native AWS upload: ${pending.length} missing files`);
    await new Promise((resolve, reject) => {
      const child = spawn('aws', ['--debug', '--endpoint-url', process.env.QINIU_ENDPOINT,
        's3', 'cp', scratch, `s3://${process.env.QINIU_BUCKET}/`, '--recursive',
        '--cache-control', 'public, max-age=31536000, immutable'], {
        stdio: ['ignore', 'inherit', 'pipe'], timeout: 8 * 60 * 1000,
      });
      const statuses = new Map();
      const errors = new Set();
      let partial = '';
      child.stderr.on('data', chunk => {
        const lines = (partial + chunk.toString()).split('\n');
        partial = lines.pop().slice(-4096);
        for (const line of lines) {
          for (const match of line.matchAll(/HTTP\/1\.1" (\d{3})/g))
            statuses.set(match[1], (statuses.get(match[1]) || 0) + 1);
          for (const match of line.matchAll(/(?:botocore|s3transfer|awscrt)\.\w+\.([A-Za-z]+(?:Error|Exception))/g))
            errors.add(match[1]);
          for (const match of line.matchAll(/<Code>([A-Za-z0-9]+)<\/Code>/g)) errors.add(match[1]);
        }
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        console.log(`Native AWS exit: ${code}; signal: ${signal || 'none'}`);
        console.log(`AWS HTTP status counts: ${JSON.stringify(Object.fromEntries(statuses))}`);
        console.log(`AWS error types: ${[...errors].join(', ') || 'none captured'}`);
        if (code !== 0 || signal) reject(new Error('Native AWS upload failed'));
        else resolve();
      });
    });
    for (const key of pending) if (!remote.objectHead(key))
      throw new Error(`Native AWS returned without completing ${key}`);
  } finally { remote.close(); rmSync(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
