import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `.cds.env` 的写入与读取必须是同一套表示。
 *
 * env_upsert 用单引号包裹并把内部单引号写成 '\'' （为了让含换行/$/反引号的 PEM 私钥被
 * source 时原样保留）；read_env_value 原先只剥双引号，于是读回来的是带引号字符的字面量。
 * 那些值正是 init 重跑时「回车保持原样」的默认值，会被原样再写一遍——引号从此成为
 * 密码、用户名、JWT Secret、根域名本身的一部分，重启后仪表盘登不进去、路由也对不上
 * （Codex P1，2026-09-16）。
 *
 * 判据走真实往返而不是扫源码：把两个函数从脚本里取出来在 bash 里真跑一遍，
 * 断言「写进去什么就读回什么」。哪一半再改格式，这条都会红。
 */
const SCRIPT = path.join(process.cwd(), 'exec_cds.sh');
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-env-roundtrip-'));

afterAll(() => { fs.rmSync(workdir, { recursive: true, force: true }); });

function roundTrip(value: string): string {
  const envFile = path.join(workdir, `probe-${Math.random().toString(36).slice(2)}.env`);
  const program = [
    'set -u',
    // env_upsert 现在是薄壳（抢锁 -> env_upsert_locked -> 放锁），读改写的本体在后者，
    // 两个都要取出来，否则 eval 出的 env_upsert 会调到一个不存在的函数。
    `eval "$(sed -n '/^env_upsert_locked() {/,/^}/p' "$1")"`,
    `eval "$(sed -n '/^env_upsert() {/,/^}/p' "$1")"`,
    `eval "$(sed -n '/^read_env_value() {/,/^}/p' "$1")"`,
    // 锁不是本条判据，用空实现顶掉。
    'env_lock_acquire() { return 0; }',
    'env_lock_release() { return 0; }',
    'ENV_FILE="$2"',
    'env_upsert CDS_PASSWORD "$3"',
    'read_env_value CDS_PASSWORD',
  ].join('\n');
  return execFileSync('bash', ['-c', program, 'roundtrip', SCRIPT, envFile, value], {
    encoding: 'utf8',
  });
}

function readRaw(line: string): string {
  const envFile = path.join(workdir, `legacy-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(envFile, `${line}\n`, { mode: 0o600 });
  const program = [
    'set -u',
    `eval "$(sed -n '/^read_env_value() {/,/^}/p' "$1")"`,
    'ENV_FILE="$2"',
    'read_env_value CDS_PASSWORD',
  ].join('\n');
  return execFileSync('bash', ['-c', program, 'legacy', SCRIPT, envFile], { encoding: 'utf8' });
}

describe('.cds.env 的写入与读取是同一套表示', () => {
  it.each([
    ['普通口令', 'secret'],
    ['含单引号', "p@ss'word"],
    ['含双引号', 'a"b'],
    ['含空格与等号', 'a b=c d'],
    ['像域名列表', 'example.com,example.net'],
  ])('%s：写进去什么就读回什么', (_label, value) => {
    expect(roundTrip(value)).toBe(value);
  });

  it('旧版本写下的双引号存量值仍然读得回来', () => {
    expect(readRaw('export CDS_PASSWORD="legacy-secret"')).toBe('legacy-secret');
  });

  it('旧版本写下的裸值仍然读得回来', () => {
    expect(readRaw('export CDS_PASSWORD=legacy-bare')).toBe('legacy-bare');
  });
});
