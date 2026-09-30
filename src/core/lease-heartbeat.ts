/** Stop execution when lease ownership can no longer be confirmed. */
export function startLeaseHeartbeat(
  renew: () => boolean,
  controller: AbortController,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (controller.signal.aborted) {
      clearInterval(timer);
      return;
    }
    let renewed = false;
    try {
      renewed = renew();
    } catch {
      // A storage failure leaves ownership unconfirmed, just like a lost lease.
    }
    if (!renewed) {
      clearInterval(timer);
      controller.abort();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
