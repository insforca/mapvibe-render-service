/* ── Container memory accounting via cgroup ──────────────────────────────────
 *
 * WHY THIS EXISTS (2026-09-02):
 *
 * `process.memoryUsage()` measures the CALLING process only. The OSM render
 * path does its work in a spawned Python child (`spawn(MAPVIBE_PYTHON, …)`),
 * where the 144.5 MP matplotlib canvas is actually allocated. So the in-process
 * instrument reported ~103 MB for a full print-size 70×100 render — a true
 * measurement of the wrong process, and blind to the allocation that would
 * actually OOM the container.
 *
 * cgroup accounting covers EVERY process in the container — Node and the Python
 * child together — which is also exactly what the kernel OOM killer compares
 * against the limit. That makes it both the ceiling source and the only way to
 * see the child's footprint.
 *
 * DESIGN NOTES, each learned rather than assumed:
 *
 * 1. os.totalmem() is the WRONG ceiling in a container: it reports the host
 *    machine's RAM, not the cgroup limit. On a platform like Railway that means
 *    the underlying node's memory — an authoritative-looking wrong number, and
 *    that is worse than no number because it closes the question. So when no
 *    cgroup limit file is readable, the next fallback is an OPERATOR-SUPPLIED
 *    env var (CONTAINER_MEMORY_LIMIT_BYTES or _MB): the operator chose the tier,
 *    so an explicit configured value is both correct and honest. os.totalmem()
 *    sits below that as a last resort and is flagged `trusted: false`, so a
 *    caller cannot gate a decision on it by accident.
 *
 * 2. PER-FILE existence checks, not a single v2-vs-v1 branch. Observed in a
 *    real container: `memory.stat` present while `memory.max`/`memory.current`
 *    were absent, and no v1 tree at all. Partial availability is normal, so
 *    every field probes its own file and degrades to null independently.
 *
 * 3. `memory.peak` (cgroup v2, Linux 5.19+) is a KERNEL-tracked high-water
 *    mark. When present it is exact and eliminates the sampling-resolution
 *    caveat entirely — no 250 ms tick can miss a spike. Sampling
 *    `memory.current` is the fallback, not the primary.
 *
 * 4. `memory.current` includes RECLAIMABLE PAGE CACHE, so a large value can
 *    mean "the kernel cached our PNG writes", not "we allocated 3 GB". `anon`
 *    from `memory.stat` is the non-reclaimable anonymous allocation — closer to
 *    true footprint. Both are reported, and both are labelled:
 *      current → OOM proximity (what the OOM killer compares against the limit)
 *      anon    → what the render actually took
 *
 * 5. cgroup v1 names the anon-equivalent `rss` in memory.stat (which is NOT
 *    process RSS); labelled distinctly so a reader never has to guess which
 *    field a number came from.
 *
 * OBSERVABILITY ONLY — nothing here changes render behaviour or output. Every
 * read is failure-tolerant: an unreadable file yields null with a source label,
 * never a thrown error, because instrumentation must never break a render.
 * ──────────────────────────────────────────────────────────────────────────── */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import os from 'os';

/** Default cgroup mount. Parameterised so tests can point at a fixture tree. */
export const CGROUP_ROOT = '/sys/fs/cgroup';

/**
 * cgroup v1 writes a huge sentinel instead of a word for "no limit"
 * (classically 9223372036854771712). Anything at or above 2^53 is not a real
 * container limit and is treated as unlimited.
 */
const UNLIMITED_THRESHOLD = Number.MAX_SAFE_INTEGER;

export type CeilingSource =
  | 'cgroup-v2:memory.max'
  | 'cgroup-v1:memory.limit_in_bytes'
  | 'env:CONTAINER_MEMORY_LIMIT_BYTES'
  | 'env:CONTAINER_MEMORY_LIMIT_MB'
  | 'os.totalmem'
  | 'unavailable';

