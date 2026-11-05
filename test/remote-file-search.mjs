import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchRemoteFiles } from '../src/client/remote-file-search.js';

test('search stays under root, skips symlinks and reports unreadable directories', async () => {
  const seen = [];
  const dirs = { '/root': [ { name: 'sub', isDirectory: true, mode: 0o040000 }, { name: 'link', isDirectory: true, mode: 0o120000 }, { name: '..', isDirectory: true }, { name: 'Error.log', isDirectory: false } ], '/root/sub': [{ name: 'error.txt', isDirectory: false }, { name: 'private', isDirectory: true, mode: 0o040000 }] };
  const result = await searchRemoteFiles(async (path) => { seen.push(path); if (!dirs[path]) throw new Error('denied'); return { entries: dirs[path] }; }, '/root', 'error');
  assert.deepEqual(result.results.map((item) => item.path), ['/root/Error.log', '/root/sub/error.txt']);
  assert.deepEqual(seen, ['/root', '/root/sub', '/root/sub/private']);
  assert.equal(result.errors.length, 1);
});

test('search stops on bounds, timeout and cancellation', async () => {
  const listing = async () => ({ entries: Array.from({ length: 10 }, (_, n) => ({ name: `dir${n}`, isDirectory: true, mode: 0o040000 })) });
  const limited = await searchRemoteFiles(listing, '/', 'missing', { maxDirectories: 2 });
  assert.equal(limited.visited, 2);
  assert.equal(limited.reason, 'limit');
  const hanging = () => new Promise(() => {});
  assert.equal((await searchRemoteFiles(hanging, '/', 'x', { timeoutMs: 10 })).reason, 'timeout');
  const controller = new AbortController();
  const pending = searchRemoteFiles(hanging, '/', 'x', { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).reason, 'cancelled');
});
