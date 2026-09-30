import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

/*
 * 首页片花 → MP4 导出。
 *
 * 用法（在 prd-admin 目录下）：
 *   node scripts/render-landing-film.mjs                    # 中文，1080p30，输出到系统临时目录
 *   FILM_LANG=en FILM_FPS=60 FILM_OUT=./film-en.mp4 node scripts/render-landing-film.mjs
 *
 * 依赖：无头 Chromium 取自 playwright，它不在 prd-admin 的依赖里，先在仓库根目录跑 `cd cds && pnpm install`。
 *
 * 可选环境变量：
 *   FILM_LANG   zh | en（默认 zh）
 *   FILM_FPS    帧率（默认 30）
 *   FILM_OUT    输出 mp4 路径（默认 <tmp>/map-film-<lang>.mp4，同目录另出一张海报 jpg）
 *   FFMPEG      ffmpeg 可执行文件（默认先找 PATH，再找 python imageio-ffmpeg 自带的静态包）
 *   FILM_LIMIT  只渲染前 N 秒（调试用）
 *   FILM_AUDIO  track | synth（默认 track：用 public/film/landing-score.mp3 那段剪好的成品配乐；
 *               synth：用 filmScore 离线合成的备用配乐——页面上配乐加载失败时放的就是它）
 *   FILM_PAGE   换一个导出页（默认 scripts/film/render.html；首屏样片用 scripts/film/hero-sample.html）
 *   FILM_SIZE   画面尺寸，如 390x844（默认 1920x1080；会作为 ?w=&h= 传给导出页。默认导出页固定 1920x1080，给别的尺寸会直接报错退出）
 *   FILM_QUERY  额外拼到导出页地址上的参数（如 variant=b，样片页用来切版式）
 *   FILM_DPR    像素倍率（默认 1；手机竖屏样片用 2，否则 390 宽的画面糊）
 *   FILM_AUDIO  另有 none：不带音轨（首屏循环本来就是静音的）
 *   FILM_CHROMIUM  Chromium 可执行文件（默认用 playwright 自带的；版本对不上时指定，如 /opt/pw-browsers/chromium）
 *   FILM_STILLS 只出静帧不出视频，逗号分隔的秒数，如 "1.5,12.1,33"（审片用，输出到 FILM_OUT 同目录）
 *
 * 原理：起一个 vite dev server，用无头 Chromium 打开 scripts/film/render.html，
 * 逐帧调用页面上的 window.__film.seek(t) 截图并喂给 ffmpeg；配乐由同一页面用
 * OfflineAudioContext 渲染成 WAV。画面与声音都来自首页播放的那一份代码。
 * 这里不依赖 Playwright 自带的 ffmpeg——它是只带 VP8 的裁剪版，编不了 H.264 / AAC。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANG = process.env.FILM_LANG === 'en' ? 'en' : 'zh';
const FPS = Number(process.env.FILM_FPS || 30);
const OUT = path.resolve(process.env.FILM_OUT || path.join(os.tmpdir(), `map-film-${LANG}.mp4`));
const LIMIT = process.env.FILM_LIMIT ? Number(process.env.FILM_LIMIT) : null;
const AUDIO = process.env.FILM_AUDIO === 'synth' ? 'synth' : process.env.FILM_AUDIO === 'none' ? 'none' : 'track';
const PAGE = process.env.FILM_PAGE || 'scripts/film/render.html';
const [VW, VH] = (process.env.FILM_SIZE || '1920x1080').split('x').map(Number);
// 默认导出页把片子钉死在 1920x1080（片花本体按这块画布逐帧计算），不读 ?w=&h=；
// 这时给 FILM_SIZE 只会缩小浏览器视口、导出被裁掉的一角（Codex P2，PR #1650）。
// 只有像 hero-sample.html 这样会读 ?w=&h= 的导出页才接受别的尺寸。
if (PAGE === 'scripts/film/render.html' && (VW !== 1920 || VH !== 1080)) {
  console.error(`FILM_SIZE=${process.env.FILM_SIZE} 对默认导出页无效：片花固定 1920x1080。需要别的尺寸请导出后再缩放，或换一个读取 ?w=&h= 的导出页（FILM_PAGE）。`);
  process.exit(2);
}
const TRACK = path.join(ROOT, 'public', 'film', 'landing-score.mp3');
const STILLS = process.env.FILM_STILLS ? process.env.FILM_STILLS.split(',').map(Number).filter((x) => Number.isFinite(x)) : null;

function findFfmpeg() {
  const candidates = [process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.includes('libx264')) return bin;
    } catch {
      /* 下一个 */
    }
  }
  try {
    const bin = execFileSync('python3', ['-c', 'import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())'], { encoding: 'utf8' }).trim();
    if (bin) return bin;
  } catch {
    /* 落到下面的报错 */
  }
  throw new Error('找不到带 libx264 的 ffmpeg：设置 FFMPEG=<路径>，或 `pip install imageio-ffmpeg`');
}

