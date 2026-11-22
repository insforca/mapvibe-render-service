import json, sys, os
import numpy as np
from PIL import Image
OUT = sys.argv[1]
cap = json.load(open(os.path.join(OUT, 'capture.json'), encoding='utf8'))
summ = {s['name']: s for s in json.load(open(os.path.join(OUT, 'summary.json'), encoding='utf8'))}
def hex2rgb(h):
    h = (h or '#ffffff').lstrip('#'); return np.array([int(h[i:i+2], 16) for i in (0, 2, 4)], dtype=np.float32)
def ink(img, box, rgb, thr):
    H, W = img.shape[:2]
    y0, y1 = int((box['top'] - 0.015) * H), int((box['bottom'] + 0.015) * H)
    x0, x1 = int((box['cx'] - box['w'] / 2 - 0.01) * W), int((box['cx'] + box['w'] / 2 + 0.01) * W)
    reg = img[max(0, y0):y1, max(0, x0):x1]
    m = np.sqrt(((reg - rgb) ** 2).sum(-1)) < thr
    rows = np.where(m.mean(1) > 0.03)[0]; cols = np.where(m.mean(0) > 0.03)[0]
    if not len(rows) or not len(cols): return None
    return {'top': (max(0, y0) + rows.min()) / H, 'bottom': (max(0, y0) + rows.max() + 1) / H,
            'left': (max(0, x0) + cols.min()) / W, 'right': (max(0, x0) + cols.max() + 1) / W}
rows = []
for r in cap:
    if r.get('error') or not r.get('editor'): continue
    e = np.asarray(Image.open(os.path.join(OUT, r['name'] + '-editor.png')).convert('RGB'), dtype=np.float32)
    pim = Image.open(os.path.join(OUT, r['name'] + '-print.png')).convert('RGB').resize((e.shape[1], e.shape[0]), Image.LANCZOS)
    p = np.asarray(pim, dtype=np.float32)
    rgb = hex2rgb(r['snap'].get('text'))
    res = {}
    for line in ('city', 'country', 'coords'):
        box = r['editor'].get(line)
        if not box: res[line] = 'hidden'; continue
        a, b = ink(e, box, rgb, 60), ink(p, box, rgb, 60)
        if not a or not b: res[line] = {'editor': a, 'print': b}; continue
        res[line] = {k: round((b[k] - a[k]) * 100, 2) for k in ('top', 'bottom', 'left', 'right')}
        res[line]['h_ratio'] = round((b['bottom'] - b['top']) / (a['bottom'] - a['top']), 3)
    worst = max([abs(v) for d in res.values() if isinstance(d, dict) and 'top' in d for k, v in d.items() if k in ('top', 'bottom')] + [0])
    summ[r['name']]['lockup_ink'] = res; summ[r['name']]['lockup_worst_pct'] = worst
    summ[r["name"]]["pass"]["lockup_le_0_5pct"] = bool(worst <= 0.5 and all(isinstance(d, str) or 'top' in d for d in res.values()))
    summ[r['name']].pop('lockup', None)
    print(f"{r['name']:30s} worst {worst:.2f}%  " + '  '.join(f"{k}:{v}" for k, v in res.items()))
json.dump(list(summ.values()), open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf8'), indent=1)
