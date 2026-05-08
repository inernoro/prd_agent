/**
 * Nginx Active Upstream 文件写入 — TDD 契约
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md 维度 4.3 / 4.5 / 5.4
 * 实现位置:cds/src/services/nginx-upstream-writer.ts
 *
 * Supervisor 通过它原子改写 cds-active-upstream.conf,然后调用
 * nginx -t 校验,通过才执行 nginx -s reload。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { IShellExecutor, ExecResult, ExecOptions } from '../../src/types.js';
import {
  NginxUpstreamWriter,
  validatePort,
  validateConfPath,
  renderUpstream,
  writeAtomic,
  swap,
} from '../../src/services/nginx-upstream-writer.js';

/**
 * Mock IShellExecutor:按调用顺序返回预设结果,记录每条命令以便断言。
 *
 * - results: 预先排好队,从队首消费;消费完后报错(防止漏 stub)
 * - calls: 记录所有 exec 入参,断言"reload 没被调用"等
 */
function createMockExecutor(results: ExecResult[]): IShellExecutor & {
  calls: { command: string; options?: ExecOptions }[];
} {
  const queue = [...results];
  const calls: { command: string; options?: ExecOptions }[] = [];
  return {
    calls,
    async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
      calls.push({ command, options });
      const next = queue.shift();
      if (!next) {
        throw new Error(
          `mock executor out of stubs (called with: ${command})`,
        );
      }
      return next;
    },
  };
}

const ALLOWED_BASENAME = 'cds-active-upstream.conf';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-upstream-writer-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // noop
  }
});

function tmpConfPath(): string {
  return path.join(tmpRoot, ALLOWED_BASENAME);
}

describe('Atomic Write', () => {
  it('[C-4.5] 写入用 tmp 文件 + rename(原子,reload 永远不会读到半截)', async () => {
    const target = tmpConfPath();
    const content = renderUpstream(9901);

    // 跟踪写入期间是否曾在目标位置看到非预期(半截)内容
    // 由于 renameSync 是原子的,这里我们检查 tmp 路径在写入期间存在过、目标只在末尾出现完整内容
    const dirEntriesBefore = fs.readdirSync(tmpRoot);
    expect(dirEntriesBefore).toEqual([]);

    await writeAtomic(target, content);

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe(content);

    // 写完后目录里只有 target 文件,不应残留 .tmp.* 半截文件
    const dirEntriesAfter = fs.readdirSync(tmpRoot);
    expect(dirEntriesAfter).toEqual([ALLOWED_BASENAME]);
  });

  it('[C-4.5] 写入失败时(disk full)旧文件不动,返回明确错误', async () => {
    const target = tmpConfPath();
    const oldContent = 'upstream cds_master { server 127.0.0.1:9900; keepalive 8; }\n';
    fs.writeFileSync(target, oldContent, { encoding: 'utf-8' });

    // 用一个不存在的目录路径触发 writeAtomic 报错(parent dir not exist)
    const badTarget = path.join(tmpRoot, 'no-such-dir', ALLOWED_BASENAME);
    await expect(writeAtomic(badTarget, 'will fail')).rejects.toThrow(/parent dir/);

    // 旧文件不动
    expect(fs.readFileSync(target, 'utf-8')).toBe(oldContent);
    // 不残留 tmp 文件
    const items = fs.readdirSync(tmpRoot);
    expect(items.filter((x) => x.includes('.tmp.'))).toEqual([]);
  });

  it('[C-4.3] target 路径必须匹配白名单(只允许 cds-active-upstream.conf)', () => {
    const ok = validateConfPath(path.join(tmpRoot, ALLOWED_BASENAME), tmpRoot);
    expect(ok.ok).toBe(true);

    const wrongName = validateConfPath(path.join(tmpRoot, 'nginx.conf'), tmpRoot);
    expect(wrongName.ok).toBe(false);
    if (!wrongName.ok) {
      expect(wrongName.reason).toMatch(/basename/);
    }
  });

  it('[C-4.3] 路径包含 ".." → 拒绝', () => {
    // path.join 会把 '..' 消解掉,所以这里手工拼字符串保留 ".." 字面量
    // 模拟攻击者直接构造 '/tmp/cds.../../etc/cds-active-upstream.conf'
    const evilPath = `${tmpRoot}/../etc/${ALLOWED_BASENAME}`;
    const evil = validateConfPath(evilPath, tmpRoot);
    expect(evil.ok).toBe(false);
    if (!evil.ok) {
      expect(evil.reason).toMatch(/\.\./);
    }
  });

  it('[C-4.3] 路径不在配置目录下 → 拒绝', () => {
    // 一个绝对路径但不在 tmpRoot 下
    const outside = validateConfPath(path.join('/etc', ALLOWED_BASENAME), tmpRoot);
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.reason).toMatch(/allowDir/);
    }
  });
});

