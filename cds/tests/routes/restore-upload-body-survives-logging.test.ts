import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';

/**
 * E42 的另一半：**上传的 body 在到达路由之前就被日志中间件读光了**。
 *
 * 恢复接口报「已恢复」、耗时 4 秒、库里一张表都没有。管道退出码那一处修完之后，
 * 拿一个 113 字节的合法 gz 再试，仍然什么都没落地——说明问题在更前面：body 根本
 * 没到路由手里。
 *
 * 机制：master 的 HTTP 日志中间件为了记录请求体挂了 `req.on('data')`，这一下把
 * 请求流切进 flowing 模式。**同一个 tick 里**挂上的消费者（路由自带的 json 解析器）
 * 照样收得到数据，所以几乎所有接口都毫无异样；但**跨过 await 之后**才 `req.pipe()`
 * 的路由，等它 pipe 时 body 已经流完了，落到文件里是 0 字节。
 *
 * 这里用真的 express + 真的 HTTP 请求复现这个时序，而不是读源码找关键字——
 * 「谁先谁后」这种事只有跑起来才看得出来。
 */
async function measureUploadedBytes(opts: { pauseFirst: boolean }): Promise<number> {
  const app = express();
  let captured = 0;

  // 复刻 master 的日志中间件：只挂 data 监听、不做别的。
  app.use((req, _res, next) => {
    req.on('data', (c: Buffer) => { captured += c.length; });
    next();
  });

  const dir = fs.mkdtempSync(path.join(process.cwd(), 'node_modules/.tmp-upload-'));
  const target = path.join(dir, 'upload.bin');
  let written = -1;

  app.post('/restore', async (req, res) => {
    if (opts.pauseFirst) req.pause();
    // 路由在真正读 body 之前要先做几件异步的事（解析服务、探测备份目录、docker 探测…）。
    await new Promise((r) => setTimeout(r, 20));
    await new Promise<void>((resolve, reject) => {
      const w = fs.createWriteStream(target);
      req.pipe(w);
      w.on('finish', () => resolve());
      w.on('error', reject);
      req.on('error', reject);
    });
    written = fs.statSync(target).size;
    res.json({ ok: true });
  });

  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    const body = Buffer.alloc(64 * 1024, 7);
    const resp = await fetch(`http://127.0.0.1:${port}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    expect(resp.status).toBe(200);
    return written;
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    void captured;
  }
}

describe('恢复接口的上传 body 不能被日志中间件吃掉', () => {
  it('事故原形：不 pause，跨过 await 再 pipe —— 落盘 0 字节，而 HTTP 仍是 200', async () => {
    // 这一条描述的是**修之前**的真实行为。它证明「假成功」不需要任何报错就能发生。
    expect(await measureUploadedBytes({ pauseFirst: false })).toBe(0);
  });

  it('进函数先 req.pause()：body 完整落盘', async () => {
    expect(await measureUploadedBytes({ pauseFirst: true })).toBe(64 * 1024);
  });
});

/**
 * 接线守卫：**每一个**自己读原始请求体的路由都要过这一关。
 *
 * 判据不是「有没有挂 data 监听」，而是「路由从进函数到 `req.pipe()` 之间跨没跨 await」。
 * 同 tick 挂上消费者不丢数据（forwarder 的 proxy-handler 就是这样，所以它没事）；
 * 一旦中间有 await，body 就已经被日志中间件读走了。所以这里扫全部 `req.pipe(` 的
 * 调用点，逐个判它所在的路由：跨了 await 的，必须先 `req.pause()`。
 */
describe('凡是自己读原始 body 的路由，都不许跨 await 才读', () => {
  const ROUTE_DIR = path.resolve(process.cwd(), 'src/routes');

  /** 剔掉注释行——注释里也会出现 await 这个词（就在被守的那几段说明里）。 */
  const stripComments = (s: string): string => s
    .split('\n')
    .map((l) => (/^\s*(\/\/|\/?\*)/.test(l) ? '' : l))
    .join('\n');

  it('每个 req.pipe( 调用点，要么同 tick、要么先 pause', () => {
    const files = fs.readdirSync(ROUTE_DIR).filter((f) => f.endsWith('.ts'));
    const checked: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(path.join(ROUTE_DIR, f), 'utf8'));
      for (let i = src.indexOf('req.pipe('); i >= 0; i = src.indexOf('req.pipe(', i + 1)) {
        // 往回找这条 pipe 所属的路由起点（最近的一个 router.<verb>( 之前）。
        const head = src.lastIndexOf('router.', i);
        expect(head, `${f}: req.pipe 找不到所属路由`).toBeGreaterThan(-1);
        const body = src.slice(head, i);
        const firstAwait = body.indexOf('await ');
        const pause = body.indexOf('req.pause();');
        checked.push(`${f}@${head}`);
        if (firstAwait === -1) continue;            // 同 tick，安全
        expect(pause, `${f}: 该路由跨了 await 才读 body，必须先 req.pause()`).toBeGreaterThan(-1);
        expect(pause, `${f}: req.pause() 必须排在第一次 await 之前`).toBeLessThan(firstAwait);
      }
    }
    // 扫不到任何调用点时这条会静默全绿——那是「不会红的证据」，比没有证据更糟。
    expect(checked.length, '一个 req.pipe( 都没扫到，守卫多半失效了').toBeGreaterThanOrEqual(4);
  });
});
