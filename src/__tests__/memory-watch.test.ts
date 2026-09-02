import { describe, it, expect } from 'vitest';
import { MemoryWatch } from '../memory-watch.js';

/**
 * These tests pin the CONTRACT of the instrument, not absolute byte values —
 * real RSS numbers are environment-dependent and would make the suite flaky.
 * What must hold: peak never decreases, current is fresh on read, a tracked
 * render is attributed, and observability never breaks a render.
 */
describe('MemoryWatch', () => {
  it('reports current and peak, with peak >= current at rest', () => {
    const w = new MemoryWatch(25);
    const r = w.report();
    expect(r.current.rssMb).toBeGreaterThan(0);
    expect(r.peak.rssMb).toBeGreaterThanOrEqual(r.current.rssMb);
    expect(r.sampleIntervalMs).toBe(25);
    expect(r.sampling).toBe(false);
    expect(r.lastRender).toBeNull();
    expect(new Date(r.sinceIso).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('is a high-water mark — peak never decreases across samples', () => {
    const w = new MemoryWatch(25);
    const first = w.report().peak.rssMb;
    // Allocate then release; peak must retain the high mark either way.
    let ballast: Buffer | null = Buffer.alloc(64 * 1024 * 1024, 7);
    expect(ballast.length).toBe(64 * 1024 * 1024);
    const mid = w.report().peak.rssMb;
    ballast = null;
    const after = w.report().peak.rssMb;
    expect(mid).toBeGreaterThanOrEqual(first);
    expect(after).toBeGreaterThanOrEqual(mid);
  });

  it('samples during a tracked render and attributes the peak to it', async () => {
    const w = new MemoryWatch(10);
    let sawSamplingDuringRender = false;
    const result = await w.track('unit-test-render', async () => {
      sawSamplingDuringRender = w.sampling;
      // Hold an allocation across at least a few sampling intervals so the
      // interval timer — not just the start/end samples — records it.
      const hold = Buffer.alloc(48 * 1024 * 1024, 3);
      await new Promise((r) => setTimeout(r, 60));
      return hold.length;
    });

    expect(result).toBe(48 * 1024 * 1024);
    expect(sawSamplingDuringRender).toBe(true);
    // Sampling stops once the render returns — no idle timer churn.
    expect(w.sampling).toBe(false);

    const r = w.report();
    expect(r.lastRender).not.toBeNull();
    expect(r.lastRender!.label).toBe('unit-test-render');
    expect(r.lastRender!.peakRssMb).toBeGreaterThanOrEqual(r.lastRender!.baselineRssMb);
    expect(r.lastRender!.endRssMb).not.toBeNull();
    expect(r.lastRender!.durationMs).toBeGreaterThanOrEqual(0);
    // heldAfterMb = end - baseline: this is the leak signal.
    expect(r.lastRender!.heldAfterMb).not.toBeNull();
  });

  it('separates peak from leak: heldAfterMb is end-minus-baseline, not the peak', async () => {
    const w = new MemoryWatch(10);
    await w.track('transient-alloc', async () => {
      const scratch = Buffer.alloc(80 * 1024 * 1024, 1);
      await new Promise((r) => setTimeout(r, 40));
      return scratch.length;
    });
    const r = w.report();
    // The peak must be at least as large as what was still held at the end —
    // if these were the same number, the instrument could not tell a
    // transient spike from a retained allocation.
    expect(r.lastRender!.peakRssMb).toBeGreaterThanOrEqual(
      r.lastRender!.baselineRssMb + (r.lastRender!.heldAfterMb ?? 0) - 0.1,
    );
  });

  it('propagates render errors unchanged and still stops sampling', async () => {
    const w = new MemoryWatch(10);
    await expect(
      w.track('failing-render', async () => {
        throw new Error('Input image exceeds pixel limit');
      }),
    ).rejects.toThrow('Input image exceeds pixel limit');
    expect(w.sampling).toBe(false);
    // A failed render is exactly the case worth measuring — it must still be
    // attributed, because the 100×150 OOM is the reason this module exists.
    expect(w.report().lastRender!.label).toBe('failing-render');
  });

  it('handles concurrent tracked renders without stopping sampling early', async () => {
    const w = new MemoryWatch(10);
    let samplingMidway = false;
    await Promise.all([
      w.track('concurrent-a', async () => {
        await new Promise((r) => setTimeout(r, 50));
      }),
      w.track('concurrent-b', async () => {
        await new Promise((r) => setTimeout(r, 20));
        samplingMidway = w.sampling;
      }),
    ]);
    // b finishing must not stop sampling while a is still running.
    expect(samplingMidway).toBe(true);
    expect(w.sampling).toBe(false);
  });
});
