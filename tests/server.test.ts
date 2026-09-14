import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createLocalComposition } from '../shared/patterns.ts';
import { createApp } from '../server/app.ts';
import type { CodexComposer } from '../server/codex.ts';
import { TidalBridge } from '../server/tidal.ts';
import { BridgeError, parseComposition, parseLoop, parseProfile } from '../server/validation.ts';
import { runProcess } from '../server/process.ts';
import { GENRE_IDS, selectProfile } from '../shared/profiles.ts';
import { sampleFile } from '../server/samples.ts';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '../server/sessions.ts';

test('score validation regenerates code, rejects role mismatches and duplicate events', () => {
  const score = createLocalComposition(17);
  const loop = parseLoop({ ...score.loops[0], tidal: ':! touch /tmp/unsafe', source: 'codex' }, 'codex', undefined, score.bpm);
  assert.equal(loop.tidal, score.loops[0].tidal);
  assert.ok(!loop.tidal.includes('touch'));
  assert.throws(() => parseLoop({ ...loop, role: 'bass' }), BridgeError);
  assert.throws(() => parseLoop({ ...loop, events: [loop.events[0], loop.events[0]] }), BridgeError);
  assert.throws(() => parseLoop({ ...loop, gain: Infinity }), BridgeError);
  assert.throws(() => parseLoop({ ...loop, pan: '0; hush' }), BridgeError);
  assert.throws(() => parseLoop({ ...loop, events: [{ ...loop.events[0], step: 32 }] }), BridgeError);
  assert.throws(() => parseLoop({ ...loop, sound: 'bd:99999' }), BridgeError);
  assert.throws(() => parseLoop({ ...loop, sound: '../../etc/passwd' }), BridgeError);
  assert.equal(parseComposition(score).loops.length, 8);
  assert.throws(() => parseComposition({ ...score, loops: score.loops.slice(1) }), BridgeError);
  for (const genre of GENRE_IDS) {
    const profile = selectProfile(914, genre);
    assert.deepEqual(parseProfile(profile), profile);
    assert.throws(() => parseProfile({ ...profile, key: 'unrelated key' }), BridgeError);
    assert.throws(() => parseProfile({ ...profile, bpm: 999 }), BridgeError);
  }
});

