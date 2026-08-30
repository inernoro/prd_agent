import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessDeployLoop,
  recordBuild,
  __resetBuildActivityForTests,
} from '../../src/services/build-activity-tracker.js';

/**
 * 空转部署熔断的行为用例 + 接线守卫。
 *
 * 事故（2026-08-29，mdimp）：分支 bootstrap 步骤写完 profile override 后自己再发一次
 * POST /api/branches/:id/deploy，而该步骤每轮都判定 override 变了 —— 构成按构造
 * 无法收敛的环。实测 main 上连续十余轮背靠背部署（每轮结束后 3~4 秒下一轮就起，
 * 全是同一个 commit e3265219），分支永远停在 building、预览 503、宿主构建槽被独占。
 *
 * CDS 当时对此毫无察觉：branch-operation-coordinator 只防「并发」撞车，而这个环
 * 严格串行（每轮等上一轮结束才起），协调器从未触发；build-activity-tracker 记了
 * 次数却只喂资源面板展示，没有任何判定。
 */

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(CDS_ROOT, relativePath), 'utf8');
}

const SHA_A = 'e3265219f0286b640ed07a3396e4355e030c5120';
const SHA_B = '36309f9a3af1a5f6b2a2797113e50f3d0f3a84e8';

afterEach(() => __resetBuildActivityForTests());

