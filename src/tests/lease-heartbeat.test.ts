import test from 'node:test';
import assert from 'node:assert/strict';
import { startLeaseHeartbeat } from '../core/lease-heartbeat.js';

for (const failure of ['lost', 'storage-error'] as const) {
  test(`lease heartbeat cancels and stops renewing after ${failure}`, (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const controller = new AbortController();
    let calls = 0;
    const timer = startLeaseHeartbeat(
      () => {
        calls++;
        if (calls === 1) return true;
        if (failure === 'storage-error') throw new Error('SQLITE_BUSY');
        return false;
      },
      controller,
      10_000,
    );
    try {
      t.mock.timers.tick(10_000);
      assert.equal(controller.signal.aborted, false);
      t.mock.timers.tick(10_000);
      assert.equal(controller.signal.aborted, true);
      t.mock.timers.tick(60_000);
      assert.equal(calls, 2);
    } finally {
      clearInterval(timer);
    }
  });
}

test('lease heartbeat does not access storage after cancellation or cleanup', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const cleanup of ['cancel', 'clear'] as const) {
    const controller = new AbortController();
    let calls = 0;
    const timer = startLeaseHeartbeat(
      () => {
        calls++;
        return true;
      },
      controller,
      1000,
    );
    if (cleanup === 'cancel') controller.abort();
    else clearInterval(timer);
    t.mock.timers.tick(10_000);
    assert.equal(calls, 0);
    clearInterval(timer);
  }
});