test('local HTTP boundary protects OAuth endpoints and validates before native execution', async t => {
  const nativeCalls: unknown[] = [];
  const triggerCalls: unknown[] = [];
  const transitionCalls: unknown[] = [];
  const score = createLocalComposition(4);
  const composer = {
    status: async () => ({ available: true, authenticated: true, ready: true, authMethod: 'chatgpt', busy: false }),
    compose: async () => score,
    next: async () => score.loops[2],
  } as unknown as CodexComposer;
  const tidal = {
    status: async () => ({ enabled: false, available: false, running: false, superDirtAvailable: false, reason: 'disabled' }),
    play: async (loop: unknown) => { nativeCalls.push(loop); },
    trigger: async (loop: unknown) => { triggerCalls.push(loop); },
    transition: async (loops: unknown, bpm: number, durationSeconds: number) => {
      transitionCalls.push({ loops, bpm });
      return { startAt: 456, durationSeconds, cycle: 0 };
    },
    transport: async () => ({ startAt: 123, cycle: 0 }),
  } as unknown as TidalBridge;
  const { app } = createApp(composer, tidal);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  assert.equal((await fetch(base + '/api/status')).status, 200);
  assert.equal((await fetch(base + '/api/status', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(base + '/api/status', { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await post('/api/compose', {}, { Origin: 'http://localhost:5173.attacker.example' })).status, 403);
  assert.equal((await post('/api/compose', {}, { Origin: 'http://127.0.0.1:5173' })).status, 200);
  assert.equal((await fetch(base + '/api/compose', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await post('/api/compose', { seed: -1 })).status, 400);
  assert.equal((await post('/api/tidal/play', { loop: { ...score.loops[0], gain: 30 } })).status, 400);
  assert.equal(nativeCalls.length, 0);
  assert.equal((await post('/api/tidal/play', { loop: { ...score.loops[0], tidal: ':! arbitrary shell' }, bpm: score.bpm })).status, 200);
  assert.equal((nativeCalls[0] as { tidal: string }).tidal, score.loops[0].tidal);
  assert.equal((await post('/api/tidal/transport', { action: 'start', loops: score.loops.slice(0, 2) })).status, 400);
  const started = await post('/api/tidal/transport', { action: 'start', loops: score.loops });
  assert.equal(started.status, 200);
  assert.deepEqual(await started.json(), { ok: true, startAt: 123, cycle: 0 });
  assert.equal((await post('/api/compose', { genre: 'unknown-genre' })).status, 400);
  assert.equal((await post('/api/compose', { previous: { ...score, profile: { ...score.profile, key: 'invalid' } } })).status, 400);
  assert.equal((await post('/api/compose', { previous: score })).status, 200);
  assert.equal((await post('/api/next', { loops: score.loops, id: 2, profile: score.profile, bpm: score.bpm + 1 })).status, 400);
  assert.equal((await post('/api/next', { loops: score.loops, id: 2, profile: score.profile })).status, 200);
  assert.equal((await fetch(base + '/api/samples/bd/999')).status, 404);
  assert.equal((await fetch(base + '/api/samples/constructor/0')).status, 404);
  const actualSample = await fetch(base + '/api/samples/808bd/7');
  if (actualSample.status !== 404) {
    assert.equal(actualSample.status, 200);
    assert.equal(actualSample.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await actualSample.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
  }
  assert.equal((await post('/api/tidal/trigger', { loop: score.loops[0], bpm: score.bpm, velocity: 2 })).status, 400);
  const hits = await Promise.all(Array.from({ length: 3 }, () => post('/api/tidal/trigger', { loop: score.loops[0], bpm: score.bpm, velocity: 1 })));
  assert.ok(hits.every(response => response.status === 200));
  assert.equal(triggerCalls.length, 3);
  assert.equal((await post('/api/tidal/transition', { loops: score.loops.slice(0, 7), bpm: score.bpm })).status, 400);
  assert.equal((await post('/api/tidal/transition', { loops: score.loops, bpm: score.bpm, durationSeconds: 99 })).status, 400);
  const transition = await post('/api/tidal/transition', { loops: score.loops, bpm: score.bpm, durationSeconds: 4 });
  assert.equal(transition.status, 200);
  assert.deepEqual(await transition.json(), { ok: true, startAt: 456, durationSeconds: 4, cycle: 0 });
  assert.equal(transitionCalls.length, 1);
});

test('subprocess cancellation and output limits terminate generation', async () => {
  const controller = new AbortController();
  const waiting = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(waiting, (error: BridgeError) => error.code === 'CANCELLED');
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000));setInterval(() => {},1000)'], { maxBytes: 1000, timeoutMs: 5000 }), (error: BridgeError) => error.code === 'OUTPUT_LIMIT');
});

test('native API requires ChatGPT OAuth but always permits pause and reset after logout', async t => {
  const score = createLocalComposition(28);
  let authenticated = false;
  const freshness: boolean[] = [];
  const calls: string[] = [];
  const composer = {
    status: async (fresh: boolean) => {
      freshness.push(fresh);
      return { available: true, authenticated, ready: authenticated, authMethod: authenticated ? 'chatgpt' : 'none', action: 'Run npm run login.' };
    },
  } as unknown as CodexComposer;
  const tidal = {
    play: async () => { calls.push('play'); },
    trigger: async () => { calls.push('trigger'); },
    transition: async () => { calls.push('transition'); return {}; },
    transport: async (action: string) => { calls.push(action); return {}; },
    stop: async (action: string) => { calls.push(action); return {}; },
  } as unknown as TidalBridge;
  const { app } = createApp(composer, tidal);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const scoreInput = { loops: score.loops, bpm: score.bpm };
  for (const [path, input] of [
    ['tidal/play', { loop: score.loops[0], bpm: score.bpm }],
    ['tidal/trigger', { loop: score.loops[0], bpm: score.bpm }],
    ['tidal/transition', scoreInput],
    ['tidal/transport', { ...scoreInput, action: 'start' }],
    ['tidal/transport', { ...scoreInput, action: 'resume' }],
  ] as const) assert.equal((await post(path, input)).status, 503);
  assert.deepEqual(calls, []);
  assert.deepEqual(freshness, [false, false, true, true, true]);
  assert.equal((await post('tidal/transport', { action: 'pause' })).status, 200);
  assert.equal((await post('tidal/transport', { action: 'reset' })).status, 200);
  assert.deepEqual(calls, ['pause', 'reset']);
  assert.equal(freshness.length, 5, 'hush operations do not depend on an auth probe');
  authenticated = true;
  const hits = await Promise.all(Array.from({ length: 3 }, () => post('tidal/trigger', { loop: score.loops[0], bpm: score.bpm })));
  assert.ok(hits.every(response => response.status === 200));
  assert.deepEqual(calls.slice(2), ['trigger', 'trigger', 'trigger']);
  assert.deepEqual(freshness.slice(5), [false, false, false], 'rapid pad hits can reuse the short status cache');
  authenticated = false;
  assert.equal((await post('session/stop', { sessionId: randomUUID(), revision: 0, action: 'reset' })).status, 200);
});

test('a stop aborts a pending native OAuth check and a late successful probe cannot trigger audio', async t => {
  const score = createLocalComposition(29);
  let began!: () => void;
  let release!: () => void;
  let aborted!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const composer = {
    status: async (_fresh: boolean, signal: AbortSignal) => {
      signal.addEventListener('abort', aborted, { once: true });
      began();
      await released;
      return { ready: true, available: true, authenticated: true, authMethod: 'chatgpt' };
    },
  } as unknown as CodexComposer;
  let played = false;
  const tidal = {
    transport: async () => { played = true; return {}; },
    stop: async () => ({}),
  } as unknown as TidalBridge;
  const { app } = createApp(composer, tidal);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const sessionId = randomUUID();
  assert.equal((await post('session/claim', { sessionId, revision: 0, expectedEpoch: 0 })).status, 200);
  const playing = post('tidal/transport', { sessionId, revision: 0, action: 'start', loops: score.loops, bpm: score.bpm });
  await started;
  const stop = post('session/stop', { sessionId, revision: 1, action: 'pause' });
  await cancelled;
  release();
  assert.equal((await stop).status, 200);
  assert.ok([409, 499].includes((await playing).status));
  assert.equal(played, false);
});

test('sample lookup bounds indices and serves installed real WAV assets', async t => {
  await assert.rejects(sampleFile('../bd', '0'), BridgeError);
  await assert.rejects(sampleFile('bd', '-1'), BridgeError);
  await assert.rejects(sampleFile('bd', '999'), BridgeError);
  let file: string;
  try { file = await sampleFile('808bd', '7'); }
  catch { t.skip('Optional Dirt-Samples runtime is not installed.'); return; }
  const buffer = await readFile(file);
  assert.equal(buffer.subarray(0, 4).toString(), 'RIFF');
  assert.equal(buffer.subarray(8, 12).toString(), 'WAVE');
});

test('stop aborts a running subprocess and fences late HTTP work and previous tabs', async t => {
  const score = createLocalComposition(19);
  let generationStarted!: () => void;
  const began = new Promise<void>(resolve => { generationStarted = resolve; });
  let generationEnded = false;
  let stops = 0;
  let fullScore: boolean | undefined;
  const composer = {
    status: async () => ({ available: true, authenticated: true, ready: true, authMethod: 'chatgpt', busy: !generationEnded }),
    compose: async (_seed: number, _genre: string, signal: AbortSignal) => {
      generationStarted();
      try { await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal, timeoutMs: 5000 }); }
      finally { generationEnded = true; }
      return score;
    },
  } as unknown as CodexComposer;
  const tidal = {
    stop: async () => { stops += 1; return { cycle: 1.25 }; },
    transport: async (_action: string, _loops: unknown, _bpm: number, cycle: number, _signal: AbortSignal, full: boolean) => { fullScore = full; return { cycle }; },
  } as unknown as TidalBridge;
  const { app } = createApp(composer, tidal);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const epoch = async () => (await (await fetch(base + '/api/session')).json()).epoch as number;
  const sessionId = randomUUID();
  assert.equal((await post('/api/session/claim', { sessionId, revision: 0, expectedEpoch: await epoch() })).status, 200);
  const work = post('/api/compose', { sessionId, revision: 0, genre: 'dub' });
  await began;
  const stopped = await post('/api/session/stop', { sessionId, revision: 1, action: 'pause' });
  assert.equal(stopped.status, 200);
  assert.equal(generationEnded, true, 'stop acknowledgement waits for the killed composition subprocess');
  assert.ok([409, 499].includes((await work).status));
  assert.equal((await post('/api/compose', { sessionId, revision: 0 })).status, 409);
  assert.equal((await post('/api/compose', {})).status, 409);
  assert.equal((await post('/api/session/claim', { sessionId, revision: 0, expectedEpoch: await epoch() })).status, 409);
  assert.equal((await post('/api/session/claim', { sessionId, revision: 2, expectedEpoch: await epoch() })).status, 200);
  assert.equal((await post('/api/tidal/transport', { sessionId, revision: 2, action: 'resume', loops: score.loops, bpm: score.bpm, cycle: 1.25, fullScore: true })).status, 200);
  assert.equal(fullScore, true);
  const oldEpoch = await epoch();
  const nextSessionId = randomUUID();
  assert.equal((await post('/api/session/claim', { sessionId: nextSessionId, revision: 0, expectedEpoch: oldEpoch })).status, 200);
  const beforeOldStop = stops;
  assert.equal((await post('/api/session/stop', { sessionId, revision: 3, action: 'reset' })).status, 409);
  assert.equal(stops, beforeOldStop, 'an old tab cannot silence the new owner');
  assert.equal((await post('/api/session/claim', { sessionId, revision: 3, expectedEpoch: oldEpoch })).status, 409);
  assert.equal((await post('/api/tidal/transport', { sessionId, revision: 2, action: 'resume', loops: score.loops })).status, 409);
});

test('a stop that overtakes a claim prevents the delayed claim from activating', async () => {
  const sessions = new SessionManager();
  const sessionId = randomUUID();
  await sessions.stop({ sessionId, revision: 1 }, async () => ({ cycle: 0 }));
  await assert.rejects(sessions.claim({ sessionId, revision: 0, expectedEpoch: 0 }, async () => {}), (error: BridgeError) => error.code === 'STALE_SESSION');
  let release!: () => void;
  const claimed = sessions.claim({ sessionId, revision: 2, expectedEpoch: 1 }, () => new Promise<void>(resolve => { release = resolve; }));
  let ran = false;
  const pending = sessions.run({ sessionId, revision: 2 }, new AbortController().signal, async () => { ran = true; });
  const stopped = sessions.stop({ sessionId, revision: 3 }, async () => ({ cycle: 0 }));
  const claimRejected = assert.rejects(claimed, (error: BridgeError) => error.code === 'STALE_SESSION');
  const workRejected = assert.rejects(pending, (error: BridgeError) => error.code === 'STALE_SESSION');
  release();
  await Promise.all([claimRejected, workRejected, stopped]);
  assert.equal(ran, false);
});

test('native priority stop invalidates queued patterns and an in-flight hit check', async () => {
  const tidal = new TidalBridge();
  const internals = tidal as unknown as { enabled: boolean; operationQueue: Promise<unknown>; execute: () => Promise<void> };
  internals.enabled = false;
  let release!: () => void;
  internals.operationQueue = new Promise<void>(resolve => { release = resolve; });
  let executed = false;
  internals.execute = async () => { executed = true; };
  const score = createLocalComposition(20);
  const play = tidal.play(score.loops[0], score.bpm);
  const transition = tidal.transition(score.loops, score.bpm);
  const hit = tidal.trigger(score.loops[0], score.bpm);
  const errors = [play, transition, hit].map(task => assert.rejects(task, (error: BridgeError) => error.code === 'STALE_SESSION'));
  const stop = tidal.stop('reset');
  release();
  await Promise.all([stop, ...errors]);
  assert.equal(executed, false);
});