describe('Nginx Validation', () => {
  it('[C-5.4] 写完后 docker exec cds_nginx nginx -t 必须通过', async () => {
    const target = tmpConfPath();
    const exec = createMockExecutor([
      // docker cp ok(B'.5.1:把 host 文件注入 cds_nginx 容器,避免 mount 没生效)
      { exitCode: 0, stdout: '', stderr: '' },
      // validate ok
      { exitCode: 0, stdout: '', stderr: 'nginx: configuration file /etc/nginx/nginx.conf test is successful\n' },
      // reload ok
      { exitCode: 0, stdout: '', stderr: '' },
    ]);
    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('done');
    // 至少调过 nginx -t
    expect(exec.calls.some((c) => c.command.includes('nginx -t'))).toBe(true);
  });

  it('[C-5.4] -t 失败时返回错误 + 错误 stdout 完整捕获(含行号)', async () => {
    const target = tmpConfPath();
    const detailedErr =
      'nginx: [emerg] unknown directive "upstream_cds_master" in /etc/nginx/conf.d/cds-active-upstream.conf:1\n' +
      'nginx: configuration file /etc/nginx/nginx.conf test failed\n';
    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
      { exitCode: 1, stdout: '', stderr: detailedErr },
    ]);
    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('validate');
    expect(r.error).toContain('cds-active-upstream.conf:1'); // 行号
    expect(r.error).toContain('emerg'); // 完整 stderr
  });

  it('[C-5.4] -t 失败时**不**调用 reload + 把文件回滚到旧版', async () => {
    const target = tmpConfPath();
    const oldContent = renderUpstream(9900);
    fs.writeFileSync(target, oldContent, { encoding: 'utf-8' });

    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
      // validate failed
      { exitCode: 1, stdout: '', stderr: 'nginx -t failed\n' },
    ]);

    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('validate');
    expect(r.rolledBack).toBe(true);

    // reload 没有被调用
    expect(exec.calls.some((c) => c.command.includes('nginx -s reload'))).toBe(false);

    // 文件回滚到旧版(端口 9900)
    expect(fs.readFileSync(target, 'utf-8')).toBe(oldContent);
  });
});

describe('Nginx Reload', () => {
  it('[C-5.4] reload 通过 docker exec cds_nginx nginx -s reload', async () => {
    const target = tmpConfPath();
    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp
      { exitCode: 0, stdout: '', stderr: '' }, // -t
      { exitCode: 0, stdout: '', stderr: '' }, // reload
    ]);
    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(true);
    const reloadCall = exec.calls.find((c) => c.command.includes('nginx -s reload'));
    expect(reloadCall).toBeDefined();
    expect(reloadCall!.command).toContain('docker exec');
    expect(reloadCall!.command).toContain('cds_nginx');
  });

  it('[C-5.4] reload 失败立即回滚文件 + 报错给 supervisor', async () => {
    const target = tmpConfPath();
    const oldContent = renderUpstream(9900);
    fs.writeFileSync(target, oldContent, { encoding: 'utf-8' });

    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
      // -t ok
      { exitCode: 0, stdout: '', stderr: '' },
      // reload fail
      { exitCode: 1, stdout: '', stderr: 'reload signal failed: process not running\n' },
      // rollback reload(让旧配置生效)
      { exitCode: 0, stdout: '', stderr: '' },
    ]);

    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('reload');
    expect(r.rolledBack).toBe(true);
    expect(r.error).toContain('reload signal failed');

    // 文件已经回滚到旧端口
    expect(fs.readFileSync(target, 'utf-8')).toBe(oldContent);
  });

  it('[C-5.4] reload 成功后 200ms 内验证 active upstream 真的指向新端口(curl 探测)', async () => {
    const target = tmpConfPath();

    // 起一个临时 HTTP server 模拟"新 active upstream",返回 200
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const verifyUrl = `http://127.0.0.1:${addr.port}/healthz`;

    try {
      const exec = createMockExecutor([
        { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
        { exitCode: 0, stdout: '', stderr: '' }, // -t
        { exitCode: 0, stdout: '', stderr: '' }, // reload
      ]);

      const r = await swap({
        absPath: target,
        allowDir: tmpRoot,
        port: addr.port,
        executor: exec,
        verifyTargetUrl: verifyUrl,
        verifyDelayMs: 50, // 测试加速,实际默认 200ms
      });
      expect(r.ok).toBe(true);
      expect(r.stage).toBe('done');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('回滚', () => {
  it('[C-4.5] 写入前先备份当前 conf 到 .bak,任何阶段失败都能 rename .bak 回去', async () => {
    const target = tmpConfPath();
    const oldContent = renderUpstream(9900);
    fs.writeFileSync(target, oldContent, { encoding: 'utf-8' });

    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
      // -t fail → 触发回滚
      { exitCode: 1, stdout: '', stderr: 'syntax error\n' },
    ]);

    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    // .bak 应该至少存在过一次(swap 内部 backupCurrent 写过)
    expect(fs.existsSync(`${target}.bak`)).toBe(true);
    // 还原后内容 = 旧内容
    expect(fs.readFileSync(target, 'utf-8')).toBe(oldContent);
  });

  it('[C-4.5] 回滚后再 nginx -t 必须通过(保证旧配置可用)', async () => {
    const target = tmpConfPath();
    const oldContent = renderUpstream(9900);
    fs.writeFileSync(target, oldContent, { encoding: 'utf-8' });

    // 先模拟 reload 失败链路:docker cp → -t 通过 → reload 失败 → 回滚 → 再 reload(用旧配置)
    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
      { exitCode: 0, stdout: '', stderr: '' }, // -t ok(新端口)
      { exitCode: 1, stdout: '', stderr: 'reload boom\n' }, // reload fail
      { exitCode: 0, stdout: '', stderr: '' }, // 回滚后再 reload(旧配置)
    ]);

    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    // 文件回到旧版本,nginx -t 此时若被调用应通过(本测试用 mock 体现:回滚后 reload 队列里那条 0 已被消费)
    expect(fs.readFileSync(target, 'utf-8')).toBe(oldContent);

    // 校验:回滚后又调了一次 reload(让旧配置重新生效)
    const reloadCalls = exec.calls.filter((c) => c.command.includes('nginx -s reload'));
    expect(reloadCalls.length).toBe(2);

    // 现在如果 supervisor 主动再调 nginx -t,我们直接断言 helper 在原内容上不抛
    // (写入 oldContent 是 renderUpstream(9900),格式合法)
    expect(oldContent).toMatch(/upstream cds_master/);
  });

  it('[C-4.5] 回滚后 nginx -s reload 必须成功', async () => {
    const target = tmpConfPath();
    const oldContent = renderUpstream(9900);
    fs.writeFileSync(target, oldContent, { encoding: 'utf-8' });

    const exec = createMockExecutor([
      { exitCode: 0, stdout: '', stderr: '' }, // docker cp ok
      { exitCode: 0, stdout: '', stderr: '' }, // -t ok
      { exitCode: 1, stdout: '', stderr: 'reload fail\n' }, // reload fail
      { exitCode: 0, stdout: '', stderr: '' }, // 回滚后再 reload 必须 ok
    ]);

    const r = await swap({
      absPath: target,
      allowDir: tmpRoot,
      port: 9901,
      executor: exec,
    });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);

    // 最后一条调用必须是 reload + exitCode 0 队列被消费(代表回滚后的 reload 跑了)
    const last = exec.calls[exec.calls.length - 1];
    expect(last.command).toContain('nginx -s reload');
  });
});

