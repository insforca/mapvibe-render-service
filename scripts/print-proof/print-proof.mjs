// Print proof (Ivan approved option A, 2026-11-22). Local only:
// - the editor is a local build of studio main (b771745) plus one uncommitted line that
//   exposes the real order-snapshot function (useStoreConfig.storeConfig) on window;
// - /api/store-config is intercepted (nothing leaves the machine); every other /api call is aborted;
// - the print is rendered by a local render server on main (3ab12b9) with the same parameters
//   /fulfill uses for a config snapshot (renderConfigToBlobUrl), minus the Blob upload.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
const [OUT, DIST, SECRET_FILE] = process.argv.slice(2);
const SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
const RENDER = 'http://localhost:8787';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain', '.md': 'text/plain' };
const DESIGNS = [
  { name: '01-new-york', lat: 40.7128, lng: -74.0060, city: 'New York', theme: 'classic_navy', size: '18x24' },
  { name: '02-washington-country-coords', lat: 38.9072, lng: -77.0369, city: 'Washington', theme: 'ice_and_iron', size: '18x24', off: ['City'] },
  { name: '03-saint-petersburg', lat: 59.9311, lng: 30.3609, city: 'Saint Petersburg', theme: 'tk_emerald', size: '18x24' },
  { name: '04-sydney', lat: -33.8688, lng: 151.2093, city: 'Sydney', theme: 'tk_sunset', size: '24x36' },
  { name: '05-tokyo-a0', lat: 35.6762, lng: 139.6503, city: 'Tokyo', theme: 'neon_night', size: 'a0' },
  { name: '06-lisbon-light', lat: 38.7223, lng: -9.1393, city: 'Lisbon', theme: 'tk_warm_beige', size: '18x24' },
  { name: '07-chicago-dark', lat: 41.8781, lng: -87.6298, city: 'Chicago', theme: 'dark_mode_empire', size: '28x40' },
  { name: '08-paris-no-text', lat: 48.8566, lng: 2.3522, city: 'Paris', theme: 'tk_terracotta', size: '18x24', noText: true },
];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
for (const d of DESIGNS) {
  if (only && !only.includes(d.name)) continue;
  const r = { name: d.name };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'America/New_York' });
    let snapshot = null; const blocked = [];
    await ctx.route('http://localhost:4173/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname === '/api/store-config') { snapshot = JSON.parse(route.request().postData() || 'null'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://example.invalid/proof.json', snapshotHash: 'proof' }) }); }
      if (u.pathname === '/api/tilejson') { const tj = await (await fetch('https://tiles.openfreemap.org/planet')).text(); return route.fulfill({ status: 200, contentType: 'application/json', body: tj }); }
      if (u.pathname === '/api/sales-status') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"salesPaused":true}' });
      if (u.pathname.startsWith('/api/')) { blocked.push(u.pathname); return route.abort(); }
      const local = route.request().resourceType() === 'document' ? path.join(DIST, 'index.html') : path.join(DIST, decodeURIComponent(u.pathname));
      if (fs.existsSync(local) && fs.statSync(local).isFile()) return route.fulfill({ status: 200, contentType: types[path.extname(local)] || 'application/octet-stream', body: fs.readFileSync(local) });
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage();
    const q = new URLSearchParams({ shopify: '1', lat: d.lat, lng: d.lng, city: d.city, theme: d.theme, size: d.size });
    await page.goto('http://localhost:4173/?' + q, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(9000);
    const closeModals = () => page.evaluate(() => { for (const b of document.querySelectorAll('button')) if (/Start creating/i.test(b.textContent) && b.getBoundingClientRect().width > 0) b.click(); });
    await closeModals();
    await page.waitForTimeout(2500);
    if (d.off || d.noText) {
      await page.locator('button.mvs-sidebar__tab', { hasText: 'PERSONALIZE' }).first().click().catch(e => r.err = 'tab ' + String(e).slice(0, 80));
      await page.waitForTimeout(1200);
      if (d.noText) await page.getByLabel(/Show this text on the print/i).first().uncheck().catch(e => r.err = 'notext ' + String(e).slice(0, 80));
      for (const l of d.off ?? []) await page.locator('.mvs-line-switch').nth(['City', 'Country', 'Coordinates'].indexOf(l)).click();
      await page.waitForTimeout(1200);
    }
    await page.screenshot({ path: path.join(OUT, d.name + '-before-cta.png') });
    r.ctas = await page.evaluate(() => [...document.querySelectorAll('.mvs-bottom-bar__cta, button')].filter(b => /preview|poster/i.test(b.textContent)).map(b => { const x = b.getBoundingClientRect(); return { t: b.textContent.trim().slice(0, 40), cls: String(b.className).slice(0, 60), vis: x.width > 0, dis: b.disabled }; }));
    r.blocker = await page.evaluate(() => { const b = document.querySelector('.mvs-bottom-bar__cta--primary'); if (!b) return 'no button'; const x = b.getBoundingClientRect(); const top = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2); return top === b || b.contains(top) ? 'clear' : (top?.tagName + '.' + String(top?.className).slice(0, 60)); });
    await page.evaluate(() => document.querySelector('.mvs-bottom-bar__cta--primary')?.click());
    await page.waitForTimeout(3000);
    await closeModals(); await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(7000);
    r.modalOpen = await page.evaluate(() => !!document.querySelector('.mvs-modal-backdrop'));
    // The framed poster in the preview step: the nearest portrait ancestor of the lockup (or the map canvas when text is off).
    const anchor = (await page.locator('.lockup-v2').count()) ? page.locator('.lockup-v2').last() : page.locator('.maplibregl-canvas').last();
    const poster = await anchor.evaluateHandle(el => { let e = el.parentElement; while (e && e !== document.body) { const b = e.getBoundingClientRect(); if (b.height > b.width * 1.05 && b.width > 150 && b.width < 900) return e; e = e.parentElement; } return el; });
    const info = await poster.asElement().evaluate(el => {
      const p = el.getBoundingClientRect();
      const rel = sel => { const n = [...el.querySelectorAll(sel)].filter(x => x.getBoundingClientRect().width > 0).at(-1); if (!n) return null; const b = n.getBoundingClientRect(); return { top: (b.top - p.top) / p.height, bottom: (b.bottom - p.top) / p.height, cx: (b.left + b.width / 2 - p.left) / p.width, w: b.width / p.width, text: n.textContent.trim() }; };
      return { poster: { x: p.x, y: p.y, w: p.width, h: p.height, cls: String(el.className).slice(0, 60) }, city: rel('.lockup-v2-city'), country: rel('.lockup-v2-country'), coords: rel('.lockup-v2-coords') };
    });
    r.editor = info;
    await poster.asElement().screenshot({ path: path.join(OUT, d.name + '-editor.png') });
    const ok = await page.evaluate(async () => { const fn = window.__mvsProofStoreConfig; if (!fn) return 'no hook'; try { await fn(); return 'ok'; } catch (e) { return String(e).slice(0, 120); } });
    r.snapshotCall = ok; r.blockedApi = [...new Set(blocked)];
    await ctx.close();
    if (!snapshot) throw new Error('no snapshot captured: ' + ok);
    fs.writeFileSync(path.join(OUT, d.name + '-snapshot.json'), JSON.stringify(snapshot));
    // Same source patch as renderConfigToBlobUrl (no MapTiler key locally → OpenFreeMap glyphs).
    const style = JSON.parse(JSON.stringify(snapshot.styleJson));
    for (const src of Object.values(style.sources ?? {})) if (typeof src?.url === 'string' && (src.url.includes('openfreemap.org') || src.url.startsWith('/') || src.url.includes('mapvibestudio.com'))) src.url = 'https://tiles.openfreemap.org/planet';
    if (typeof style.glyphs === 'string' && (style.glyphs.startsWith('/') || style.glyphs.includes('mapvibestudio.com'))) style.glyphs = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
    if (typeof style.sprite === 'string' && style.sprite.startsWith('/')) style.sprite = 'https://app.mapvibestudio.com' + style.sprite;
    // Proof size: same aspect as the print (cm), 2400 px tall. Full-size scale invariance is checked separately.
    const height = 2400, width = Math.round(2400 * snapshot.widthCm / snapshot.heightCm);
    const body = {
      styleJson: style, center: snapshot.center, zoom: Math.min(17, snapshot.zoom), bearing: snapshot.bearing ?? 0, pitch: snapshot.pitch ?? 0, bounds: snapshot.bounds,
      width, height, printMode: true, minorRoads: snapshot.minorRoads === true,
      ...(typeof snapshot.mapWidth === 'number' && typeof snapshot.mapHeight === 'number' ? { mapWidth: snapshot.mapWidth, mapHeight: snapshot.mapHeight } : {}),
      displayCity: snapshot.displayCity ?? '', displayCountry: snapshot.displayCountry ?? '', fontFamily: (snapshot.fontFamily ?? '').trim(), lockupFont: snapshot.lockupFont,
      lockupLayout: snapshot.lockupLayout, showCity: snapshot.showCity, showCountry: snapshot.showCountry, showCoords: snapshot.showCoords,
      showPosterText: snapshot.showPosterText !== false, fadeStyle: (snapshot.fadeStyle && snapshot.fadeStyle !== 'text') ? snapshot.fadeStyle : 'fullbleed',
      includeCredits: snapshot.includeCredits !== false, textLayout: snapshot.textLayout ?? 'centered', theme: snapshot.theme ?? {},
    };
    const t0 = Date.now();
    const res = await fetch(RENDER + '/render', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': SECRET }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
    r.render = { status: res.status, ms: Date.now() - t0, width, height };
    if (!res.ok) throw new Error('render ' + res.status + ' ' + (await res.text()).slice(0, 120));
    fs.writeFileSync(path.join(OUT, d.name + '-print.png'), Buffer.from(await res.arrayBuffer()));
    r.snap = { lockupLayout: snapshot.lockupLayout, lockupFont: snapshot.lockupFont, showCity: snapshot.showCity, showCountry: snapshot.showCountry, showCoords: snapshot.showCoords, showPosterText: snapshot.showPosterText, widthCm: snapshot.widthCm, heightCm: snapshot.heightCm, zoom: snapshot.zoom, bounds: snapshot.bounds, mapWidth: snapshot.mapWidth, mapHeight: snapshot.mapHeight, city: snapshot.displayCity, coords: snapshot.displayCoordinates, text: snapshot.theme?.ui?.text, overlayBg: snapshot.theme?.map?.overlayBg };
  } catch (e) { r.error = String(e).slice(0, 300); }
  console.error(d.name, r.error ?? 'ok', r.render?.ms ?? '');
  results.push(r);
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(results, null, 1));
