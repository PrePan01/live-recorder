import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const workflow = name => parse(readFileSync(new URL(`../workflows/${name}.yml`, import.meta.url), 'utf8'));
const release = workflow('release');
const fresh = () => ({
  prepare: { result: 'success', outputs: { should_release: 'true', reuse_checks: 'false', reuse_release: 'false' } },
  ...Object.fromEntries(['quality', 'native-test', 'build'].map(name => [name, { result: 'success' }])),
});
const evaluate = (condition, needs, { publish = true, branch = 'release', published = 'false', frozen = 'false' } = {}) => {
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('cancelled()', 'false').replace(/needs\.([a-z][a-z-]*)/g, 'needs["$1"]');
  return Function('needs', 'github', 'inputs', 'steps', `return (${expression});`)(needs,
    { ref: `refs/heads/${branch}`, event_name: 'workflow_dispatch' }, { publish },
    { publication: { outputs: { published, frozen } } });
};

test('publication requires successful quality and both native builds before either destination becomes official', () => {
  assert.deepEqual(release.jobs.release.needs, ['prepare', 'quality', 'build', 'native-test']);
  assert(evaluate(release.jobs.release.if, fresh()));
  for (const gate of ['prepare', 'quality', 'build', 'native-test']) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const needs = fresh(); needs[gate].result = result;
      assert.equal(evaluate(release.jobs.release.if, needs), false, `${gate}: ${result}`);
    }
  }
  assert.equal(evaluate(release.jobs.release.if, fresh(), { publish: false }), false);
  assert.equal(evaluate(release.jobs.release.if, fresh(), { branch: 'main' }), false);
});

test('fresh publication downloads build artifacts once, freezes manifests, publishes both destinations, then synchronizes indexes', () => {
  const steps = release.jobs.release.steps.filter(step => !step.if || evaluate(step.if, fresh()));
  assert.equal(steps.filter(step => step.uses?.startsWith('actions/download-artifact@')).length, 1);
  assert(!steps.some(step => step.run?.includes(' restore ')));
  const prepare = steps.findIndex(step => step.run?.includes(' prepare '));
  const checkpoint = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  const publish = steps.findIndex(step => step.run?.includes(' publish '));
  const sync = steps.findIndex(step => step.run?.includes(' sync '));
  assert(prepare >= 0 && prepare < checkpoint && checkpoint < publish && publish < sync);
  const saved = steps[checkpoint].with.path;
  assert(!saved.includes('*.dmg') && !saved.includes('*.exe') && !saved.includes('release-assets/*'));
  assert.equal(Object.values(release.jobs).filter(job => job.uses).length, 0, 'no additional reusable workflow dependency on the proven normal release path');
});

test('only trusted frozen releases may reuse successful platform gates', () => {
  const needs = fresh();
  needs.prepare.outputs.reuse_checks = 'true';
  needs.prepare.outputs.reuse_release = 'true';
  for (const gate of ['quality', 'native-test', 'build']) needs[gate].result = 'skipped';
  assert(evaluate(release.jobs.release.if, needs));
  needs.prepare.outputs.reuse_checks = 'false';
  assert.equal(evaluate(release.jobs.release.if, needs), false);
});

test('both platform installers retain mandatory local installation validation', () => {
  assert(release.jobs.build.steps.some(step => step.run === 'npm run package'));
  const packager = readFileSync(new URL('../../scripts/package.mjs', import.meta.url), 'utf8');
  assert(packager.includes('["scripts/check-installation.mjs"]'));
  assert(!packager.includes('--skip-installation-check'));
  assert.deepEqual(release.jobs.build.strategy.matrix.include.map(item => item.os), ['macos-15', 'windows-latest']);
});

test('published index repair does not download or upload installers', () => {
  const needs = fresh(); needs.prepare.outputs.reuse_release = 'true';
  const steps = release.jobs.release.steps.filter(step => !step.if || evaluate(step.if, needs, { published: 'true', frozen: 'true' }));
  assert(!steps.some(step => step.uses?.startsWith('actions/download-artifact@')));
  assert(!steps.some(step => step.run?.includes(' publish ')));
  assert(steps.some(step => step.run?.includes(' restore ')));
  assert(steps.some(step => step.run?.includes(' sync ')));
});

test('workflow lint and both native platforms are covered on PRs before entering the release branch', () => {
  const ci = workflow('ci');
  assert.equal(ci.jobs['workflow-check'].uses, './.github/workflows/check-workflows.yml');
  assert.deepEqual(ci.jobs['native-test'].strategy.matrix.os, ['macos-15', 'windows-latest']);
});

test('release notes preflight runs only for PRs targeting release and is absent after merging', () => {
  const ci = workflow('ci');
  const steps = ci.jobs.test.steps;
  const index = steps.findIndex(step => step.name === 'Verify release PR notes');
  assert(index >= 0);
  const step = steps[index];
  assert(index < steps.findIndex(step => step.name === 'Install media test dependencies'));
  assert(index < steps.findIndex(step => step.name === 'Verify repository quality'));
  assert.match(step.run, /node scripts\/check-release-notes\.mjs "\$version" release-notes\.json/);
  const enabled = (event_name, base_ref) => Function('github', `return (${step.if});`)({ event_name, base_ref });
  assert.equal(enabled('pull_request', 'release'), true);
  assert.equal(enabled('pull_request', 'main'), false);
  assert.equal(enabled('push', ''), false);
  assert.equal(enabled('push', 'release'), false);
  assert.equal(enabled('workflow_dispatch', 'release'), false);
  assert.deepEqual(ci.on.pull_request.branches, ['main', 'release']);
  assert.deepEqual(ci.on.push.branches, ['main']);
  assert.equal(steps.find(step => step.name === 'Verify repository quality').run, 'node scripts/check-quality.mjs');
  for (const job of Object.values(release.jobs)) {
    for (const entry of job.steps || []) assert(!entry.run?.includes('check-release-notes.mjs'));
  }
});

test('build cache covers the installed projects and uses matching restore/save keys', () => {
  const build = release.jobs.build;
  const restore = build.steps.find(step => step.uses?.startsWith('actions/cache/restore@'));
  const save = build.steps.find(step => step.uses?.startsWith('actions/cache/save@'));
  assert.deepEqual(restore.with, save.with);
  const install = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).scripts['install:ci'];
  const projects = [...install.matchAll(/--prefix\s+(\S+)\s+ci/g)].map(match => match[1]);
  assert.deepEqual(restore.with.path.trim().split('\n').sort(), projects.map(project => `${project}/node_modules`).sort());
  for (const project of projects) assert(restore.with.key.includes(`${project}/package-lock.json`));
  assert(restore.with.key.includes('runner.os'));
  assert(restore.with.key.includes('node24'));
});

test('publication keeps direct AWS credentials and the resume input only where consumed', () => {
  const job = release.jobs.release;
  assert.equal(job.env.QINIU_AK, undefined);
  assert.equal(job.env.QINIU_SK, undefined);
  for (const step of job.steps.filter(step => / (publish|sync) /.test(step.run || ''))) {
    assert.equal(step.env.AWS_ACCESS_KEY_ID, '${{ secrets.QINIU_AK }}');
    assert.equal(step.env.AWS_SECRET_ACCESS_KEY, '${{ secrets.QINIU_SK }}');
  }
  assert.equal(release.jobs.prepare.steps.find(step => step.id === 'release').env.RESUME_VERSION, '${{ inputs.resume_version }}');
});
