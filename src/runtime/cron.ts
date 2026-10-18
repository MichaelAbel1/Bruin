import { randomUUID } from 'node:crypto';
import type { EventStore } from '../storage/event-store.js';

export function recoverCronJobs(store: EventStore, now = Date.now()): void {
  for (const session of store.listSessions()) {
    if (store.isLeased(session.id)) continue;
    const abandoned = store.listCronJobs(session.id).filter((job) => {
      if (job.lastStatus !== 'dispatched') return false;
      const started = [...store.events(session.id)]
        .reverse()
        .find((event) => event.type === 'cron_started' && event.payload.jobId === job.id);
      return !started || now - Date.parse(started.at) >= 30_000;
    });
    if (!abandoned.length) continue;
    const owner = randomUUID();
    store.acquireLease(session.id, owner, 10_000);
    try {
      const current = store.listCronJobs(session.id);
      for (const job of abandoned)
        if (current.find((item) => item.id === job.id)?.lastStatus === 'dispatched')
          store.markCronJob(job.id, 'needs_review');
    } finally {
      store.releaseLease(session.id, owner);
    }
  }
}
