import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 全仓守卫：前端不许自己按 hostname 推算预览域名。
 *
 * 根 CLAUDE.md 规则 #11 —— 预览地址只能来自平台（CDS 计算、prd-api 下发），
 * 禁止本地 slugify / 拼域名。2026-07-29 一次排查里，同一个反模式被发现有**三份**
 * 拷贝：prd-admin 的 SSO 跳转、llmgw 控制台的「返回 MAP」、再加 CDS 内部的重复判据。
 * 前两份能长期共存，是因为没有任何东西在拦「又有人拼了一遍」——单文件断言只锁住
 * 已知的那一个文件，锁不住下一个人新建的文件。
 *
 * 本守卫扫两个前端包的全部源码，命中即红。新增例外必须写进 ALLOWLIST 并注明理由，
 * 让「又多了一份域名推算」这件事在 review 里必须被显式承认，而不是悄悄发生。
 */

const PACKAGES = [
  { name: 'prd-admin', root: new URL('../../', import.meta.url).pathname },
  { name: 'llmgw/web', root: new URL('../../../../llmgw/web/src/', import.meta.url).pathname },
];

/**
 * 例外清单：`包名:相对路径` → 为什么还留着。
 * 清掉一条就删一行；只减不增，新增必须在 PR 里说明。
 */
const ALLOWLIST = new Map<string, string>([
  [
    'llmgw/web:lib/mapNavigation.ts',
    '控制台「返回 MAP」的兜底推算。平台已通过 /gw/healthz 的 mapHomeUrl 下发权威地址并优先生效，'
    + '这里保留后缀推算仅用于「平台没下发」的场景（正式环境 / 旧版 CDS）。'
    + '待所有部署都下发后可删，见 doc/debt.platform.md「预览入口下发（Preview Entrypoints）· 债务台账」 的 PE-llmgw-console-mapnav。',
  ],
]);

/**
 * 域名推算的特征。注意判据要盯**构造**而不是**提及** —— 首版写成「出现 miduo.org 就红」，
 * 立刻误伤了联系邮箱 `contact@miduo.org` 和产品截图里的展示文案 `map.miduo.org`。
 * 那种误报会逼着后来人把无辜文件塞进例外清单，守卫就此失去意义。
 */
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  // 把变量拼进预览域名：`${slug}.miduo.org`
  { label: '用模板拼预览域名', re: /\$\{[^}]*\}[^`]*\.miduo\.org/ },
  // 把根域当后缀常量存起来（拿它做 endsWith / slice 剥离，必然是在反推子域）
  { label: '预览根域后缀常量 ".miduo.org"', re: /['"`]\.miduo\.org['"`]/ },
  // 网关子域后缀常量：本轮改名就是被这种字面量绊住的
  { label: '网关子域后缀常量 "-llmgw" / "-llmgw-web"', re: /['"`]-llmgw(-web)?['"`]/ },
];

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    acc.push(full);
  }
  return acc;
}

/** 去掉注释后再匹配：注释里解释「为什么不许这么写」不该把守卫自己弄红。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

describe('前端不许自己推算预览域名（根 CLAUDE.md 规则 #11）', () => {
  it.each(PACKAGES)('$name 源码里没有未登记的域名推算', ({ name, root }) => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(root)) {
      const rel = file.slice(root.length);
      const key = `${name}:${rel}`;
      const code = stripComments(readFileSync(file, 'utf-8'));
      for (const { label, re } of PATTERNS) {
        if (!re.test(code)) continue;
        if (ALLOWLIST.has(key)) continue;
        offenders.push(`${key} 命中「${label}」`);
      }
    }
    expect(
      offenders,
      offenders.length === 0 ? '' : [
        '发现新的域名推算。预览地址只能来自平台（CDS 算 → prd-api 下发 → 前端消费）：',
        ...offenders.map((o) => `  - ${o}`),
        '若确属无法避免的兜底，请加进本文件的 ALLOWLIST 并写明理由与清除条件。',
      ].join('\n'),
    ).toEqual([]);
  });

  it('例外清单只在有理由时存在（空理由即视为未登记）', () => {
    for (const [key, reason] of ALLOWLIST) {
      expect(reason.trim().length, `${key} 的例外没有写理由`).toBeGreaterThan(20);
    }
  });
});
