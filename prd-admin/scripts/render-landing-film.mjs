import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

/*
 * 首页片花 → MP4 导出。
 *
 * 用法（在 prd-admin 目录下）：
 *   node scripts/render-landing-film.mjs                    # 中文，1080p30，输出到系统临时目录
 *   FILM_LANG=en FILM_FPS=60 FILM_OUT=./film-en.mp4 node scripts/render-landing-film.mjs
 *
 * 可选环境变量：
 *   FILM_LANG   zh | en（默认 zh）
 *   FILM_FPS    帧率（默认 30）
 *   FILM_OUT    输出 mp4 路径（默认 <tmp>/map-film-<lang>.mp4，同目录另出一张海报 jpg）
 *   FFMPEG      ffmpeg 可执行文件（默认先找 PATH，再找 python imageio-ffmpeg 自带的静态包）
 *   FILM_LIMIT  只渲染前 N 秒（调试用）
 *   FILM_AUDIO  track | synth（默认 track：用 public/film/landing-score.mp3 那段剪好的成品配乐；
 *               synth：用 filmScore 离线合成的备用配乐——页面上配乐加载失败时放的就是它）
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
const AUDIO = process.env.FILM_AUDIO === 'synth' ? 'synth' : 'track';
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

/** playwright 不在 prd-admin 的依赖里（与 landing-seam-audit 等脚本一样用全局安装的那份）；ESM 不认 NODE_PATH，所以回落到 npm 全局目录。 */
async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    return (await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href)).chromium;
  }
}

async function main() {
  const ffmpeg = findFfmpeg();
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
  const url = `http://localhost:${port}/scripts/film/render.html?lang=${LANG}`;

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
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
    } else if (!fs.existsSync(TRACK)) {
      throw new Error(`找不到成品配乐 ${TRACK}：先跑 scripts/film/build-score.py，或用 FILM_AUDIO=synth`);
    }
    console.log(`[film] 配乐：${AUDIO === 'synth' ? '合成版' : '成品（scoreEdit.json 剪辑）'} ${audioPath}`);

    await page.evaluate((t) => window.__film.seek(t), poster);
    await page.screenshot({ path: posterPath, type: 'jpeg', quality: 92 });

    const frames = Math.round(total * FPS);
    const fadeAt = Math.max(0, total - 1.2);
    const enc = spawn(
      ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        '-i', audioPath,
        '-t', String(total),
        // 成品配乐自带收尾淡出；合成版与截短调试时才补一道
        ...(AUDIO === 'synth' || LIMIT ? ['-af', `afade=t=out:st=${fadeAt}:d=1.2`] : []),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
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
