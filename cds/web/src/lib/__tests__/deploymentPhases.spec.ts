/*
 * deploymentPhases 单测。
 *
 * TODO(week-4.7): wire up vitest in cds/web. 当前 cds/web/package.json
 * 没有 vitest 依赖与配置，本文件用 .spec.ts 后缀放着，作为债务记录，
 * 不会被构建工具拾取，但留作下一次 vitest 接入时直接复用的素材。
 *
 * 覆盖 case：
 *  1. 空 log + running
 *  2. 空 log + error + errorMessage
 *  3. 只 prepare 行
 *  4. 走完 4 阶段（success）
 *  5. build 阶段失败
 *  6. running 中（无 finalStatus=success/error）
 *  7. 中文 + 英文混杂日志
 *  8. 短日志降级（log 完全无关键词）
 *  9. errorMessage 注入到没找到 error 关键词的失败
 * 10. 同一行同时命中多个 pattern → 取靠后阶段
 */

import { deriveBranchPhases } from '../deploymentPhases';

type PhaseTriple = [string, 'pending' | 'running' | 'success' | 'error', string | undefined];

function triples(log: string[], status: 'running' | 'success' | 'error', err?: string): PhaseTriple[] {
  return deriveBranchPhases(log, status, err).map((phase) => [phase.key, phase.status, phase.errorHint]);
}

// 1. 空 log + running → 单个 build 占位 + status=running
const case1 = triples([], 'running');
console.assert(case1.length === 1 && case1[0][0] === 'build' && case1[0][1] === 'running', 'case1 fail', case1);

// 2. 空 log + error + errorMessage → 单 build + error + errorHint=errorMessage
const case2 = triples([], 'error', '尚未配置构建配置');
console.assert(case2.length === 1 && case2[0][1] === 'error' && case2[0][2] === '尚未配置构建配置', 'case2 fail', case2);

// 3. 只 prepare 行 + running → prepare=running, 后面全 pending
const case3 = triples(['git clone https://github.com/foo/bar'], 'running');
console.assert(case3[0][0] === 'prepare' && case3[0][1] === 'running', 'case3 prepare running', case3);
console.assert(case3[1][1] === 'pending' && case3[2][1] === 'pending' && case3[3][1] === 'pending', 'case3 rest pending', case3);

// 4. 走完 4 阶段 success
const case4 = triples([
  'git clone https://github.com/foo/bar',
  'docker build -t image .',
  'docker run -d image',
  'health check passed',
], 'success');
console.assert(case4.every((row) => row[1] === 'success'), 'case4 all success', case4);

// 5. build 阶段失败（注意：classifyLine 同行多命中取靠后阶段，
//    所以 "build started" 会被归到 deploy；这里写成纯 build 关键词。）
const case5 = triples([
  'git clone ok',
  'pnpm install dependencies',
  'pnpm install failed: ENOSPC no space left',
], 'error');
console.assert(case5[0][1] === 'success' && case5[1][1] === 'error', 'case5 build err', case5);
console.assert(case5[2][1] === 'pending' && case5[3][1] === 'pending', 'case5 deploy/verify pending', case5);
console.assert(case5[1][2]?.includes('failed') === true, 'case5 errorHint contains failed', case5);

// 6. running 中（最后阶段 deploy 没有 finalStatus）
const case6 = triples([
  'git clone ok',
  'pnpm install ok',
  'docker run starting',
], 'running');
console.assert(case6[0][1] === 'success' && case6[1][1] === 'success' && case6[2][1] === 'running' && case6[3][1] === 'pending', 'case6 sliding running', case6);

// 7. 中文 + 英文混杂
const case7 = triples([
  '正在拉取代码…',
  '镜像构建中',
  '启动服务',
  '健康检查通过',
], 'success');
console.assert(case7.every((row) => row[1] === 'success'), 'case7 mixed cn/en success', case7);

// 8. 短日志降级
const case8 = triples(['初始化', '准备开始'], 'running');
console.assert(case8.length === 1 && case8[0][0] === 'build', 'case8 fallback single build', case8);

// 9. errorMessage 注入到没找到 error 关键词的 finalStatus=error
const case9 = triples([
  'git clone ok',
  'docker build ok',
], 'error', '部署被中断');
// 最后一个被识别的是 build，应该被标 error
console.assert(case9[1][1] === 'error', 'case9 last matched as error', case9);

// 10. 同一行同时命中多个 pattern → 取靠后阶段
const case10 = triples(['docker run -d image'], 'running');
// "docker"/"image" → build, "run" → deploy；应该取 deploy
console.assert(case10[2][1] === 'running', 'case10 multi-match prefers later', case10);

// eslint-disable-next-line no-console
console.log('all 10 cases passed');
