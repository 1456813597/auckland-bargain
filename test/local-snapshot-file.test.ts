/* oxlint-disable typescript/no-floating-promises -- node:test registration is intentionally not awaited. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  withLocalSnapshotLock,
  writeLocalSnapshotAtomically,
} from '../lib/collection/local-snapshot-file';

test('local snapshot writer excludes another refresh and releases its lock on failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bargain-lock-test-'));
  const file = path.join(directory, 'deals.json');
  try {
    await assert.rejects(
      withLocalSnapshotLock(file, async () => {
        const lock = JSON.parse(await readFile(`${file}.lock`, 'utf8')) as {
          pid: number;
        };
        assert.equal(lock.pid, process.pid);
        await assert.rejects(
          withLocalSnapshotLock(file, async () => undefined),
          /Another refresh owns/,
        );
        throw new Error('Source failed');
      }),
      /Source failed/,
    );
    assert.deepEqual(await readdir(directory), []);
    assert.equal(
      await withLocalSnapshotLock(file, async () => 'next worker'),
      'next worker',
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('atomic local writes replace only the snapshot and clean up their own temporary file', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'bargain-snapshot-test-'),
  );
  const file = path.join(directory, 'deals.json');
  try {
    await writeFile(file, 'original');
    const next = {
      schemaVersion: 1 as const,
      generatedAt: null,
      retailers: [],
      deals: [],
    };
    await withLocalSnapshotLock(file, async () => {
      await writeLocalSnapshotAtomically(file, next);
    });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next);
    assert.deepEqual(await readdir(directory), ['deals.json']);
    await assert.rejects(writeLocalSnapshotAtomically(directory, next));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), next);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('a replaced lock is not removed by its former owner', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'bargain-lock-owner-test-'),
  );
  const file = path.join(directory, 'deals.json');
  try {
    await withLocalSnapshotLock(file, async () => {
      await writeFile(`${file}.lock`, 'operator replacement');
    });
    assert.equal(
      await readFile(`${file}.lock`, 'utf8'),
      'operator replacement',
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
