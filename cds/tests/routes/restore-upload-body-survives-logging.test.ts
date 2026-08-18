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

/** 接线守卫：pause 必须真的写在恢复路由里，且排在第一次 await 之前。 */
describe('恢复路由确实先按住流', () => {
  const SRC = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/infra-backup.ts'), 'utf8');

  it('restore 路由体的第一句就是 req.pause()，在任何 await 之前', () => {
    const start = SRC.indexOf("router.post('/infra/:id/restore'");
    expect(start).toBeGreaterThan(0);
    // 注释里也会出现「await」这个词（就在被守的那段说明里），拿原文搜等于在守自己的
    // 措辞。先把注释行剔掉，判据才落在真正会执行的代码上。
    const body = SRC.slice(start, SRC.indexOf("router.get('/infra/:id/backup-history'"))
      .split('\n')
      .map((l) => (/^\s*(\/\/|\/?\*)/.test(l) ? '' : l))
      .join('\n');
    const pause = body.indexOf('req.pause();');
    const firstAwait = body.indexOf('await ');
    expect(pause, '恢复路由必须调用 req.pause()').toBeGreaterThan(0);
    // 位置就是判据本身：挪到 await 后面等于没修——body 那时已经流完了。
    expect(pause, 'req.pause() 必须排在第一次 await 之前').toBeLessThan(firstAwait);
  });
});