describe('assessDeployLoop：判定「同一分支反复部署同一个提交」', () => {
  it('少量重复部署同一提交只算正常，不告警', () => {
    recordBuild('p', 'p-main', 'manual', SHA_A);
    recordBuild('p', 'p-main', 'manual', SHA_A);
    const verdict = assessDeployLoop('p-main', SHA_A);
    expect(verdict.level).toBe('ok');
    expect(verdict.sameCommitCount).toBe(2);
  });

  it('达到告警阈值时给出 warn，但仍然放行', () => {
    for (let i = 0; i < 3; i++) recordBuild('p', 'p-main', 'manual', SHA_A);
    const verdict = assessDeployLoop('p-main', SHA_A);
    expect(verdict.level).toBe('warn');
    expect(verdict.sameCommitCount).toBe(verdict.warnAt);
  });

  it('复现事故节奏：同一提交连续部署到熔断阈值即 trip', () => {
    // 事故里 main 在 19:17~19:41 内对 e3265219 连推了 6 轮。
    for (let i = 0; i < 6; i++) recordBuild('mdimp', 'mdimp-main', 'manual', SHA_A);
    const verdict = assessDeployLoop('mdimp-main', SHA_A);
    expect(verdict.level).toBe('trip');
    expect(verdict.sameCommitCount).toBeGreaterThanOrEqual(verdict.tripAt);
    // 拒绝文案要能指名道姓，否则堵住了也查不出是谁（concurrency-gate-discipline 第 2 条：持有者身份）。
    expect(verdict.commitSha).toBe(SHA_A);
  });

  it('正常连推十次（每次都是新提交）永不熔断 —— 这是本判据最重要的不误伤保证', () => {
    for (let i = 0; i < 10; i++) {
      const sha = `${String(i).repeat(7)}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 40);
      recordBuild('p', 'p-feat', 'webhook', sha);
      expect(assessDeployLoop('p-feat', sha).level).toBe('ok');
    }
  });

  it('推一个新提交即可解除熔断（判据按「分支 + 提交」计数）', () => {
    for (let i = 0; i < 8; i++) recordBuild('p', 'p-main', 'manual', SHA_A);
    expect(assessDeployLoop('p-main', SHA_A).level).toBe('trip');
    expect(assessDeployLoop('p-main', SHA_B).level).toBe('ok');
  });

  it('不同分支各算各的，不互相污染', () => {
    for (let i = 0; i < 8; i++) recordBuild('p', 'p-main', 'manual', SHA_A);
    expect(assessDeployLoop('p-other', SHA_A).level).toBe('ok');
  });

  it('短 SHA 与全长 SHA 视为同一个提交（否则同一提交被判成两个，判据当场失效）', () => {
    for (let i = 0; i < 6; i++) recordBuild('p', 'p-main', 'manual', SHA_A.slice(0, 7));
    // 后续请求送全长 SHA，仍须命中前面那 6 次短号记录。
    expect(assessDeployLoop('p-main', SHA_A).level).toBe('trip');
    // 反向同理：先记全长、后送短号。
    __resetBuildActivityForTests();
    for (let i = 0; i < 6; i++) recordBuild('p', 'p-main', 'manual', SHA_A);
    expect(assessDeployLoop('p-main', SHA_A.slice(0, 7)).level).toBe('trip');
  });

  it('大小写不同的同一个 SHA 视为同一个提交', () => {
    for (let i = 0; i < 6; i++) recordBuild('p', 'p-main', 'manual', SHA_A.toUpperCase());
    expect(assessDeployLoop('p-main', SHA_A).level).toBe('trip');
  });

  it('拿不到提交号时一律放行：护栏误伤真实工作比漏掉一次空转更糟', () => {
    for (let i = 0; i < 20; i++) recordBuild('p', 'p-main', 'manual', undefined);
    expect(assessDeployLoop('p-main', undefined).level).toBe('ok');
    expect(assessDeployLoop('p-main', '').level).toBe('ok');
    // 非法 SHA（不是 7~40 位十六进制）等同于拿不到。
    expect(assessDeployLoop('p-main', 'not-a-sha').level).toBe('ok');
  });

  it('超出观察窗口的历史部署不计数（昨天部署过八次不该影响今天）', () => {
    for (let i = 0; i < 8; i++) recordBuild('p', 'p-main', 'manual', SHA_A);
    const wellPastWindow = Date.now() + 31 * 60 * 1000;
    const verdict = assessDeployLoop('p-main', SHA_A, wellPastWindow);
    expect(verdict.level).toBe('ok');
    expect(verdict.sameCommitCount).toBe(0);
  });

  it('trigger 不参与判定：事故里那个自触发脚本记录下来就是 manual', () => {
    // triggerFromRequest 在缺 x-cds-trigger 头时一律回落 'manual'，
    // CDS 自己的 Web 面板与一个失控脚本在这个字段上完全不可区分。
    for (let i = 0; i < 6; i++) recordBuild('p', 'p-main', 'manual', SHA_A);
    expect(assessDeployLoop('p-main', SHA_A).level).toBe('trip');
  });
});

/**
 * 接线守卫。assessDeployLoop 有完整行为用例、却没有任何人调用它 —— 这条链路
 * 删掉不会红，只会静默失效（predicate-and-wiring-discipline 形状 2）。
 *
 * 只扫 deploy 处理器里那一段，不做全文 contains：函数名在 import 行、注释里也会
 * 出现，全文匹配会给出假绿（判定被摘掉、import 还留着，守卫照样通过）。
 */
/**
 * 截取 deploy 处理器里「判熔断 → 登记 run → 取租约 → 记账」这一段。
 *
 * 窗口下界不写死长度：2026-08-30 把 recordBuild 从租约前挪到租约后之后，
 * 原来 4000 字符的窗口正好把它切在外面，守卫对着**修好了的**代码判红——
 * 判据自己漂了。所以改成「一直截到记账那一行之后」，并断言窗口确实覆盖到了
 * 每条断言要找的锚点，覆盖不到就明确报错，而不是静默给出半截文本。
 */
function deployHandlerSlice(source: string): string {
  const anchor = source.indexOf('const requestCommitSha = selectedDeploymentVersion?.commitSha');
  expect(anchor).toBeGreaterThan(-1);
  const recordAt = source.indexOf('recordBuild(entry.projectId', anchor);
  expect(recordAt, 'deploy 处理器里找不到 recordBuild').toBeGreaterThan(anchor);
  const end = source.indexOf('\n', recordAt) + 1;
  const slice = source.slice(anchor, end);
  for (const needle of ['assessDeployLoop(', 'deploymentRunService?.begin(', 'beginBranchOperation(']) {
    expect(slice, `deploy 切片没覆盖到 ${needle}`).toContain(needle);
  }
  return slice;
}

describe('接线守卫：deploy 端点真的在用这条判定', () => {
  it('deploy 处理器调用 assessDeployLoop，并在 trip 时拒绝请求', () => {
    const slice = deployHandlerSlice(read('src/routes/branches.ts'));
    expect(slice).toContain('assessDeployLoop(');
    expect(slice).toContain("=== 'trip'");
    expect(slice).toContain('res.status(429)');
    expect(slice).toContain('deploy_loop_detected');
  });

  it('拒绝时给得出逃生门，否则用户被堵死且不知道怎么办', () => {
    const slice = deployHandlerSlice(read('src/routes/branches.ts'));
    expect(slice).toContain('ignoreDeployLoopGuard');
    expect(slice).toContain('escapeHatch');
  });

  it('熔断判定排在 deploymentRun 登记之前：被拦下的请求不该留下 run 记录、不该占租约', () => {
    const source = read('src/routes/branches.ts');
    const slice = deployHandlerSlice(source);
    const guardAt = slice.indexOf('assessDeployLoop(');
    const runAt = slice.indexOf('deploymentRunService?.begin(');
    const leaseAt = slice.indexOf('beginBranchOperation(');
    expect(guardAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(guardAt);
    if (leaseAt > -1) expect(leaseAt).toBeGreaterThan(guardAt);
  });

  it('recordBuild 带上了 commitSha，否则判据永远数不到东西（形状 8：证据不成立）', () => {
    // 单独锚在 recordBuild 那一行取窗口：它离 requestCommitSha 有几十行，
    // 落在 deployHandlerSlice 的窗口之外。窗口收得很紧，避免退化成全文匹配。
    const source = read('src/routes/branches.ts');
    const at = source.indexOf('recordBuild(entry.projectId');
    expect(at).toBeGreaterThan(-1);
    // 按行匹配而不是 [^)]*：调用里嵌着 triggerFromRequest(req)，
    // 否定字符组跨不过它那个右括号 —— 判据会对着正确的代码判红。
    const call = source.slice(at, source.indexOf('\n', at));
    expect(call).toContain('deployLoopSha');
  });

  /**
   * Codex 在 PR #1453 的 P1：recordBuild 原先排在 beginBranchOperation **之前**，
   * 于是被协调器 409 拒掉、或合并进 pending 的请求也计了数。一次部署在途时
   * agent 连打六次同 SHA 重试，实际只产生一个 pending 部署，熔断计数却已满，
   * 把**下一个真实请求**429 掉——熔断的反效果。
   *
   * 判据要数的是「真实部署数」，所以只有拿到分支操作租约之后才算数。
   */
  it('recordBuild 必须排在取得分支操作租约之后，否则数的是请求数不是部署数', () => {
    const source = read('src/routes/branches.ts');
    const slice = deployHandlerSlice(source);
    const leaseAt = slice.indexOf('const branchOperationLease = beginBranchOperation(');
    const recordAt = slice.indexOf('recordBuild(entry.projectId');
    expect(leaseAt, '找不到租约获取').toBeGreaterThan(-1);
    expect(recordAt, '找不到 recordBuild').toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(leaseAt);
    // 还要在「没拿到租约就 return」那道闸之后，否则等于没挪
    const bailAt = slice.indexOf('cancelDeploymentRun(deploymentRun?.id, \'部署请求未取得分支操作租约\')');
    expect(bailAt, '找不到未取得租约的提前返回').toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(bailAt);
  });

  it('红用例：把 recordBuild 挪回租约之前，守卫必须变红', () => {
    const source = read('src/routes/branches.ts');
    const slice = deployHandlerSlice(source);
    const leaseAt = slice.indexOf('const branchOperationLease = beginBranchOperation(');
    const recordAt = slice.indexOf('recordBuild(entry.projectId');
    // 模拟回退：把 recordBuild 那一行搬到租约之前
    const line = slice.slice(recordAt, slice.indexOf('\n', recordAt) + 1);
    const regressed = slice.slice(0, leaseAt) + line + slice.slice(leaseAt, recordAt) + slice.slice(recordAt + line.length);
    expect(regressed.indexOf('recordBuild(entry.projectId'))
      .toBeLessThan(regressed.indexOf('const branchOperationLease = beginBranchOperation('));
  });

  it('红用例：把判定或拒绝摘掉，守卫必须变红', () => {
    const source = read('src/routes/branches.ts');
    const withoutAssess = deployHandlerSlice(source).replace(/assessDeployLoop\(/g, 'noopAssess(');
    expect(withoutAssess).not.toContain('assessDeployLoop(');
    const withoutReject = deployHandlerSlice(source).replace('res.status(429)', 'res.status(200)');
    expect(withoutReject).not.toContain('res.status(429)');
  });
});
