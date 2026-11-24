import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `exec_cds.sh init` 写的四个凭据键必须整组落地。
 *
 * 主干原来是一次 `cat > "$ENV_FILE"` 整文件替换，同时保证了两件事：别的进程插不进来，
 * 自己中途失败也不会留下半套。改成逐键之后这两条都得单独补——锁补的是前者，
 * 单次 rename 补的是后者。四个键各自 rename 的话，第二个失败或进程恰好在两次之间退出，
 * .cds.env 就停在「新用户名配旧口令」上，备份留着却没有任何人去恢复，
 * 下次启动直接登不进仪表盘（Codex P1，2026-09-16；config-runtime-drift 要求源头改动原子）。
 *
 * 判据走真跑而不是扫源码：把函数从脚本里取出来在 bash 里执行，
 * 用影子 awk 在中间那个键上制造失败，断言 .cds.env 逐字节未变。
 */
const SCRIPT = path.join(process.cwd(), 'exec_cds.sh');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-env-atomic-'));

afterAll(() => { fs.rmSync(workdir, { recursive: true, force: true }); });

const ORIGINAL = "export CDS_SECRET_KEY='keep-me'\nexport CDS_USERNAME='old-user'\nexport CDS_PASSWORD='old-pass'\n";

function run(envFile: string, failOnAwkCall: number): { code: number } {
  const program = [
    'set -u',
    'err() { printf "[ERR] %s\\n" "$*" >&2; }',
    `eval "$(sed -n '/^env_upsert_many_locked() {/,/^}/p' "$1")"`,
    'ENV_FILE="$2"',
    // 影子 awk：第 N 次调用失败，模拟「写到一半炸了」。
    // 先把目标存进变量——函数体里的 $3 是 awk 自己的第三个参数，不是外层脚本的。
    'AWK_CALLS=0',
    'FAIL_AT="$3"',
    'if [ "$FAIL_AT" -gt 0 ]; then',
    '  awk() {',
    '    AWK_CALLS=$((AWK_CALLS + 1))',
    '    if [ "$AWK_CALLS" -eq "$FAIL_AT" ]; then return 9; fi',
    '    command awk "$@"',
    '  }',
    'fi',
    'env_upsert_many_locked CDS_USERNAME new-user CDS_PASSWORD new-pass CDS_JWT_SECRET new-jwt CDS_ROOT_DOMAINS a.test',
  ].join('\n');
  try {
    execFileSync('bash', ['-c', program, 'atomic', SCRIPT, envFile, String(failOnAwkCall)], { encoding: 'utf8' });
    return { code: 0 };
  } catch (error) {
    return { code: (error as { status?: number }).status ?? -1 };
  }
}

function seed(name: string): string {
  const envFile = path.join(workdir, `${name}-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(envFile, ORIGINAL, { mode: 0o600 });
  return envFile;
}

describe('init 的凭据键整组落地', () => {
  it('全部成功：四个键一起生效，其余既有配置原样保留', () => {
    const envFile = seed('ok');
    expect(run(envFile, 0).code).toBe(0);
    const content = fs.readFileSync(envFile, 'utf8');
    expect(content).toContain("export CDS_SECRET_KEY='keep-me'");
    expect(content).toContain("export CDS_USERNAME='new-user'");
    expect(content).toContain("export CDS_PASSWORD='new-pass'");
    expect(content).toContain("export CDS_JWT_SECRET='new-jwt'");
    expect(content).toContain("export CDS_ROOT_DOMAINS='a.test'");
    expect(content).not.toContain("'old-user'");
    expect(content).not.toContain("'old-pass'");
  });

  it.each([1, 2, 3, 4])('第 %i 个键失败时 .cds.env 逐字节未变，绝不留下半套凭据', (failAt) => {
    const envFile = seed(`fail-${failAt}`);
    expect(run(envFile, failAt).code).not.toBe(0);
    // 最关键的一条：不是「大部分字段还在」，是整份文件一个字节都没动过。
    // 逐键 rename 的写法在 failAt>=2 时必然带着 new-user 落地，这条立刻变红。
    expect(fs.readFileSync(envFile, 'utf8')).toBe(ORIGINAL);
  });

  it('失败之后不留临时文件', () => {
    const envFile = seed('cleanup');
    expect(run(envFile, 2).code).not.toBe(0);
    const leftovers = fs.readdirSync(workdir)
      .filter((name) => name.startsWith(path.basename(envFile)) && name !== path.basename(envFile));
    expect(leftovers).toEqual([]);
  });
});
