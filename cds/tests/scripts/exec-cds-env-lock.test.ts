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
    expect(body).toContain('env_upsert_locked "$1" "$2"');
  });

  it('env_upsert_locked 自己不碰锁（目录锁不可重入，重入即 fail-closed 死锁）', () => {
    const body = functionBody('env_upsert_locked', 'env_upsert');
    expect(body).not.toContain('env_lock_acquire');
    expect(body).not.toContain('env_lock_release');
    expect(body).toContain('mktemp "${ENV_FILE}.tmp.XXXXXX"');
  });

  it('重跑 init 仅合并目标键，不再整文件删除 CDS_SECRET_KEY', () => {
    const body = functionBody('init_cmd', 'status_cmd');
    expect(body).not.toContain('cat > "$ENV_FILE"');
    expect(body).toContain('env_upsert_locked CDS_USERNAME');
    expect(body).toContain('env_upsert_locked CDS_ROOT_DOMAINS');
  });

  it('init 的四个键整组原子：全程只取一次锁，不逐键各抢各放', () => {
    // 主干原来是一次 `cat > "$ENV_FILE"` 整文件替换，天然保证四个值是同一组。
    // 改成逐键之后若各抢各放，两个 init 并发就能交错出「A 的用户名配 B 的密码与 JWT」。
    const body = functionBody('init_cmd', 'status_cmd');
    // 只看凭据那一段（取锁 到 「已写入」）。init_cmd 后半段的 MongoDB 阶段也有一组
    // 逐键 env_upsert，但那组主干上本来就是这么写的、且值是确定性的（固定 URI、
    // 字面量 mongo-split、容器名），两个 init 并发写出来基本是同一组；
    // 本 PR 只负责修自己造成的那处回归，那组记在 doc/debt.cds.md。
    const start = body.indexOf('env_lock_acquire');
    const end = body.indexOf('已写入 $ENV_FILE');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const credentialSection = body.slice(start, end);
    // 四次写入都必须是「已持锁」那一版；出现任何一次自带抢锁的 env_upsert 就说明又拆开了
    expect(credentialSection).not.toMatch(/env_upsert (?!_locked)/);
    expect(credentialSection.match(/env_lock_acquire/g) ?? []).toHaveLength(1);
    expect(credentialSection.match(/env_upsert_locked/g) ?? []).toHaveLength(4);
    expect(credentialSection).toContain('env_lock_release');
    // 备份也必须在同一把锁内，否则备份到的是另一个 init 写了一半的中间态
    expect(credentialSection.indexOf('env_backup_secure')).toBeGreaterThan(0);
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