/**
 * playwright 不是 prd-admin 的依赖（这是离线导出脚本，不该把它带进镜像构建与锁文件）。
 * 依次找：本目录能解析到的 → npm 全局目录（原有做法，保持不变）→ 仓库里正式声明了它的 cds 工作区（`cd cds && pnpm install`）。
 * 都找不到就明说该装在哪，不抛一个光秃秃的 ERR_MODULE_NOT_FOUND（Codex P1，PR #1650）。
 * ESM 不认 NODE_PATH，所以后两处都按文件路径解析后再 import。
 */
async function loadChromium() {
  const tried = [];
  try {
    return (await import('playwright')).chromium;
  } catch (e) {
    tried.push(`prd-admin: ${e.code ?? e.message}`);
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return (await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href)).chromium;
  } catch (e) {
    tried.push(`npm 全局: ${e.code ?? e.message}`);
  }
  const cdsManifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../cds/package.json');
  try {
    // createRequire 按 require 条件解析到 CJS 入口，具名导出挂在 default 上
    const mod = await import(pathToFileURL(createRequire(cdsManifest).resolve('playwright')).href);
    const chromium = mod.chromium ?? mod.default?.chromium;
    if (!chromium) throw new Error('cds 工作区的 playwright 没有导出 chromium');
    return chromium;
  } catch (e) {
    tried.push(`cds 工作区: ${e.code ?? e.message}`);
  }
  throw new Error(
    `找不到 playwright。在仓库根目录执行 \`cd cds && pnpm install\`（cds 工作区已声明它）后重试。\n已尝试：\n  ${tried.join('\n  ')}`,
  );
}

