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
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: WEB_DIR, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = `http://127.0.0.1:${port}`;
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
  // dev server 的第一个请求要现编译，给它一点时间再开始量。
  await new Promise((r) => setTimeout(r, 1500));
  return { url, stop: () => child.kill('SIGTERM') };
}