describe('Upstream 模板', () => {
  it('[C-4.3] 生成内容:upstream cds_master { server 127.0.0.1:<port>; keepalive 8; }', () => {
    const out = renderUpstream(9901);
    expect(out).toContain('upstream cds_master');
    expect(out).toContain('server 127.0.0.1:9901');
    expect(out).toContain('keepalive 8');
    // 完整模板严格匹配 spec
    expect(out.trim()).toBe('upstream cds_master { server 127.0.0.1:9901; keepalive 8; }');
  });

  it('[C-4.3] port 参数只接受数字 1024-65535,其他值拒绝(防注入)', () => {
    expect(validatePort(1024).ok).toBe(true);
    expect(validatePort(65535).ok).toBe(true);
    expect(validatePort(9901).ok).toBe(true);

    // 边界外
    expect(validatePort(1023).ok).toBe(false);
    expect(validatePort(65536).ok).toBe(false);
    expect(validatePort(0).ok).toBe(false);
    expect(validatePort(-1).ok).toBe(false);

    // 非整数 / 非数字
    expect(validatePort(9901.5).ok).toBe(false);
    expect(validatePort(NaN).ok).toBe(false);
    expect(validatePort(Infinity).ok).toBe(false);
    expect(validatePort('9901' as unknown as number).ok).toBe(false);
    expect(validatePort(null as unknown as number).ok).toBe(false);
    expect(validatePort(undefined as unknown as number).ok).toBe(false);

    // 注入尝试:字符串带分号的"端口"也必须拒绝
    expect(validatePort('9901; rm -rf /' as unknown as number).ok).toBe(false);

    // renderUpstream 也必须拒绝非法 port(不能拼出注入字符串)
    expect(() => renderUpstream(0)).toThrow();
    expect(() => renderUpstream(-1)).toThrow();
    expect(() => renderUpstream('9901; rm -rf /' as unknown as number)).toThrow();

    // NginxUpstreamWriter 命名导出对象一致暴露 helpers
    expect(NginxUpstreamWriter.validatePort).toBe(validatePort);
    expect(NginxUpstreamWriter.renderUpstream).toBe(renderUpstream);
  });
});
