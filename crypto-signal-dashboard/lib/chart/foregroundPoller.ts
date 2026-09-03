/** UI-only polling. Never used to schedule the autonomous trading monitor. */
export function createForegroundPoller(options: {
  load: (signal: AbortSignal) => Promise<void>;
  intervalMs: number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let active = false;
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const stop = () => {
    generation++;
    if (timer !== null) cancel(timer);
    timer = null;
    controller?.abort();
    controller = null;
  };
  const run = async () => {
    if (!active || disposed) return;
    const currentGeneration = generation;
    controller = new AbortController();
    try { await options.load(controller.signal); } catch { /* The view owns error presentation. */ }
    finally {
      if (currentGeneration === generation && active && !disposed) {
        controller = null;
        timer = schedule(() => { timer = null; void run(); }, options.intervalMs);
      }
    }
  };
  return {
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      stop();
      if (active) void run();
    },
    dispose() { disposed = true; active = false; stop(); },
  };
}
