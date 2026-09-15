import { chromium } from '@playwright/test';
const proxy = process.env.HTTPS_PROXY;
const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, proxy: proxy ? { server: proxy } : undefined, args: ['--no-sandbox'] });
const p = await (await b.newContext()).newPage();
try { const r = await p.goto(process.env.TARGET, { waitUntil: 'domcontentloaded', timeout: 45000 }); console.log('status', r?.status(), 'title', await p.title()); }
catch (e) { console.log('打不开:', String(e).split('\n')[0]); }
await b.close();