async function main() {
  // 只出静帧时用不到编码器：别因为机器上没有带 libx264 的 ffmpeg 就把截图也拦下（Codex P2，PR #1650）
  const ffmpeg = STILLS ? null : findFfmpeg();
  const chromium = await loadChromium();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const wavPath = OUT.replace(/\.mp4$/i, '') + '.wav';
  const posterPath = OUT.replace(/\.mp4$/i, '') + '-poster.jpg';

  // 关掉热更新与文件监听：导出要跑好几分钟，期间改任何源文件都会触发整页刷新，window.__film 当场消失
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { port: 0, hmr: false, watch: null },
    logLevel: 'warn',
  });
  await server.listen();
  const port = server.config.server.port ?? server.httpServer?.address()?.port;
  const url = `http://localhost:${port}/${PAGE}?lang=${LANG}&w=${VW}&h=${VH}${process.env.FILM_QUERY ? `&${process.env.FILM_QUERY}` : ''}`;

  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
    // 浏览器与 playwright 版本对不上时（如沙箱预装的 /opt/pw-browsers/chromium）可显式指定
    ...(process.env.FILM_CHROMIUM ? { executablePath: process.env.FILM_CHROMIUM } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: Number(process.env.FILM_DPR || 1) });
    page.on('pageerror', (err) => console.error('[page]', err.message));
    // 字体由 Node 侧用 curl 代取：受限网络里浏览器直连 Google Fonts 常被代理拒绝或证书不受信，
    // 而 curl 走系统信任库与 HTTPS_PROXY。取不到就放行给浏览器自己试，最差退回系统字体——并打一行日志，
    // 不静默（上一版导出的中文就是悄悄退到了文泉驿，没人发现）。
    let fontMisses = 0;
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (route) => {
      const url = route.request().url();
      try {
        const body = execFileSync('curl', ['-sS', '--fail', '--max-time', '30', '-A', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140 Safari/537.36', url], { maxBuffer: 64 * 1024 * 1024 });
        const contentType = url.includes('googleapis') ? 'text/css' : 'font/woff2';
        await route.fulfill({ status: 200, body, headers: { 'content-type': contentType, 'access-control-allow-origin': '*' } });
      } catch {
        fontMisses += 1;
        await route.continue();
      }
    });
    await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.__film), null, { timeout: 120_000 });
    // 字体没到就开拍，前几帧会是后备字体；等到 fonts.ready（取不到网络字体也会结束，不会卡死）
    await page.evaluate(() => window.__film.ready);
    await page.evaluate(() => document.fonts.ready);
    const fontCheck = await page.evaluate(() => ({
      sc: document.fonts.check('700 40px "Noto Sans SC"', '说'),
      inter: document.fonts.check('700 40px "Inter"', 'A'),
    }));
    console.log(`[film] 字体：Noto Sans SC ${fontCheck.sc ? '已加载' : '未加载'}，Inter ${fontCheck.inter ? '已加载' : '未加载'}，代取失败 ${fontMisses} 次`);

    const { duration, poster } = await page.evaluate(() => ({ duration: window.__film.duration, poster: window.__film.poster }));

    if (STILLS) {
      const base = OUT.replace(/\.mp4$/i, '');
      for (const t of STILLS) {
        await page.evaluate((x) => window.__film.seek(x), t);
        const file = `${base}-t${t.toFixed(2).replace('.', '_')}.jpg`;
        await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
        console.log(`[film] 静帧 ${t}s → ${file}`);
      }
      return;
    }
    const total = LIMIT ? Math.min(duration, LIMIT) : duration;

    let audioPath = TRACK;
    if (AUDIO === 'synth') {
      console.log(`[film] 合成配乐离线渲染中（${duration}s）…`);
      const wav = await page.evaluate(() => window.__film.renderAudio());
      fs.writeFileSync(wavPath, Buffer.from(wav, 'base64'));
      audioPath = wavPath;
    } else if (AUDIO === 'none') {
      audioPath = null;
    } else if (!fs.existsSync(TRACK)) {
      throw new Error(`找不到成品配乐 ${TRACK}：先跑 scripts/film/build-score.py，或用 FILM_AUDIO=synth`);
    }
    console.log(`[film] 配乐：${AUDIO === 'synth' ? '合成版' : AUDIO === 'none' ? '无（静音）' : '成品（scoreEdit.json 剪辑）'} ${audioPath ?? ''}`);

    await page.evaluate((t) => window.__film.seek(t), poster);
    await page.screenshot({ path: posterPath, type: 'jpeg', quality: 92 });

    const frames = Math.round(total * FPS);
    const fadeAt = Math.max(0, total - 1.2);
    const enc = spawn(
      ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        ...(audioPath ? ['-i', audioPath] : []),
        '-t', String(total),
        // 成品配乐自带收尾淡出；合成版与截短调试时才补一道
        ...(audioPath && (AUDIO === 'synth' || LIMIT) ? ['-af', `afade=t=out:st=${fadeAt}:d=1.2`] : []),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
        ...(audioPath ? ['-c:a', 'aac', '-b:a', '192k'] : []),
        '-movflags', '+faststart',
        OUT,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const done = new Promise((resolve, reject) => {
      enc.on('error', reject);
      enc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
    });

    const started = Date.now();
    for (let i = 0; i < frames; i += 1) {
      await page.evaluate((t) => window.__film.seek(t), i / FPS);
      const jpg = await page.screenshot({ type: 'jpeg', quality: 93 });
      if (!enc.stdin.write(jpg)) await new Promise((r) => enc.stdin.once('drain', r));
      if (i % FPS === 0) {
        const spent = (Date.now() - started) / 1000;
        const eta = i > 0 ? Math.round((spent / i) * (frames - i)) : '?';
        process.stdout.write(`\r[film] 帧 ${i}/${frames}  已用 ${spent.toFixed(0)}s  预计还需 ${eta}s   `);
      }
    }
    enc.stdin.end();
    await done;
    console.log(`\n[film] 完成：${OUT}\n[film] 海报：${posterPath}\n[film] 音轨：${audioPath}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
