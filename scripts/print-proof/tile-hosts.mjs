// Read-only: which hosts serve map tiles/glyphs to the live editor. Records hostnames only (never URLs or query strings).
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const hosts = {};
page.on('request', r => { const u = new URL(r.url()); const kind = /\.pbf|\/tiles?\/|\.mvt|planet/.test(u.pathname) ? 'tiles' : /fonts?\//.test(u.pathname) ? 'glyphs' : /tilejson/.test(u.pathname) ? 'tilejson' : null; if (kind) hosts[kind + ' ' + u.hostname] = (hosts[kind + ' ' + u.hostname] || 0) + 1; });
await page.goto('https://mapvibestudio.com/products/mapvibe-city-map-print', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(20000);
console.log(JSON.stringify(hosts, null, 1));
await browser.close();
