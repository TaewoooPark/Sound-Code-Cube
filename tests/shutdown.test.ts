import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SessionManager } from '../server/sessions.ts';
import { runProcess } from '../server/process.ts';

test('server shutdown cancels a detached composer and rejects new claims', async () => {
  const sessions = new SessionManager();
  const owner = { sessionId: randomUUID(), revision: 1 };
  await sessions.claim({ ...owner, expectedEpoch: 0 }, async () => {});
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const generation = sessions.run(owner, new AbortController().signal, signal => {
    entered();
    return runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal, timeoutMs: 30000 });
  });
  const rejected = assert.rejects(generation, { code: 'CANCELLED' });
  await started;
  await sessions.close();
  await rejected;
  await assert.rejects(sessions.claim({ sessionId: randomUUID(), revision: 1, expectedEpoch: sessions.snapshot().epoch }, async () => {}), { code: 'STALE_SESSION' });
  await assert.rejects(sessions.run({}, new AbortController().signal, async () => true), { code: 'STALE_SESSION' });
});
