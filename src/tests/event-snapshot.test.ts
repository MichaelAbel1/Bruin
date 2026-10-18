import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsEventSnapshot } from '../core/event-snapshot.js';

test('live events outrank late queue receipts and snapshots from another session', () => {
  const view = { session: { id: 'current' }, events: [{ seq: 1 }, { seq: 8 }, { seq: 10 }] };
  assert.equal(acceptsEventSnapshot(view, 'current', [{ seq: 1 }, { seq: 8 }]), false);
  assert.equal(acceptsEventSnapshot(view, 'other', [{ seq: 20 }]), false);
  assert.equal(acceptsEventSnapshot(null, 'current', [{ seq: 20 }]), false);
  assert.equal(acceptsEventSnapshot(view, 'current', [{ seq: 10 }]), true);
  assert.equal(acceptsEventSnapshot(view, 'current', [{ seq: 10 }, { seq: 11 }]), true);
});

test('optimistic UI entries do not change the durable event watermark', () => {
  const view = { session: { id: 'current' }, events: [{ seq: 8 }, { seq: -123456 }] };
  assert.equal(acceptsEventSnapshot(view, 'current', [{ seq: 9 }]), true);
  assert.equal(acceptsEventSnapshot(view, 'current', [{ seq: 7 }]), false);
  assert.equal(acceptsEventSnapshot(view, 'current', []), false);
  assert.equal(acceptsEventSnapshot({ session: { id: 'new' }, events: [] }, 'new', []), true);
});
