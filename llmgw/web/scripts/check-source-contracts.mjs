#!/usr/bin/env node
// 跨模块源码契约守卫（本地镜像）。
//
// 由来：`.github/workflows/ci.yml` 会跑 prd-api 的 GatewayDataDomainGuardTests，
// 而这个 C# 测试**直接读 llmgw/web 的前端源码做字面量断言**——它把「控制台必须暴露
// 哪些产品行为」钉成了跨模块契约。本仓库前端侧没有 dotnet SDK，于是这层契约在
// 前端改动时完全不可见：2026-07-29 组织页重构一次就打破了 5 条断言并推了上去
// （三条是用户可见文案被改短，三条是抽屉里 state 变量被重命名）。
//
// 本脚本**解析那个 C# 测试**，把其中所有
//   Assert.Contains / Assert.DoesNotContain(字面量, <某个 llmgw/web 源文件变量>)
// 在本地原样复算一遍。字面量从 C# 侧读取，**不在这里复制一份**——
// 否则就造出了第二个事实源，迟早漂移（这正是本仓库 predicate-and-wiring-discipline
// 里「判据分裂」那一形状）。
//
// 覆盖范围说明：只复算该测试中「读取 llmgw/web 源文件」的断言。
// 测试里针对 prd-api / console-api / serving 的断言不在此列，仍以 CI 的 dotnet test 为准。
//
// 用法：pnpm check:contracts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const TEST_FILE = path.join(REPO, 'prd-api/tests/PrdAgent.Tests/GatewayDataDomainGuardTests.cs');

// 容器镜像构建时 build context 只有 llmgw/web（见 Dockerfile 的 `COPY . .`），
// 拿不到 prd-api —— 这时必须跳过，否则镜像构建会直接失败。
// 跳过是**预期行为而不是漏洞**：镜像那条路径上，权威校验是 CI 里真正的 dotnet test。
// 本脚本的价值在本地/CI 前端侧：没有 dotnet SDK 也能秒级复算这层契约。
if (!fs.existsSync(TEST_FILE)) {
  console.warn('源码契约守卫跳过：本次构建上下文里没有 prd-api（容器镜像构建即如此），');
  console.warn('  该场景由 CI 的 dotnet test 兜底。仓库内构建时本守卫会正常执行。');
  process.exit(0);
}

const source = fs.readFileSync(TEST_FILE, 'utf8');

/** C# 字面量 → 实际字符串。测试里用的是普通字符串（含 \" \\ \n 转义）与逐字字符串 @"..."。 */
function decodeCsharpLiteral(raw, verbatim) {
  if (verbatim) return raw.replace(/""/g, '"');
  return raw
    .replace(/\\"/g, '"')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

// 按 [Fact] 切成一个个测试方法：变量名只在方法内有意义。
const methods = source.split(/\n\s*\[Fact\]\s*\n/);

const checks = [];
for (const method of methods) {
  const nameMatch = /public void (\w+)/.exec(method);
  const methodName = nameMatch ? nameMatch[1] : '(unknown)';

  // var xxx = ReadRepoFile("llmgw/web/...");
  const varToFile = new Map();
  for (const m of method.matchAll(/var (\w+)\s*=\s*ReadRepoFile\("(llmgw\/web\/[^"]+)"\)/g)) {
    varToFile.set(m[1], m[2]);
  }
  if (varToFile.size === 0) continue;

  // Assert.Contains("literal", variable) / Assert.DoesNotContain(@"literal", variable)
  const assertRe = /Assert\.(Contains|DoesNotContain)\(\s*(@?)"((?:[^"\\]|\\.|"")*)"\s*,\s*(\w+)\s*\)/g;
  for (const m of method.matchAll(assertRe)) {
    const [, kind, at, rawLiteral, variable] = m;
    const file = varToFile.get(variable);
    if (!file) continue; // 断言的是后端文件，不归本脚本管
    checks.push({ methodName, kind, literal: decodeCsharpLiteral(rawLiteral, at === '@'), file });
  }
}

if (checks.length === 0) {
  console.error('源码契约守卫未通过：没有从 C# 测试里解析出任何前端断言 —— 解析器多半坏了，不要当作通过。');
  process.exit(1);
}

const fileCache = new Map();
const readTarget = (rel) => {
  if (!fileCache.has(rel)) {
    const full = path.join(REPO, rel);
    fileCache.set(rel, fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null);
  }
  return fileCache.get(rel);
};

const violations = [];
for (const check of checks) {
  const content = readTarget(check.file);
  if (content === null) {
    violations.push(`${check.file}  文件不存在，但 ${check.methodName} 断言了它`);
    continue;
  }
  const present = content.includes(check.literal);
  const ok = check.kind === 'Contains' ? present : !present;
  if (ok) continue;
  const want = check.kind === 'Contains' ? '必须包含' : '不得包含';
  violations.push(`${check.file}  ${want}：${JSON.stringify(check.literal)}\n      来源断言：${check.methodName}`);
}

if (violations.length) {
  console.error(`源码契约守卫未通过（共 ${checks.length} 条断言，${violations.length} 条失败）：\n`);
  for (const violation of violations) console.error('  ' + violation);
  console.error('\n这些字面量是 prd-api 的 GatewayDataDomainGuardTests 钉住的跨模块产品契约，');
  console.error('改动前端文案或标识符会让 CI 的 dotnet test 变红。');
  console.error('要么在前端逐字保留，要么先去改那个 C# 测试并说明理由——不要静默绕开。');
  process.exit(1);
}

const files = new Set(checks.map((check) => check.file)).size;
console.log(`源码契约守卫通过：${checks.length} 条跨模块断言，覆盖 ${files} 个前端文件。`);
