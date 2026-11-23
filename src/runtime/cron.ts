import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '../core/types.js';
import type { EventStore } from '../storage/event-store.js';
import { planState } from './plan.js';

export function cronPlan(events: SessionEvent[], planSeq: number) {
  const revision = [...events].reverse().find((event) => event.type === 'plan_updated')?.seq;
  const plan = planState(events);
  return revision === planSeq && plan.enabled && plan.approved && plan.steps.length
    ? plan
    : undefined;
}

function latestDispatches(events: SessionEvent[]): Map<string, SessionEvent> {
  const dispatches = new Map<string, SessionEvent>();
  for (const event of events)
    if (event.type === 'cron_started' && typeof event.payload.jobId === 'string')
      dispatches.set(event.payload.jobId, event);
  return dispatches;
}

export function recoverCronJobs(store: EventStore, now = Date.now()): void {
  for (const session of store.listSessions()) {
    if (store.isLeased(session.id)) continue;
    const dispatched = store
      .listCronJobs(session.id)
      .filter((job) => job.lastStatus === 'dispatched');
    if (!dispatched.length) continue;
    const observed = latestDispatches(store.events(session.id));
    const abandoned = dispatched.filter((job) => {
      const started = observed.get(job.id);
      return !started || now - Date.parse(started.at) >= 30_000;
    });
    if (!abandoned.length) continue;
    const owner = randomUUID();
    try {
      store.acquireLease(session.id, owner, 10_000);
    } catch (error) {
      if (store.isLeased(session.id) || !store.getSession(session.id)) continue;
      throw error;
    }
    try {
      const current = store.listCronJobs(session.id);
      const latest = latestDispatches(store.events(session.id));
      for (const job of abandoned)
        if (
          current.find((item) => item.id === job.id)?.lastStatus === 'dispatched' &&
          latest.get(job.id)?.seq === observed.get(job.id)?.seq
        )
          store.markCronJob(job.id, 'needs_review');
    } finally {
      store.releaseLease(session.id, owner);
    }
  }
}
