"""Print proof analysis: editor screenshot vs local print render, per design.
Framing: best scale/shift aligning the map area (lockup band and credit corners masked).
Lockup: city/country/coords ink bands found the same way in both images (text-colour mask).
Overall: mean RGB difference and a simple global SSIM at 400 px width (indicator only).
"""
import json, sys, os
import numpy as np
from PIL import Image

OUT = sys.argv[1]
cap = json.load(open(os.path.join(OUT, 'capture.json'), encoding='utf8'))

def hex2rgb(h):
    h = (h or '#ffffff').lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float32)

def load_pair(name):
    e = Image.open(os.path.join(OUT, name + '-editor.png')).convert('RGB')
    p = Image.open(os.path.join(OUT, name + '-print.png')).convert('RGB')
    p = p.resize(e.size, Image.LANCZOS)
    return np.asarray(e, dtype=np.float32), np.asarray(p, dtype=np.float32)

def gray(a):
    return a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)

def shift_corr(a, b):
    """Phase correlation; returns (dy, dx) to apply to b to match a, and the peak."""
    A = np.fft.fft2(a - a.mean()); B = np.fft.fft2(b - b.mean())
    R = A * np.conj(B); R /= np.abs(R) + 1e-9
    r = np.fft.ifft2(R).real
    dy, dx = np.unravel_index(np.argmax(r), r.shape)
    if dy > a.shape[0] // 2: dy -= a.shape[0]
    if dx > a.shape[1] // 2: dx -= a.shape[1]
    return int(dy), int(dx), float(r.max())

def ncc(a, b):
    a = a - a.mean(); b = b - b.mean()
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))

def framing(e, p):
    W = 300
    h = round(e.shape[0] * W / e.shape[1])
    ge = np.asarray(Image.fromarray(gray(e).astype(np.uint8)).resize((W, h), Image.BILINEAR), dtype=np.float32)
    gp_full = Image.fromarray(gray(p).astype(np.uint8))
    top, bot = int(h * 0.04), int(h * 0.70)  # map area above the lockup band
    best = None
    for s in np.arange(0.95, 1.0501, 0.0025):
        sw, sh = round(W * s), round(h * s)
        gp = np.asarray(gp_full.resize((sw, sh), Image.BILINEAR), dtype=np.float32)
        # centre-crop/pad back to W x h (scale about the poster centre)
        canvas = np.full((h, W), gp.mean(), dtype=np.float32)
        oy, ox = (sh - h) // 2, (sw - W) // 2
        src = gp[max(0, oy):max(0, oy) + h, max(0, ox):max(0, ox) + W]
        canvas[max(0, -oy):max(0, -oy) + src.shape[0], max(0, -ox):max(0, -ox) + src.shape[1]] = src
        a, b = ge[top:bot, 15:W - 15], canvas[top:bot, 15:W - 15]
        dy, dx, _ = shift_corr(a, b)
        b2 = np.roll(np.roll(b, dy, 0), dx, 1)
        c = ncc(a[10:-10, 10:-10], b2[10:-10, 10:-10])
        if best is None or c > best[0]:
            best = (c, float(s), dy, dx)
    ident = ncc(ge[top:bot, 15:W - 15], np.asarray(gp_full.resize((W, h), Image.BILINEAR), dtype=np.float32)[top:bot, 15:W - 15])
    c, s, dy, dx = best
    return {'corr_identity': round(ident, 4), 'corr_best': round(c, 4), 'best_scale': round(s, 4),
            'scale_error_pct': round(abs(s - 1) * 100, 2), 'shift_x_pct': round(dx / W * 100, 2), 'shift_y_pct': round(dy / h * 100, 2)}

def bands(img, text_rgb):
    h, w = img.shape[:2]
    y0 = int(h * 0.70)
    region = img[y0:, int(w * 0.15):int(w * 0.85)]
    d = np.sqrt(((region - text_rgb) ** 2).sum(-1))
    mask = d < 70
    rows = mask.mean(1)
    on = rows > 0.004
    out, start = [], None
    for i, v in enumerate(list(on) + [False]):
        if v and start is None: start = i
        if not v and start is not None:
            if i - start >= 2: out.append((start, i))
            start = None
    # merge bands split by tiny gaps (glyph features)
    merged = []
    for b in out:
        if merged and b[0] - merged[-1][1] <= max(2, h * 0.002): merged[-1] = (merged[-1][0], b[1])
        else: merged.append(b)
    res = []
    for a, b in merged:
        cols = np.where(mask[a:b].any(0))[0]
        res.append({'top': (y0 + a) / h, 'bottom': (y0 + b) / h,
                    'cx': (int(w * 0.15) + (cols.min() + cols.max()) / 2) / w if len(cols) else None,
                    'w': (cols.max() - cols.min()) / w if len(cols) else None})
    return res

