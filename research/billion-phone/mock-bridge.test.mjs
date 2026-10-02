import test from 'node:test';
import assert from 'node:assert/strict';
import { MockBridge } from './mock-bridge.mjs';

function fixture() {
  let time = 1000;
  const inbox = [];
  const bridge = new MockBridge({ submit(request) {
    return new Promise((resolve, reject) => inbox.push({ request, resolve, reject }));
  } }, () => time);
  const grant = (callId) => ({ callId, owner: 'mock-owner', session: 'mock-billion', expires: 301000 });
  const open = (id = 'call-a') => bridge.open(id, grant(id));
  const reply = (i = 0, overrides = {}) => {
    const { request, resolve } = inbox[i];
    resolve({ requestId: request.requestId, callId: request.callId,
      sessionId: request.sessionId, text: 'Mock Billion: your simulated job is queued.', ...overrides });
  };
  return { bridge, inbox, grant, open, reply, advance: n => { time += n; } };
}

test('one simulated call carries a turn and receives the correlated mock reply', async () => {
  const f = fixture(); f.open();
  const pending = f.bridge.turn('call-a', 1, 'What is my simulated job status?');
  await Promise.resolve();
  assert.equal(f.inbox[0].request.sessionId, 'mock-billion');
  assert.equal(f.inbox[0].request.approvals, 'existing-app');
  f.reply();
  assert.deepEqual(await pending, { callId: 'call-a', response_id: 1,
    content: 'Mock Billion: your simulated job is queued.', content_complete: true });
});

test('unauthenticated / caller-ID-only input never reaches the inbox', () => {
  const f = fixture();
  assert.throws(() => f.bridge.open('call-a', { callerId: '+15555550100' }), /unauthenticated/);
  assert.throws(() => f.bridge.turn('call-a', 1, 'Do something'), /unknown/);
  assert.equal(f.inbox.length, 0);
});

test('grant replay, wrong binding and expiration are refused', () => {
  const f = fixture(); const grant = f.grant('call-a');
  assert.throws(() => f.bridge.open('call-b', grant), /unauthenticated/);
  f.bridge.open('call-a', grant);
  assert.throws(() => f.bridge.open('call-a', grant), /already/);
  const used = { ...f.grant('call-b'), used: true };
  assert.throws(() => f.bridge.open('call-b', used), /unauthenticated/);
  f.advance(300000);
  assert.throws(() => f.bridge.open('call-c', f.grant('call-c')), /unauthenticated/);
});

test('duplicate delivery shares one pending request; changed payload is refused', async () => {
  const f = fixture(); f.open();
  const first = f.bridge.turn('call-a', 1, 'Check job');
  assert.equal(f.bridge.turn('call-a', 1, 'Check job'), first);
  assert.throws(() => f.bridge.turn('call-a', 1, 'Delete job'), /conflict/);
  await Promise.resolve(); assert.equal(f.inbox.length, 1);
  f.reply(); await first;
  assert.equal(f.bridge.turn('call-a', 1, 'Check job'), first);
});

test('disconnect aborts interest, suppresses late reply and forbids reuse', async () => {
  const f = fixture(); f.open();
  const pending = f.bridge.turn('call-a', 1, 'Check job'); await Promise.resolve();
  f.bridge.close('call-a'); f.bridge.close('call-a');
  assert.equal(f.inbox[0].request.signal.aborted, true);
  f.reply(); assert.equal(await pending, null);
  assert.throws(() => f.bridge.turn('call-a', 2, 'Another'), /closed/);
});

test('disconnect before dispatch delivers nothing', async () => {
  const f = fixture(); f.open();
  const pending = f.bridge.turn('call-a', 1, 'Check job'); f.bridge.close('call-a');
  await assert.rejects(pending, /closed/); assert.equal(f.inbox.length, 0);
});

test('timeout suppresses a late reply and refuses subsequent work', async () => {
  const f = fixture(); f.open();
  const pending = f.bridge.turn('call-a', 1, 'Check job'); await Promise.resolve();
  f.advance(300000); f.reply(); assert.equal(await pending, null);
  assert.throws(() => f.bridge.turn('call-a', 2, 'Check again'), /expired/);
});

test('cross-call and cross-session replies fail closed', async () => {
  for (const overrides of [{ callId: 'other-call' }, { sessionId: 'other-session' }, { requestId: 'other-turn' }]) {
    const f = fixture(); f.open();
    const pending = f.bridge.turn('call-a', 1, 'Check job'); await Promise.resolve();
    f.reply(0, overrides); await assert.rejects(pending, /correlation/);
  }
});

test('barge-in suppresses stale speech while preserving dispatched action identity', async () => {
  const f = fixture(); f.open();
  const first = f.bridge.turn('call-a', 1, 'Check job'); await Promise.resolve();
  f.bridge.interrupt('call-a'); f.reply(); assert.equal(await first, null);
  const second = f.bridge.turn('call-a', 2, 'Tell me briefly'); await Promise.resolve();
  f.reply(1); assert.equal((await second).response_id, 2);
  assert.equal(f.inbox.length, 2);
});

test('ambiguous adapter failure is cached, never automatically retried', async () => {
  const f = fixture(); f.open();
  const first = f.bridge.turn('call-a', 1, 'Check job'); await Promise.resolve();
  f.inbox[0].reject(new Error('unknown delivery status'));
  await assert.rejects(first, /unknown delivery/);
  await assert.rejects(f.bridge.turn('call-a', 1, 'Check job'), /unknown delivery/);
  assert.equal(f.inbox.length, 1);
});

test('two calls with equal turn numbers keep independent replies', async () => {
  const f = fixture(); f.open('call-a'); f.open('call-b');
  const a = f.bridge.turn('call-a', 1, 'A');
  const b = f.bridge.turn('call-b', 1, 'B');
  await Promise.resolve();
  f.reply(1, { text: 'B reply' }); f.reply(0, { text: 'A reply' });
  assert.equal((await a).content, 'A reply'); assert.equal((await b).content, 'B reply');
});

test('interruption never resets the stale-turn watermark', async () => {
  const f = fixture(); f.open();
  const pending = f.bridge.turn('call-a', 3, 'Current'); await Promise.resolve();
  f.bridge.interrupt('call-a');
  assert.throws(() => f.bridge.turn('call-a', 2, 'Old'), /stale/);
  f.reply(); await pending;
});
