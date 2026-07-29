/**
 * inline-host-creator-wiring.test.ts — 「就地加服务器」这条链路的接线守卫。
 *
 * 为什么需要守卫（predicate-and-wiring-discipline 形状 2）：
 * InlineHostCreator 是个组件，组件本身写得再对，只要没人渲染它、
 * 或者父级没把 onHostCreated 传下来，用户看到的仍然是老样子——
 * 而 tsc 全绿、所有单测全绿，没有任何东西会红。
 *
 * 这些断言的判据是「链路在不在」，删掉任意一环都会红。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.join(here, '../../web/src');
const read = (relative: string): string => fs.readFileSync(path.join(webSrc, relative), 'utf8');

describe('就地加服务器的接线', () => {
  const wizard = read('pages/release-center/SiteWizardDialog.tsx');
  const page = read('pages/ReleaseCenterPage.tsx');
  const creator = read('pages/release-center/InlineHostCreator.tsx');

  it('向导里真的渲染了 InlineHostCreator', () => {
    expect(wizard).toContain("from './InlineHostCreator'");
    expect(wizard).toMatch(/<InlineHostCreator\b/);
  });

  it('一台服务器都没有时默认展开（否则等于把人挡在门外）', () => {
    expect(wizard).toMatch(/defaultOpen=\{hosts\.length === 0\}/);
  });

  it('页面把 onHostCreated 传给了向导', () => {
    expect(page).toMatch(/onHostCreated=\{handleHostCreated\}/);
    expect(page).toMatch(/const handleHostCreated = /);
  });

  it('新建后把创建接口返回的主机并进列表，不重拉按引用过滤的目标接口', () => {
    // 2026-07-29 真人路径验收当场撞到的坑：/releases/targets 出于项目隔离
    // 只返回「已被本项目发布目标引用」的主机，刚建出来的那台还没被引用 →
    // 重拉等于查无此人，界面继续说「还没有服务器」，再加一次撞后端全局重名 409。
    const handler = page.slice(page.indexOf('const handleHostCreated'), page.indexOf('const selectHost'));
    expect(handler).not.toContain('/api/releases/targets');
    expect(handler).toContain('privateKeyRef: created.id');
    expect(handler).toMatch(/hosts: \[/);
    expect(handler).toMatch(/host: created\.host/);
    expect(handler).toMatch(/user: created\.sshUser/);
  });

  it('空状态不再把没有服务器的人支去 CDS 系统设置', () => {
    // 用户原话：不允许操作用户跳来跳去。没有服务器恰恰是最不该把人支走的时刻。
    expect(page).not.toContain('/cds-settings#remote-hosts');
  });

  it('重名冲突给的是能照做的中文，不是原始英文 409', () => {
    expect(creator).toContain('already exists');
    expect(creator).toMatch(/已被占用/);
  });

  it('三种认证方式都在 UI 上给出（不是只留私钥）', () => {
    expect(creator).toContain("value: 'generate'");
    expect(creator).toContain("value: 'private-key'");
    expect(creator).toContain("value: 'password'");
  });

  it('创建请求按认证方式发对应字段', () => {
    expect(creator).toContain('body.generateKeyPair = true');
    expect(creator).toContain('body.sshPrivateKey = privateKey');
    expect(creator).toContain('body.sshPassword = password');
  });

  it('连接串走共享解析器，没有在组件里另写一份', () => {
    expect(creator).toContain("from '@/lib/sshTarget'");
    // 组件里不许再出现自己拆 user@host:port 的正则/split：
    // 判据分裂之后，两处对 IPv6、-p 端口的处理迟早不一致。
    expect(creator).not.toMatch(/split\(['"]@['"]\)/);
  });

  it('生成密钥对后把公钥给出来（拿不到公钥这台机器就永远连不上）', () => {
    expect(creator).toContain('created.publicKey');
    expect(creator).toContain('authorized_keys');
  });

  it('保存成功后清掉内存里的私钥与密码明文', () => {
    const save = creator.slice(creator.indexOf('const save = async'), creator.indexOf('const runTest'));
    expect(save).toContain("setPrivateKey('')");
    expect(save).toContain("setPassword('')");
  });

  it('向导里不再把用户支去 CDS 系统设置才能加服务器', () => {
    // 允许保留一个「集中管理」的次要入口（在 InlineHostCreator 里），
    // 但向导主路径不许再依赖跳页。
    expect(wizard).not.toContain('/cds-settings#remote-hosts');
  });
});
