/**
 * Remotion 单镜渲染微服务
 *
 * 职责：把 prd-api 容器（dotnet/sdk）从"既要 dotnet 又要 Node + Chromium"的
 * 混合容器架构里解放出来。renderer 容器自带 Node 20 + 系统 Chromium + Remotion
 * 项目源码，通过 Express HTTP 接收 prd-api 的渲染请求。
 *
 * 端点：
 *   GET  /health                    健康检查
 *   POST /render/scene  body: 单镜  → 200 mp4 binary | 500 {ok,error}
 *
 * 失败模式：
 *   - 子进程 exit code != 0  → 500 + stderr 摘要
 *   - 5 分钟超时             → 500 + "render timeout"
 *   - prd-video 目录缺失     → 500 + "PRD_VIDEO_PATH not found"
 */
import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';

const PORT = Number(process.env.PORT) || 5001;
const PRD_VIDEO_PATH = process.env.PRD_VIDEO_PATH || '/prd-video';
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 5 * 60 * 1000;
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || '5mb';

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const tail = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[${ts}] [${level}] ${msg}${tail}`);
}

function ensurePrdVideoReady(): { ok: true } | { ok: false; reason: string } {
  if (!fs.existsSync(PRD_VIDEO_PATH)) {
    return { ok: false, reason: `PRD_VIDEO_PATH not found: ${PRD_VIDEO_PATH}` };
  }
  const nm = path.join(PRD_VIDEO_PATH, 'node_modules');
  if (!fs.existsSync(nm)) {
    return { ok: false, reason: `${PRD_VIDEO_PATH}/node_modules missing — pnpm install not run yet` };
  }
  const remotionDir = path.join(nm, 'remotion');
  if (!fs.existsSync(remotionDir)) {
    return { ok: false, reason: `Remotion not installed in ${PRD_VIDEO_PATH}/node_modules` };
  }
  return { ok: true };
}

const app = express();
app.use(express.json({ limit: MAX_BODY_SIZE }));

app.get('/health', (_req, res) => {
  const ready = ensurePrdVideoReady();
  res.json({
    ok: ready.ok,
    prdVideoPath: PRD_VIDEO_PATH,
    chromium: process.env.CHROMIUM_EXECUTABLE_PATH || '(remotion-default)',
    reason: ready.ok ? undefined : ready.reason,
  });
});

interface RenderSceneRequest {
  compositionId?: string;
  title?: string;
  scene: {
    index?: number;
    topic?: string;
    narration?: string;
    visualDescription?: string;
    durationSeconds?: number;
    durationInFrames?: number;
    sceneType?: string;
    backgroundImageUrl?: string | null;
    hasGeneratedCode?: boolean;
  };
}

/** 通用渲染：把 props 写到临时文件 → fork `npx remotion render <compositionId> <out> --props=<file>` */
async function renderComposition(opts: {
  compositionId: string;
  props: unknown;
  requestId: string;
  res: express.Response;
  metaForLog?: Record<string, unknown>;
}) {
  const { compositionId, props, requestId, res, metaForLog } = opts;
  const start = Date.now();

  const ready = ensurePrdVideoReady();
  if (!ready.ok) {
    log('error', 'render aborted: env not ready', { requestId, reason: ready.reason });
    res.status(500).json({ ok: false, error: ready.reason });
    return;
  }

  log('info', 'render start', { requestId, compositionId, ...metaForLog });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const propsFile = path.join(tmpDir, 'props.json');
  const outFile = path.join(tmpDir, 'out.mp4');

  try {
    fs.writeFileSync(propsFile, JSON.stringify(props));
  } catch (err) {
    log('error', 'write props failed', { requestId, err: String(err) });
    res.status(500).json({ ok: false, error: 'failed to write props: ' + String(err) });
    cleanup(tmpDir);
    return;
  }

  const args = ['remotion', 'render', compositionId, outFile, `--props=${propsFile}`];
  const proc = spawn('npx', args, {
    cwd: PRD_VIDEO_PATH,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  let stdout = '';
  proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  const timeoutHandle = setTimeout(() => {
    log('warn', 'render timeout, killing subprocess', { requestId, elapsedMs: Date.now() - start });
    try { proc.kill('SIGKILL'); } catch { /* best effort */ }
  }, RENDER_TIMEOUT_MS);

  proc.on('exit', (code, signal) => {
    clearTimeout(timeoutHandle);
    const elapsedMs = Date.now() - start;
    const isTimeout = signal === 'SIGKILL' && elapsedMs >= RENDER_TIMEOUT_MS - 1000;

    if (code === 0 && fs.existsSync(outFile)) {
      try {
        const buf = fs.readFileSync(outFile);
        log('info', 'render done', { requestId, elapsedMs, bytes: buf.length });
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('X-Render-Elapsed-Ms', String(elapsedMs));
        res.setHeader('X-Render-Request-Id', requestId);
        res.status(200).send(buf);
      } catch (err) {
        log('error', 'read output failed', { requestId, err: String(err) });
        res.status(500).json({ ok: false, error: 'failed to read output: ' + String(err) });
      }
    } else {
      const errMsg = isTimeout
        ? `Remotion render timeout (>${Math.round(RENDER_TIMEOUT_MS / 1000)}s)`
        : `Remotion exit ${code} signal=${signal}`;
      const detail = stderr.length > 1500 ? stderr.slice(-1500) : stderr;
      log('error', 'render failed', { requestId, elapsedMs, code, signal, stderrLen: stderr.length });
      res.status(500).json({
        ok: false,
        error: errMsg,
        stderr: detail,
        stdout: stdout.length > 500 ? stdout.slice(-500) : stdout,
      });
    }
    cleanup(tmpDir);
  });

  proc.on('error', (err) => {
    clearTimeout(timeoutHandle);
    log('error', 'spawn npx failed', { requestId, err: String(err) });
    res.status(500).json({ ok: false, error: 'failed to spawn npx: ' + String(err) });
    cleanup(tmpDir);
  });
}

app.post('/render/scene', async (req, res) => {
  const requestId = crypto.randomBytes(4).toString('hex');
  const body = req.body as RenderSceneRequest;
  if (!body || !body.scene) {
    res.status(400).json({ ok: false, error: 'body.scene required' });
    return;
  }
  await renderComposition({
    compositionId: body.compositionId || 'SingleScene',
    props: body,
    requestId,
    res,
    metaForLog: { sceneIndex: body.scene.index, durationFrames: body.scene.durationInFrames },
  });
});

/**
 * 多镜整段渲染：用于最终导出 (TutorialVideo composition)。
 * body 与 prd-video src/types.ts 的 VideoData 结构一致：
 *   { title, fps, width, height, scenes: [...], enableTts? }
 */
app.post('/render/full', async (req, res) => {
  const requestId = crypto.randomBytes(4).toString('hex');
  const body = req.body as { compositionId?: string; scenes?: unknown[] };
  if (!body || !Array.isArray(body.scenes) || body.scenes.length === 0) {
    res.status(400).json({ ok: false, error: 'body.scenes required (non-empty array)' });
    return;
  }
  await renderComposition({
    compositionId: body.compositionId || 'TutorialVideo',
    props: body,
    requestId,
    res,
    metaForLog: { sceneCount: body.scenes.length },
  });
});

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const server = app.listen(PORT, () => {
  log('info', `prd-video-renderer listening on :${PORT}`, {
    prdVideoPath: PRD_VIDEO_PATH,
    chromium: process.env.CHROMIUM_EXECUTABLE_PATH || '(default)',
    timeoutSec: Math.round(RENDER_TIMEOUT_MS / 1000),
  });
});

// 优雅关闭
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, closing server');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  log('info', 'SIGINT received, closing server');
  server.close(() => process.exit(0));
});
