import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import type { LocalDealsSnapshot } from '../local-deals';

// Shared by both refresh entry points. Do not reap a lock automatically: a long
// source request is not proof that its writer has stopped. A crashed worker's
// lock requires checking its PID before manual removal.
export async function withLocalSnapshotLock<T>(
  snapshotPath: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockPath = `${snapshotPath}.lock`;
  const token = randomUUID();
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Another refresh owns ${lockPath}. If its worker crashed, verify it has stopped before removing the lock.`,
      );
    throw error;
  }
  const content = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
    token,
  });
  try {
    await lock.writeFile(content, 'utf8');
    return await task();
  } finally {
    await lock.close();
    // Never remove a successor's lock if an operator replaced this one.
    if ((await readFile(lockPath, 'utf8').catch(() => null)) === content)
      await unlink(lockPath);
  }
}

export async function writeLocalSnapshotAtomically(
  snapshotPath: string,
  snapshot: LocalDealsSnapshot,
) {
  const temporaryPath = `${snapshotPath}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, 'wx');
  try {
    try {
      await file.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // Same-directory replacement: readers see the old complete file or the new
    // complete file. A failed rename leaves the original snapshot untouched.
    await rename(temporaryPath, snapshotPath);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
