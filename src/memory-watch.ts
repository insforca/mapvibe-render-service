/* ── Memory observability — in-process high-water mark + current RSS ─────────
 *
 * WHY THIS EXISTS (2026-09-02):
 *
 * The 100×150 cm QA render died with `Input image exceeds pixel limit` after
 * RSS climbed from ~0.15 GB to ~2.65 GB on a 4 GB box. That number was only
 * ever captured by luck — sparse external samples taken AFTER the render had
 * already finished measure idle, not peak. A ~20-second render's peak is
 * invisible to a minute-granularity platform metric and can be missed by any
 * external poller.
 *
 * So the process measures itself. Two numbers, because peak and leak are
 * different failure modes and one number cannot separate them:
 *
 *   peak    — high-water mark of RSS, never decreases (until explicitly reset).
 *             Answers "how close did we come to the ceiling?"
 *   current — RSS right now. Answers "did the memory come back after the
 *             render finished, or is it still held?"
 *
 * The 2.65 GB observation "never returned to baseline three minutes later" was
 * destroyed by a service restart before anyone could confirm it. `current`
 * alongside `peak` makes that observable on the next render rather than
 * requiring someone to catch it in a window before a restart wipes it.
 *
 * HONEST LIMIT — process.memoryUsage() is a point-in-time syscall, so this is
 * still SAMPLING, not a continuous kernel watermark. What it guarantees is a
 * fixed short interval from inside the process (default 250 ms), which cannot
 * miss a multi-second allocation plateau the way an external poller can. It
 * can still under-report a sub-interval allocation spike. Reported as
 * `sampleIntervalMs` so a reader can judge the resolution rather than trust
 * the number blindly.
 *
 * OBSERVABILITY ONLY — nothing here changes render behaviour, admission, or
 * output. It samples and reports.
 * ──────────────────────────────────────────────────────────────────────────── */

const BYTES_PER_MB = 1024 * 1024;

/** Sampling interval while at least one render is in flight. */
export const SAMPLE_INTERVAL_MS = parseInt(
  process.env.MEMORY_SAMPLE_INTERVAL_MS ?? '250',
  10,
) || 250;

export interface MemorySnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  at: number;
}

export interface PeakRecord {
  /** High-water RSS in bytes since `since`. */
  rssBytes: number;
  /** Heap used at the moment RSS peaked (not the heap maximum). */
  heapUsedBytes: number;
  /** Wall clock of the peak sample. */
  at: number;
  /** Label of the render in flight when the peak was recorded, if any. */
  label: string | null;
}

function readNow(): MemorySnapshot {
  const m = process.memoryUsage();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    externalBytes: m.external,
    at: Date.now(),
  };
}

function toMb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

/**
 * Tracks a process-lifetime RSS high-water mark, sampling fast while renders
 * are active and lazily (on read) while idle.
 */
export class MemoryWatch {
  private peak: PeakRecord;
  private readonly startedAt: number;
  private timer: NodeJS.Timeout | null = null;
  /** Refcount of in-flight tracked renders — sampling runs while > 0. */
  private active = 0;
  private activeLabel: string | null = null;
  private samples = 0;
  /** Per-render baseline/peak, so a single render's cost is attributable. */
  private lastRender: {
    label: string;
    baselineRssBytes: number;
    peakRssBytes: number;
    endRssBytes: number | null;
    startedAt: number;
    durationMs: number | null;
  } | null = null;

  constructor(private readonly intervalMs: number = SAMPLE_INTERVAL_MS) {
    const now = readNow();
    this.startedAt = now.at;
    this.peak = {
      rssBytes: now.rssBytes,
      heapUsedBytes: now.heapUsedBytes,
      at: now.at,
      label: null,
    };
    this.samples = 1;
  }

  /** Take one sample and fold it into the high-water mark. */
  sample(): MemorySnapshot {
    const now = readNow();
    this.samples += 1;
    if (now.rssBytes > this.peak.rssBytes) {
      this.peak = {
        rssBytes: now.rssBytes,
        heapUsedBytes: now.heapUsedBytes,
        at: now.at,
        label: this.activeLabel,
      };
    }
    if (this.lastRender && now.rssBytes > this.lastRender.peakRssBytes) {
      this.lastRender.peakRssBytes = now.rssBytes;
    }
    return now;
  }

  /**
   * Wrap a render so RSS is sampled at `intervalMs` for its whole duration.
   * Observability only — the callback's result and thrown errors pass through
   * untouched, and a sampling failure must never fail a render.
   */
  async track<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const baseline = this.sample();
    this.active += 1;
    this.activeLabel = label;
    this.lastRender = {
      label,
      baselineRssBytes: baseline.rssBytes,
      peakRssBytes: baseline.rssBytes,
      endRssBytes: null,
      startedAt: baseline.at,
      durationMs: null,
    };
    this.startTimer();
    try {
      return await fn();
    } finally {
      const end = this.sample();
      this.active -= 1;
      if (this.active <= 0) {
        this.active = 0;
        this.activeLabel = null;
        this.stopTimer();
      }
      if (this.lastRender && this.lastRender.label === label) {
        this.lastRender.endRssBytes = end.rssBytes;
        this.lastRender.durationMs = end.at - this.lastRender.startedAt;
        const r = this.lastRender;
        console.log(
          `[memory] ${label}: baseline ${toMb(r.baselineRssBytes)} MB → peak ` +
            `${toMb(r.peakRssBytes)} MB → end ${toMb(end.rssBytes)} MB ` +
            `(delta held ${toMb(end.rssBytes - r.baselineRssBytes)} MB, ` +
            `${r.durationMs} ms, ${this.intervalMs} ms sampling)`,
        );
      }
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sample();
      } catch {
        /* observability must never break a render */
      }
    }, this.intervalMs);
    // Do not hold the event loop open on shutdown.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** True while at least one tracked render is in flight. */
  get sampling(): boolean {
    return this.active > 0;
  }

  /**
   * Report for /health. Samples on read so `current` is fresh even when idle.
   */
  report() {
    const now = this.sample();
    const r = this.lastRender;
    return {
      current: {
        rssMb: toMb(now.rssBytes),
        heapUsedMb: toMb(now.heapUsedBytes),
        externalMb: toMb(now.externalBytes),
      },
      peak: {
        rssMb: toMb(this.peak.rssBytes),
        heapUsedMb: toMb(this.peak.heapUsedBytes),
        atIso: new Date(this.peak.at).toISOString(),
        duringRender: this.peak.label,
      },
      /** Peak is a high-water mark since this instant, not a rolling window. */
      sinceIso: new Date(this.startedAt).toISOString(),
      sampling: this.sampling,
      sampleIntervalMs: this.intervalMs,
      samples: this.samples,
      lastRender: r
        ? {
            label: r.label,
            baselineRssMb: toMb(r.baselineRssBytes),
            peakRssMb: toMb(r.peakRssBytes),
            endRssMb: r.endRssBytes === null ? null : toMb(r.endRssBytes),
            /** end − baseline: memory still held after the render returned. */
            heldAfterMb:
              r.endRssBytes === null ? null : toMb(r.endRssBytes - r.baselineRssBytes),
            durationMs: r.durationMs,
            startedAtIso: new Date(r.startedAt).toISOString(),
          }
        : null,
    };
  }
}

/** Process-wide instance — one high-water mark per service process. */
export const memoryWatch = new MemoryWatch();
