// 生成演示成片 src/assets/demo-film.webm：用原型里的模板画面（#/film-frame?scene=n）逐幕截图，按演示数据的幕时间轴合成，
// 配一条可听的示意音轨（正式产品是配音）。VP9 + Opus，640×360，约 96 秒，用于原型播放器与 CDS 交接检查的 media-playing / audio-playing。
//   node tools/make-demo-film.mjs --checkout <仓库根>      （先构建一次原型，生成后再构建一次）
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const i = argv.indexOf('--checkout');
const checkout = path.resolve(i >= 0 ? argv[i + 1] : path.join(dir, '..', '..'));
const req = createRequire(path.join(checkout, 'prd-admin', 'package.json'));
let chromium; try { ({ chromium } = req('playwright')); } catch { ({ chromium } = createRequire(import.meta.url)('playwright')); }

/* 幕时间轴与 src/fixtures.ts 的 sceneDefs 一致：[模板画面编号, 开始秒] */
const scenes = [[1, 0], [2, 12], [3, 26], [2, 40], [3, 68], [1, 86]];
const total = 96;
const work = path.join(tmpdir(), `qc-film-${process.pid}`);
mkdirSync(work, { recursive: true });

const html = readFileSync(path.join(dir, 'dist/index.html'));
const server = http.createServer((rq, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 0.5 });
const frames = [...new Set(scenes.map(s => s[0]))];
for (const n of frames) {
  await page.goto(`http://127.0.0.1:${port}/#/film-frame?scene=${n}`);
  await page.waitForSelector('[data-qc-ready=film-frame]');
  await page.waitForTimeout(300);
  await page.locator('[data-qc-ready=film-frame]').screenshot({ path: path.join(work, `scene-${n}.png`) });
}
await browser.close(); server.close();

/* concat 清单：每幕显示到下一幕开始 */
const list = scenes.map(([n, start], k) => `file '${path.join(work, `scene-${n}.png`)}'\nduration ${(scenes[k + 1]?.[1] ?? total) - start}`).join('\n')
  + `\nfile '${path.join(work, `scene-${scenes.at(-1)[0]}.png`)}'\n`;
writeFileSync(path.join(work, 'list.txt'), list);
/* 示意音轨：每幕一个音高的柔和长音，幕切换处有一声短提示 */
const freq = scenes.map(([, start], k) => `if(lt(t,${scenes[k + 1]?.[1] ?? total}),${[262, 294, 330, 294, 349, 262][k]},`).join('') + '262' + ')'.repeat(scenes.length);
const chime = scenes.slice(1).map(([, s]) => `between(t,${s},${s + 0.25})`).join('+');
const audio = `aevalsrc=exprs='0.06*sin(2*PI*(${freq})*t)+0.05*(${chime})*sin(2*PI*880*t)':s=24000:d=${total}`;
const out = path.join(dir, 'src/assets/demo-film.webm');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'),
  '-f', 'lavfi', '-i', audio,
  '-vf', 'scale=640:360,fps=2,format=yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '48', '-g', '4', '-deadline', 'good', '-row-mt', '1',
  '-c:a', 'libopus', '-b:a', '12k', '-ac', '1', '-t', String(total), '-shortest', out]);
console.log(JSON.stringify({ out: path.relative(dir, out), bytes: statSync(out).size, scenes: scenes.length, seconds: total }));