export interface MemoryCeiling {
  /** Limit in bytes, or null when unlimited/unreadable. */
  bytes: number | null;
  /** Which file the number came from — provenance readable, not assumed. */
  source: CeilingSource;
  /** True when the cgroup declares no limit (literal `max`, or v1 sentinel). */
  unlimited: boolean;
  /**
   * False when the number does NOT describe this container's limit — i.e.
   * os.totalmem() (the HOST's RAM) or nothing readable at all. A caller must
   * not gate an admission or capacity decision on an untrusted ceiling.
   */
  trusted: boolean;
}

export type UsageSource =
  | 'cgroup-v2:memory.current'
  | 'cgroup-v1:memory.usage_in_bytes'
  | 'unavailable';

export type AnonSource =
  | 'cgroup-v2:memory.stat:anon'
  | 'cgroup-v1:memory.stat:rss'
  | 'unavailable';

export interface ContainerUsage {
  /** Includes reclaimable page cache — this is what the OOM killer compares. */
  currentBytes: number | null;
  currentSource: UsageSource;
  /** Non-reclaimable anonymous memory — closer to true allocation. */
  anonBytes: number | null;
  anonSource: AnonSource;
}

export interface KernelPeak {
  /** Kernel-tracked high-water mark — exact, no sampling gap. */
  bytes: number | null;
  source: 'cgroup-v2:memory.peak' | 'unavailable';
}

/** Read a file and return its trimmed contents, or null if unreadable. */
function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Parse a cgroup byte-count file. Exported for direct testing.
 * Returns `'unlimited'` for the literal v2 word `max` and for the v1 sentinel.
 */
export function parseByteValue(raw: string | null): number | 'unlimited' | null {
  if (raw === null) return null;
  const text = raw.trim();
  if (text === '') return null;
  if (text === 'max') return 'unlimited';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  if (n >= UNLIMITED_THRESHOLD) return 'unlimited';
  return n;
}

/**
 * Pull a single key's value out of a `memory.stat` body.
 * Exported for direct testing.
 */
