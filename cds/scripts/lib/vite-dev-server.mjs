/*
 * 给布局探针用的 vite dev server 启动器。
 *
 * 抽出来是因为两个探针（上手向导可达性、整页窄屏冒烟）都要在 CI 上起同一个
 * 前端，各写一份就是判据分裂的开头（predicate-and-wiring-discipline 形状 3）。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../web');

/**
 * 起一个 vite dev server，返回 { url, stop }。
 * 端口随机，避免同一台机器上两个探针并行时撞端口。
 */
export async function startViteDevServer({ timeoutMs = 30000 } = {}) {
  const port = 5100 + Math.floor(Math.random() * 400);
  /*
   * detached 是为了让 stop() 能收掉整棵进程树。
   *
   * `pnpm exec vite` 自己是个包装进程，真正的 vite 是它的孙子；只 SIGTERM
   * 这个 child，vite 会活下来继续占着端口，而端口是 strictPort——下一次跑
   * 直接起不来。实测过：只把 launch 挪进 try（Codex P2 指出的那一层）之后
   * 仍然残留两个进程，必须连进程组一起收。
   */
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const url = `http://127.0.0.1:${port}`;

  const stop = () => {
    try {
      // 负号 = 整个进程组；进程已退出时会抛 ESRCH，退回单进程 kill 即可。
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch { /* 已经没了 */ }
    }
  };

  /*
   * stop 必须在等待就绪**之前**就定义好，并且失败路径要先收进程组再抛。
   *
   * 上一版把 stop 定义在 await 之后：vite 起来了却没吐出就绪字样时，这里
   * 直接 reject，调用方拿不到 stop，那个 detached 进程组就没人收了——
   * 「浏览器起不来」那条路径修好了，「就绪超时」这条照漏（Codex P2）。
   */
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`vite dev server ${timeoutMs}ms 没起来`)), timeoutMs);
      const onData = (buf) => {
        const text = buf.toString();
        if (text.includes('ready in') || text.includes(String(port))) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`vite 退出，code=${code}`)); });
    });
  } catch (err) {
    throw err;
  }
  // dev server 的第一个请求要现编译，给它一点时间再开始量。
  await new Promise((r) => setTimeout(r, 1500));
  return { url, stop };
}
