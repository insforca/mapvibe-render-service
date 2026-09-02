/* ── cgroup accounting tests ──────────────────────────────────────────────────
 *
 * Every case runs against a REAL fixture directory tree, not a mocked `fs`.
 * That is deliberate: the module's whole job is tolerating a filesystem that is
 * partially present, and a mock would encode the same assumptions the module
 * makes rather than testing them. Each fixture writes only the files that case
 * is about, so "absent" is genuinely absent.
 *
 * The partial-availability case is not hypothetical — it was observed in a real
 * container: `memory.stat` readable while `memory.max`/`memory.current` were
 * absent, and no v1 tree at all.
 * ──────────────────────────────────────────────────────────────────────────── */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import os from 'os';

import {
  parseByteValue,
  parseStatKey,
  readCeiling,
  readUsage,
  readKernelPeak,
  probeAvailability,
} from '../cgroup.js';

let root: string;

/** Write a file inside the fixture tree, creating parent dirs as needed. */
function put(relPath: string, body: string): void {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cgroup-fixture-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseByteValue', () => {
  it('parses a plain byte count', () => {
    expect(parseByteValue('4294967296')).toBe(4294967296);
  });

  it('treats the literal v2 word `max` as unlimited', () => {
    expect(parseByteValue('max')).toBe('unlimited');
  });

  it('treats the v1 huge sentinel as unlimited, not as a real limit', () => {
    // Classic v1 "no limit" value — must never be reported as a 9-exabyte box.
    expect(parseByteValue('9223372036854771712')).toBe('unlimited');
  });

  it('returns null for unreadable, empty, or non-numeric input', () => {
    expect(parseByteValue(null)).toBeNull();
    expect(parseByteValue('')).toBeNull();
    expect(parseByteValue('   ')).toBeNull();
    expect(parseByteValue('not-a-number')).toBeNull();
    expect(parseByteValue('12x')).toBeNull();
  });

  it('tolerates trailing whitespace as written by the kernel', () => {
    expect(parseByteValue('2147483648\n')).toBe(2147483648);
  });
});

describe('parseStatKey', () => {
  const body = ['anon 1234567', 'file 89', 'kernel_stack 0', 'rss 555'].join('\n');

  it('extracts an exact key', () => {
    expect(parseStatKey(body, 'anon')).toBe(1234567);
    expect(parseStatKey(body, 'rss')).toBe(555);
  });

  it('does not prefix-match a different key', () => {
    // `anon_thp` must not satisfy a request for `anon`, nor vice versa.
    expect(parseStatKey('anon_thp 99', 'anon')).toBeNull();
  });

  it('returns null for a missing key or unreadable body', () => {
    expect(parseStatKey(body, 'nope')).toBeNull();
    expect(parseStatKey(null, 'anon')).toBeNull();
  });
});

describe('readCeiling', () => {
  it('prefers the cgroup v2 limit and labels its source', () => {
    put('memory.max', '4294967296\n');
    const c = readCeiling(root);
    expect(c.bytes).toBe(4294967296);
    expect(c.source).toBe('cgroup-v2:memory.max');
    expect(c.unlimited).toBe(false);
    expect(c.trusted).toBe(true);
  });

  it('reports v2 `max` as unlimited with no invented number', () => {
    put('memory.max', 'max\n');
    const c = readCeiling(root);
    expect(c.unlimited).toBe(true);
    expect(c.bytes).toBeNull();
    expect(c.source).toBe('cgroup-v2:memory.max');
  });

  it('falls back to the v1 limit when no v2 file exists', () => {
    put('memory/memory.limit_in_bytes', '2147483648\n');
    const c = readCeiling(root);
    expect(c.bytes).toBe(2147483648);
    expect(c.source).toBe('cgroup-v1:memory.limit_in_bytes');
    expect(c.trusted).toBe(true);
  });

  it('reads the operator-supplied byte limit before falling back to host RAM', () => {
    vi.stubEnv('CONTAINER_MEMORY_LIMIT_BYTES', '4294967296');
    const c = readCeiling(root); // empty fixture tree — no cgroup files at all
    expect(c.bytes).toBe(4294967296);
    expect(c.source).toBe('env:CONTAINER_MEMORY_LIMIT_BYTES');
    expect(c.trusted).toBe(true);
  });

  it('accepts the operator limit in MB and converts it', () => {
    vi.stubEnv('CONTAINER_MEMORY_LIMIT_MB', '4096');
    const c = readCeiling(root);
    expect(c.bytes).toBe(4096 * 1024 * 1024);
    expect(c.source).toBe('env:CONTAINER_MEMORY_LIMIT_MB');
  });

  it('ranks a real cgroup limit above the env override', () => {
    put('memory.max', '1073741824\n');
    vi.stubEnv('CONTAINER_MEMORY_LIMIT_BYTES', '4294967296');
    const c = readCeiling(root);
    expect(c.source).toBe('cgroup-v2:memory.max');
    expect(c.bytes).toBe(1073741824);
  });

  it('marks os.totalmem() UNTRUSTED — it is the host RAM, not our limit', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(67_000_000_000); // a big host node
    const c = readCeiling(root);
    expect(c.source).toBe('os.totalmem');
    expect(c.bytes).toBe(67_000_000_000);
    // The whole point: a caller must be able to refuse to gate on this.
    expect(c.trusted).toBe(false);
  });

  it('reports `unavailable` rather than 0 when nothing is readable', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(0);
    const c = readCeiling(root);
    expect(c.source).toBe('unavailable');
    expect(c.bytes).toBeNull();
    expect(c.trusted).toBe(false);
  });
});

