import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectInstallation, installationKind } from '../src/client/update-guidance.js';

test('classifies installation source without modifying it', () => {
  for (const source of ['link:/tmp/dev', 'file:../dev', '/tmp/dev', 'C:\\dev\\plugin']) assert.equal(installationKind({ source }), 'local');
  for (const source of ['github:owner/repo', 'git+https://example.com/repo', 'https://example.com/repo.tgz']) assert.equal(installationKind({ source }), 'git');
  for (const source of ['dsh-ssh-ops@0.4.3', '^0.4.3']) assert.equal(installationKind({ source }), 'registry');
  assert.equal(installationKind({ source: 'npm:other@1.0.0' }), 'unknown');
  assert.equal(installationKind(null), 'unknown');
});

test('reads the installed bundle and treats missing or inaccessible inventory as unknown', async () => {
  assert.equal(await inspectInstallation({ listBundles: async () => [{ name: 'other', installed: true, source: 'link:/tmp/a' }, { name: 'dsh-ssh-ops', installed: true, source: 'link:/tmp/project' }] }), 'local');
  assert.equal(await inspectInstallation({ listBundles: async () => { throw new Error('unavailable'); } }), 'unknown');
  assert.equal(await inspectInstallation({}), 'unknown');
});
