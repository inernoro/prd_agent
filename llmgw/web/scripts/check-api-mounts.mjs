#!/usr/bin/env node
// 挂载点覆盖守卫：前端能算出来的每一个 console API base，nginx 都必须有对应的 location。
//
// 由来（2026-08-28 真实事故）：同一份前端有两个挂载点——独立子域挂在根、经 MAP 主域挂在
// /llmgw 子路径——`runtimeBase.ts` 按 `location.pathname` 自己选 `/gw` 还是 `/llmgw/gw`。
// nginx 只配了 `/gw/`，于是在独立子域上打开 `/llmgw/quickstart`（把主域深链复制过来就是
// 这个形状）时，前端请求 `/llmgw/gw/*` 落进 SPA fallback：GET 拿回一份 index.html、
// POST 直接 405，界面上表现为「登录点了没反应，提示请求失败（405）」。
//
// 判据不是「nginx.conf 里有没有那一行」（那种字面断言挡不住下一次新增挂载点），
// 而是**两边求值后取交集**：从 runtimeBase.ts 真的跑一遍拿到全部可能的 base，
// 再逐个到 nginx.conf 里找能命中它的 location。新增第三个挂载点却忘了配 nginx，这条就红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NGINX = path.join(ROOT, 'nginx.conf');
const RUNTIME_BASE = path.join(ROOT, 'src/lib/runtimeBase.ts');

/** 前端会经历的挂载点。新增挂载点时在这里加一行，守卫会要求 nginx 同步。 */
const MOUNT_PATHNAMES = ['/', '/quickstart', '/llmgw', '/llmgw/quickstart', '/llmgw/logs'];

/** 直接跑 runtimeBase.ts 的逻辑，而不是猜它的输出：改了那边的规则，这里跟着变。 */
const source = fs.readFileSync(RUNTIME_BASE, 'utf8');
const body = source
  .replace(/export function/g, 'function')
  // 只去掉这份文件用到的那几种类型标注；出现别的写法这里会抛 SyntaxError，
  // 那是**故意**的——宁可当场报错，也不要悄悄跳过求值退化成一条永远绿的守卫。
  .replace(/\?:\s*string/g, '')
  .replace(/:\s*string(\s*\|\s*undefined)?/g, '')
  .concat('\nreturn MOUNTS.map((p) => getDefaultApiBase(p));\n');
let bases;
try {
  bases = [...new Set(new Function('MOUNTS', body)(MOUNT_PATHNAMES))];
} catch (error) {
  console.error(`挂载点覆盖守卫无法求值 src/lib/runtimeBase.ts：${error.message}`);
  console.error('那里多半用了本脚本没脱掉的类型标注，补一条 replace 再跑，别把这个守卫注释掉。');
  process.exit(1);
}

const conf = fs.readFileSync(NGINX, 'utf8');
/** nginx 里所有把请求转给 console-api 上游（llmgw:8090）的 location 前缀。 */
const proxied = [];
for (const match of conf.matchAll(/location\s+\^~\s+(\S+)\s*\{([^]*?)\n {4}\}/g)) {
  if (/proxy_pass\s+http:\/\/\$llmgw_upstream:8090/.test(match[2])) proxied.push(match[1]);
}

const missing = bases.filter((base) => !proxied.some((prefix) => `${base}/`.startsWith(prefix)));

if (missing.length) {
  console.error('挂载点覆盖守卫未通过：以下 console API base 在 nginx.conf 里没有对应 location\n');
  for (const base of missing) console.error(`  ${base}/*  ← 会落进 SPA fallback：GET 拿 index.html、POST 405`);
  console.error(`\nnginx.conf 现有的 console-api location：${proxied.join(' ') || '（一个都没有）'}`);
  console.error('补一个 `location ^~ <base>/ { rewrite 掉多余前缀; proxy_pass http://$llmgw_upstream:8090; }`。');
  process.exit(1);
}

/*
  覆盖到了还不够：还要**没被更长的前缀抢走、也没有抢走别人的**。

  2026-08-30 的事故形状：补 `/llmgw/gw/` → 控制台 8090 的时候，顺手把
  `/llmgw/gw/v1/*` 也一起吞了——那是 serving 的四协议入口（8091），控制台根本没有它。
  生产发布冒烟探的正是 `/llmgw/gw/v1/healthz`（`exec_dep.sh` 的 --llmgw-serving-health-path），
  于是每一次发布都会被一个 404 挡住。而它编译过、页面照常打开、控制台自己的请求全都正常，
  只有真发一次生产才炸——所以这里必须机械判：serving 的路径必须落到 serving 上游。
*/
const SERVING_PATHS = [
  // 生产发布冒烟的两条：控制台健康与 serving 健康，前者 8090、后者 8091，不许互串。
  { path: '/llmgw/gw/v1/healthz', port: '8091', why: '生产发布冒烟的 serving 健康探针（exec_dep.sh）' },
  { path: '/gw/v1/healthz', port: '8091', why: '独立子域上的 serving 健康探针' },
  { path: '/llmgw/gw/healthz', port: '8090', why: '生产发布冒烟的控制台健康探针（exec_dep.sh）' },
  { path: '/gw/healthz', port: '8090', why: '独立子域上的控制台健康探针' },
];

/** 所有 ^~ location 及其上游端口。前缀匹配取最长者——这里照同一套规则算胜出的那条。 */
const prefixLocations = [];
for (const match of conf.matchAll(/location\s+\^~\s+(\S+)\s*\{([^]*?)\n {4}\}/g)) {
  const port = /proxy_pass\s+http:\/\/\$\w+:(\d+)/.exec(match[2])?.[1] ?? null;
  prefixLocations.push({ prefix: match[1], port });
}

const misrouted = [];
for (const target of SERVING_PATHS) {
  const winner = prefixLocations
    .filter((loc) => target.path.startsWith(loc.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!winner) {
    misrouted.push(`${target.path} 没有任何 location 命中（会落进 SPA fallback，拿到一份 index.html）—— ${target.why}`);
    continue;
  }
  if (winner.port !== target.port) {
    misrouted.push(
      `${target.path} 被 \`location ^~ ${winner.prefix}\` 接走，转去 ${winner.port ?? '（没有 proxy_pass）'}，`
      + `而它必须落到 ${target.port} —— ${target.why}`);
  }
}

if (misrouted.length) {
  console.error('挂载点覆盖守卫未通过：下面这些路径被转到了错误的上游\n');
  for (const line of misrouted) console.error(`  ${line}`);
  console.error('\nnginx 前缀匹配取最长者：给被抢走的那条补一个**更长**的 location，别去调顺序。');
  process.exit(1);
}

console.log(
  `挂载点覆盖守卫通过：${bases.map((b) => `${b}/*`).join('、')} 都有 console-api location；`
  + `${SERVING_PATHS.length} 条健康探针路径各自落到正确上游。`);
