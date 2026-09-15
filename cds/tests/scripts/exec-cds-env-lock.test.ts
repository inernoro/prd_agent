import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const script = fs.readFileSync(path.resolve(process.cwd(), 'exec_cds.sh'), 'utf8');

function functionBody(name: string, nextName: string): string {
  const start = script.indexOf(`${name}() {`);
  const end = script.indexOf(`${nextName}() {`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe('exec_cds.sh 环境文件共锁守卫', () => {
  it('脚本与 Node 使用同一 write.lock 目录协议', () => {
    expect(script).toContain('local lock_dir="${ENV_FILE}.write.lock"');
    expect(script).toContain('mkdir -m 700 "$lock_dir"');
    expect(script).not.toContain('mv "$lock_dir" "$quarantine"');
    expect(script).toContain('EEXIST 一律 fail-closed');
  });

  it('env_upsert 在读改写前取锁并在返回前释放', () => {
    const body = functionBody('env_upsert', 'lint_env_file');
    expect(body).toContain('env_lock_acquire || return 1');
    expect(body).toContain('env_lock_release');
    expect(body).toContain('mktemp "${ENV_FILE}.tmp.XXXXXX"');
  });

  it('重跑 init 仅合并目标键，不再整文件删除 CDS_SECRET_KEY', () => {
    const body = functionBody('init_cmd', 'status_cmd');
    expect(body).not.toContain('cat > "$ENV_FILE"');
    expect(body).toContain('env_upsert CDS_USERNAME');
    expect(body).toContain('env_upsert CDS_ROOT_DOMAINS');
  });

  it('CDS_ENV_FILE 只接受启动环境并在 source 后恢复该权威', () => {
    expect(script).toContain('CDS_ENV_FILE_STARTUP="${CDS_ENV_FILE:-}"');
    expect(script).toContain('ENV_FILE="${CDS_ENV_FILE_STARTUP:-$SCRIPT_DIR/.cds.env}"');
    const body = functionBody('load_env', 'hash_stream');
    expect(body).toContain('export CDS_ENV_FILE="$CDS_ENV_FILE_STARTUP"');
    expect(body).toContain('unset CDS_ENV_FILE');
    const migrate = functionBody('migrate_env_cmd', 'help_cmd');
    expect(migrate).toContain('[ "$mig_key" = "CDS_ENV_FILE" ] && continue');
  });

  it('migrate-env 全流程持有共锁并用同目录临时文件原子替换', () => {
    const body = functionBody('migrate_env_cmd', 'help_cmd');
    expect(body).toContain('env_lock_acquire || return 1');
    expect(body).toContain('trap env_lock_release EXIT');
    expect(body).toContain('mktemp "${ENV_FILE}.tmp.XXXXXX"');
    expect(body).toContain('mv -f "$env_tmp" "$ENV_FILE"');
  });
});