describe('readUsage', () => {
  it('reads v2 current and anon with distinct source labels', () => {
    put('memory.current', '1500000000\n');
    put('memory.stat', 'anon 1200000000\nfile 300000000\n');
    const u = readUsage(root);
    expect(u.currentBytes).toBe(1500000000);
    expect(u.currentSource).toBe('cgroup-v2:memory.current');
    expect(u.anonBytes).toBe(1200000000);
    expect(u.anonSource).toBe('cgroup-v2:memory.stat:anon');
  });

  it('reads v1 usage and labels its anon-equivalent as `rss` (not process RSS)', () => {
    put('memory/memory.usage_in_bytes', '900000000\n');
    put('memory/memory.stat', 'rss 700000000\ncache 200000000\n');
    const u = readUsage(root);
    expect(u.currentBytes).toBe(900000000);
    expect(u.currentSource).toBe('cgroup-v1:memory.usage_in_bytes');
    expect(u.anonBytes).toBe(700000000);
    expect(u.anonSource).toBe('cgroup-v1:memory.stat:rss');
  });

  it('degrades each field INDEPENDENTLY (the real partial-availability case)', () => {
    // Observed in a live container: memory.stat readable, memory.current absent.
    put('memory.stat', 'anon 1200000000\n');
    const u = readUsage(root);
    expect(u.currentBytes).toBeNull();
    expect(u.currentSource).toBe('unavailable');
    expect(u.anonBytes).toBe(1200000000);
    expect(u.anonSource).toBe('cgroup-v2:memory.stat:anon');
  });

  it('returns nulls, never zeros, on a bare tree', () => {
    const u = readUsage(root);
    expect(u.currentBytes).toBeNull();
    expect(u.anonBytes).toBeNull();
    expect(u.currentSource).toBe('unavailable');
    expect(u.anonSource).toBe('unavailable');
  });
});

describe('readKernelPeak', () => {
  it('reads the kernel high-water mark when present', () => {
    put('memory.peak', '2650000000\n');
    const p = readKernelPeak(root);
    expect(p.bytes).toBe(2650000000);
    expect(p.source).toBe('cgroup-v2:memory.peak');
  });

  it('reports unavailable on older kernels rather than guessing', () => {
    const p = readKernelPeak(root);
    expect(p.bytes).toBeNull();
    expect(p.source).toBe('unavailable');
  });
});

describe('probeAvailability', () => {
  it('reports usage available when any usage field is readable', () => {
    put('memory.stat', 'anon 1000\n');
    const a = probeAvailability(root);
    expect(a.usageAvailable).toBe(true);
    expect(a.kernelPeakAvailable).toBe(false);
    expect(a.kernelPeakResettable).toBe(false);
  });

  it('reports kernel peak available and resettable on a writable fixture', () => {
    put('memory.current', '1000\n');
    put('memory.peak', '5000\n');
    const a = probeAvailability(root);
    expect(a.usageAvailable).toBe(true);
    expect(a.kernelPeakAvailable).toBe(true);
    // A tmpdir file is writable, so the reset path is exercised for real.
    expect(a.kernelPeakResettable).toBe(true);
  });

  it('reports nothing available on a bare tree without throwing', () => {
    const a = probeAvailability(root);
    expect(a.usageAvailable).toBe(false);
    expect(a.kernelPeakAvailable).toBe(false);
    expect(a.kernelPeakResettable).toBe(false);
  });
});
