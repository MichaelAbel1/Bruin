import { randomUUID } from 'node:crypto';
import type { EventStore } from '../storage/event-store.js';
import { startLeaseHeartbeat } from './lease-heartbeat.js';

type HeldLease = {
  owner: string;
  controller: AbortController;
  heartbeat: ReturnType<typeof setInterval>;
  holders: Map<symbol, AbortController>;
};

/** One SQLite owner per local session, retained until all its work has settled. */
export class SessionLeases {
  private held = new Map<string, HeldLease>();
  constructor(private store: Pick<EventStore, 'acquireLease' | 'renewLease' | 'releaseLease'>) {}

  retain(id: string, controller: AbortController): { owner: string; release(): void } {
    if (controller.signal.aborted) throw new Error('已取消');
    let entry = this.held.get(id);
    if (entry?.controller.signal.aborted)
      throw new Error('此会话租约已失效，等待当前任务退出后再继续');
    const owner = entry?.owner ?? randomUUID();
    // Recheck SQLite ownership even when another local task still holds the lease.
    try {
      this.store.acquireLease(id, owner, 30_000);
    } catch (error) {
      entry?.controller.abort();
      throw error;
    }
    if (!entry) {
      const leaseController = new AbortController();
      const holders = new Map<symbol, AbortController>();
      leaseController.signal.addEventListener(
        'abort',
        () => {
          for (const holder of holders.values()) holder.abort();
        },
        { once: true },
      );
      entry = {
        owner,
        controller: leaseController,
        heartbeat: startLeaseHeartbeat(
          () => this.store.renewLease(id, owner, 30_000),
          leaseController,
          10_000,
        ),
        holders,
      };
      this.held.set(id, entry);
    }
    const lease = entry;
    const token = Symbol();
    lease.holders.set(token, controller);
    return {
      owner,
      release: () => {
        if (!lease.holders.delete(token) || lease.holders.size) return;
        clearInterval(lease.heartbeat);
        this.held.delete(id);
        this.store.releaseLease(id, owner);
      },
    };
  }
}
