// RESEARCH ONLY: no network, runtime imports, credentials, audio or real session.
// The adapter is a proposed contract, NOT an existing Agent007 API.
export class MockBridge {
  constructor(adapter, now = () => Date.now()) {
    this.adapter = adapter;
    this.now = now;
    this.calls = new Map();
  }

  // grant stands in for an app-verified, call-bound, one-use capability.
  // This deliberately does not implement authentication or accept caller ID.
  open(callId, grant) {
    if (this.calls.has(callId)) throw new Error('call already seen');
    if (!grant || grant.callId !== callId || grant.used || grant.expires <= this.now()
        || grant.owner !== 'mock-owner' || grant.session !== 'mock-billion') {
      throw new Error('unauthenticated');
    }
    grant.used = true;
    this.calls.set(callId, { session: grant.session, deadline: Math.min(grant.expires,
      this.now() + 300_000), closed: false, turns: new Map(), latest: null, highWater: 0 });
  }

  active(callId) {
    const call = this.calls.get(callId);
    if (!call || call.closed) throw new Error('closed or unknown call');
    if (this.now() >= call.deadline) {
      this.close(callId);
      throw new Error('call expired');
    }
    return call;
  }

  turn(callId, turnId, text) {
    const call = this.active(callId);
    if (!Number.isSafeInteger(turnId) || turnId < 1 || typeof text !== 'string'
        || !text.trim() || text.length > 4000) throw new Error('invalid turn');
    const previous = call.turns.get(turnId);
    if (previous) {
      if (previous.text !== text) throw new Error('duplicate conflict');
      return previous.promise;
    }
    if (turnId <= call.highWater) throw new Error('stale turn');
    if (call.turns.size >= 20) throw new Error('turn limit');
    call.latest = turnId;
    call.highWater = turnId;
    const requestId = `${callId}:${turnId}`;
    const controller = new AbortController();
    const record = { text, controller };
    // Cache before delivery, including failures: ambiguous failures must not retry actions.
    call.turns.set(turnId, record);
    record.promise = Promise.resolve().then(() => {
      this.active(callId);
      return this.adapter.submit({ callId, turnId, requestId, sessionId: call.session,
        text, authority: 'owner-conversation', approvals: 'existing-app', signal: controller.signal });
    }).then(reply => {
      if (call.closed || this.now() >= call.deadline || call.latest !== turnId) return null;
      if (reply.requestId !== requestId || reply.sessionId !== call.session
          || reply.callId !== callId || typeof reply.text !== 'string') {
        throw new Error('reply correlation mismatch');
      }
      return { callId, response_id: turnId, content: reply.text, content_complete: true };
    });
    return record.promise;
  }

  interrupt(callId) {
    this.active(callId).latest = null; // suppress speech; does NOT undo dispatched work
  }

  close(callId) {
    const call = this.calls.get(callId);
    if (!call || call.closed) return;
    call.closed = true;
    for (const turn of call.turns.values()) turn.controller.abort();
  }
}
