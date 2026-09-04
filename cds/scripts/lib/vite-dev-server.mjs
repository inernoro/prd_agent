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
  let seen = '';

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
      const timer = setTimeout(() => reject(new Error(`vite dev server ${timeoutMs}ms 没起来：${seen.slice(-300) || '（没有任何输出）'}`)), timeoutMs);
      const onData = (buf) => {
        // 累积后再判：就绪行可能被切在两个 chunk 里；同时剥掉 ANSI，
        // 因为 vite 会给耗时数字加粗（`ready in \e[1m412\e[22m ms`）。
        seen += buf.toString().replace(/\u001b\[[0-9;]*m/g, '');
        const text = seen;
        /*
         * 只认 vite 自己那行 `ready in ...`，关键是**词边界**。
         *
         * 两个坑叠在一起：① 旧判据把「输出里出现了端口号」也当就绪，而端口
         * 被占时的错误信息里同样带着端口号；② 去掉 ① 之后仍然误判——因为
         * `Port 5299 is already in use` 里 **already in** 含有子串 `ready in`。
         * 两者任一命中，整套布局判据就会对着**另一个进程**的响应跑完并全绿
         * （实测：拿到占位服务器返回的 IMPOSTOR，判据无一报错）。
         *
         * 不要求紧跟数字：vite 会给耗时加粗，ANSI 码正好插在 `in ` 和数字
         * 之间，要求 `\d+` 会在 CI 上整个匹配不上（实测 30s 超时）。
         * `\b` 已经足够把 `already in use` 排除——`already` 里 r 前面是 l，
         * 不构成词边界。
         */
        if (/\bready in\b/.test(text)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`vite 退出，code=${code}`)); });
    });
  } catch (err) {
    stop();
    throw err;
  }
  // dev server 的第一个请求要现编译，给它一点时间再开始量。
  await new Promise((r) => setTimeout(r, 1500));
  return { url, stop };
}