export function parseStatKey(body: string | null, key: string): number | null {
  if (body === null) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const sep = trimmed.indexOf(' ');
    if (sep === -1) continue;
    if (trimmed.slice(0, sep) !== key) continue;
    const value = trimmed.slice(sep + 1).trim();
    if (!/^\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Resolve the container memory ceiling, preferring the real cgroup limit and
 * falling back to os.totalmem() only when no cgroup limit is readable.
 */
export function readCeiling(root: string = CGROUP_ROOT): MemoryCeiling {
  const v2 = parseByteValue(readTextFile(`${root}/memory.max`));
  if (v2 === 'unlimited') {
    return { bytes: null, source: 'cgroup-v2:memory.max', unlimited: true, trusted: true };
  }
  if (typeof v2 === 'number') {
    return { bytes: v2, source: 'cgroup-v2:memory.max', unlimited: false, trusted: true };
  }

  const v1 = parseByteValue(readTextFile(`${root}/memory/memory.limit_in_bytes`));
  if (v1 === 'unlimited') {
    return {
      bytes: null,
      source: 'cgroup-v1:memory.limit_in_bytes',
      unlimited: true,
      trusted: true,
    };
  }
  if (typeof v1 === 'number') {
    return {
      bytes: v1,
      source: 'cgroup-v1:memory.limit_in_bytes',
      unlimited: false,
      trusted: true,
    };
  }

  // Operator-supplied limit. Ranks ABOVE os.totalmem() because the operator
  // chose the container tier: an explicit configured value is both correct and
  // honest, where the host's RAM is an authoritative-looking wrong number.
  const envBytes = parseByteValue(process.env.CONTAINER_MEMORY_LIMIT_BYTES ?? null);
  if (typeof envBytes === 'number' && envBytes > 0) {
    return {
      bytes: envBytes,
      source: 'env:CONTAINER_MEMORY_LIMIT_BYTES',
      unlimited: false,
      trusted: true,
    };
  }
  const envMb = parseByteValue(process.env.CONTAINER_MEMORY_LIMIT_MB ?? null);
  if (typeof envMb === 'number' && envMb > 0) {
    return {
      bytes: envMb * 1024 * 1024,
      source: 'env:CONTAINER_MEMORY_LIMIT_MB',
      unlimited: false,
      trusted: true,
    };
  }

  // Last resort. In a container this is the HOST's RAM, not our limit — so it
  // is labelled plainly and flagged untrusted rather than presented as the
  // container ceiling.
  try {
    const total = os.totalmem();
    if (Number.isFinite(total) && total > 0) {
      return { bytes: total, source: 'os.totalmem', unlimited: false, trusted: false };
    }
  } catch {
    /* fall through */
  }
  return { bytes: null, source: 'unavailable', unlimited: false, trusted: false };
}

/** Read container usage: `current` (OOM proximity) and `anon` (real footprint). */
export function readUsage(root: string = CGROUP_ROOT): ContainerUsage {
  let currentBytes: number | null = null;
  let currentSource: UsageSource = 'unavailable';

  const v2Current = parseByteValue(readTextFile(`${root}/memory.current`));
  if (typeof v2Current === 'number') {
    currentBytes = v2Current;
    currentSource = 'cgroup-v2:memory.current';
  } else {
    const v1Current = parseByteValue(readTextFile(`${root}/memory/memory.usage_in_bytes`));
    if (typeof v1Current === 'number') {
      currentBytes = v1Current;
      currentSource = 'cgroup-v1:memory.usage_in_bytes';
    }
  }

  let anonBytes: number | null = null;
  let anonSource: AnonSource = 'unavailable';

  const v2Anon = parseStatKey(readTextFile(`${root}/memory.stat`), 'anon');
  if (v2Anon !== null) {
    anonBytes = v2Anon;
    anonSource = 'cgroup-v2:memory.stat:anon';
  } else {
    // v1 calls the anon-equivalent `rss` in memory.stat — NOT process RSS.
    const v1Rss = parseStatKey(readTextFile(`${root}/memory/memory.stat`), 'rss');
    if (v1Rss !== null) {
      anonBytes = v1Rss;
      anonSource = 'cgroup-v1:memory.stat:rss';
    }
  }

  return { currentBytes, currentSource, anonBytes, anonSource };
}

/** Read the kernel's exact high-water mark, when the kernel provides one. */
export function readKernelPeak(root: string = CGROUP_ROOT): KernelPeak {
  const raw = parseByteValue(readTextFile(`${root}/memory.peak`));
  if (typeof raw === 'number') {
    return { bytes: raw, source: 'cgroup-v2:memory.peak' };
  }
  return { bytes: null, source: 'unavailable' };
}

/**
 * Attempt to reset `memory.peak` so a high-water mark can be attributed to one
 * render. Writing is supported on newer kernels only; failure is expected and
 * non-fatal. Returns true only when the write succeeded.
 */
export function tryResetKernelPeak(root: string = CGROUP_ROOT): boolean {
  const path = `${root}/memory.peak`;
  try {
    if (!existsSync(path)) return false;
    writeFileSync(path, '0');
    return true;
  } catch {
    return false;
  }
}

export interface CgroupAvailability {
  /** True when any cgroup usage number is readable at all. */
  usageAvailable: boolean;
  /** True when the kernel high-water mark is readable (exact, no sampling gap). */
  kernelPeakAvailable: boolean;
  /** True when memory.peak accepted a reset write (per-render attribution). */
  kernelPeakResettable: boolean;
}

/**
 * Probe once at startup. Availability is a property of the kernel and mount,
 * so it does not change over the process lifetime — but the VALUES must always
 * be read fresh, never cached.
 */
export function probeAvailability(root: string = CGROUP_ROOT): CgroupAvailability {
  const usage = readUsage(root);
  const peak = readKernelPeak(root);
  return {
    usageAvailable: usage.currentBytes !== null || usage.anonBytes !== null,
    kernelPeakAvailable: peak.bytes !== null,
    kernelPeakResettable: peak.bytes !== null ? tryResetKernelPeak(root) : false,
  };
}