def ssim_global(a, b):
    a = gray(a); b = gray(b)
    ma, mb = a.mean(), b.mean(); va, vb = a.var(), b.var(); cov = ((a - ma) * (b - mb)).mean()
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    return float((2 * ma * mb + C1) * (2 * cov + C2) / ((ma * ma + mb * mb + C1) * (va + vb + C2)))

summary = []
for r in cap:
    name = r['name']
    if r.get('error'):
        summary.append({'name': name, 'error': r['error']}); continue
    e, p = load_pair(name)
    text = hex2rgb(r['snap'].get('text'))
    fr = framing(e, p)
    be, bp = bands(e, text), bands(p, text)
    lock = []
    for i in range(max(len(be), len(bp))):
        x = be[i] if i < len(be) else None; y = bp[i] if i < len(bp) else None
        if x and y:
            lock.append({'band': i, 'top_delta_pct': round((y['top'] - x['top']) * 100, 2), 'bottom_delta_pct': round((y['bottom'] - x['bottom']) * 100, 2),
                         'cx_delta_pct': round(((y['cx'] or 0) - (x['cx'] or 0)) * 100, 2), 'width_delta_pct': round(((y['w'] or 0) - (x['w'] or 0)) * 100, 2),
                         'editor_top': round(x['top'], 4), 'print_top': round(y['top'], 4)})
        else:
            lock.append({'band': i, 'missing_in': 'print' if x else 'editor'})
    small = 400
    hs = round(e.shape[0] * small / e.shape[1])
    es = np.asarray(Image.fromarray(e.astype(np.uint8)).resize((small, hs), Image.LANCZOS), dtype=np.float32)
    ps = np.asarray(Image.fromarray(p.astype(np.uint8)).resize((small, hs), Image.LANCZOS), dtype=np.float32)
    band = slice(int(hs * 0.70), hs)
    s = {'name': name, 'framing': fr, 'lockup': lock, 'bands_editor': len(be), 'bands_print': len(bp),
         'mean_rgb_diff': round(float(np.abs(es - ps).mean()), 2), 'lockup_band_rgb_diff': round(float(np.abs(es[band] - ps[band]).mean()), 2),
         'ssim_global': round(ssim_global(es, ps), 4)}
    worst = max([abs(l.get('top_delta_pct', 0)) for l in lock] + [abs(l.get('bottom_delta_pct', 0)) for l in lock] + [0])
    s['pass'] = {'framing_scale_le_1pct': fr['scale_error_pct'] <= 1.0, 'framing_shift_le_1pct': abs(fr['shift_x_pct']) <= 1.0 and abs(fr['shift_y_pct']) <= 1.0,
                 'lockup_le_0_5pct': worst <= 0.5 and all('missing_in' not in l for l in lock)}
    s['lockup_worst_pct'] = worst
    summary.append(s)
    # side by side
    h = 900
    E = Image.fromarray(e.astype(np.uint8)); P = Image.open(os.path.join(OUT, name + '-print.png')).convert('RGB')
    E2 = E.resize((round(E.width * h / E.height), h)); P2 = P.resize((round(P.width * h / P.height), h))
    c = Image.new('RGB', (E2.width + P2.width + 24, h), 'white'); c.paste(E2, (0, 0)); c.paste(P2, (E2.width + 24, 0)); c.save(os.path.join(OUT, name + '-side.png'))
json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf8'), indent=1)
for s in summary:
    if 'error' in s: print(s['name'], 'ERROR', s['error']); continue
    f = s['framing']
    print(f"{s['name']:30s} frame scale {f['best_scale']:.4f} shift {f['shift_x_pct']:+.2f}/{f['shift_y_pct']:+.2f}% corr {f['corr_identity']:.3f}->{f['corr_best']:.3f} | "
          f"bands e{s['bands_editor']}/p{s['bands_print']} worst {s['lockup_worst_pct']:.2f}% | rgbdiff {s['mean_rgb_diff']} band {s['lockup_band_rgb_diff']} ssim {s['ssim_global']} | {s['pass']}")
