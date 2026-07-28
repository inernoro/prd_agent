/**
 * 复用已存在 infra 容器时的体检必须**两项都查**（Codex PR #1275 十一轮 P2）。
 *
 * 日志限额与 `cds.protected=true` 标记都只在 `docker run` 那条路径上生效，而升级
 * 过来的存量部署走的全是复用路径（容器早就在跑）。docker 又无法给已存在容器补
 * label / 改 log-opt —— 唯一出路是重建，重建会断连，脚本不该自作主张。所以只能
 * 体检 + 明示补救。
 *
 * 早期版本只查日志限额：一个已经有 max-size、却没有保护标记的老容器**一声不吭地
 * 通过体检**，而运维手册里那条 `--filter label!=cds.protected=true` 的清理命令照样
 * 能在它停止后把它 prune 掉 —— 恰恰是这条标记要保护的东西（CDS 状态库 mongo、
 * 全部 infra）。
 *
 * 这里钉结构契约：inspect 必须同时读两个字段，两项分别判、分别报。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../src/services/container.ts', import.meta.url), 'utf8');

describe('复用 infra 容器的体检', () => {
  it('inspect 同时读日志限额与保护标记两个字段', () => {
    expect(src, 'docker inspect 必须一次取出 max-size 与 cds.protected').toMatch(
      /max-size.*\{\{index \.Config\.Labels "cds\.protected"\}\}/,
    );
  });

  it('两项分别判定：只有其中一项缺失也要告警', () => {
    expect(src).toMatch(/missing\.push\('日志限额/);
    expect(src).toMatch(/missing\.push\('保护标记/);
    // 「有限额就直接 return」的旧写法不许再出现——那正是漏掉标记的原因
    expect(src, '不许在只看 max-size 之后就 return').not.toMatch(
      /const maxSize = \(r\.stdout \|\| ''\)\.trim\(\)[\s\S]{0,80}if \(maxSize\) return;/,
    );
  });

  it('告警事件带上两项各自的缺失标记，便于运维筛选', () => {
    expect(src).toMatch(/action: 'infra\.protection-audit\.missing'/);
    expect(src).toMatch(/missingLogLimit: !maxSize/);
    expect(src).toMatch(/missingProtectedLabel: !hasProtection/);
  });

  it('体检仍挂在两条复用路径上（running 复用 + docker start 唤醒）', () => {
    const hits = src.match(/await this\.auditInfraLogLimit\(service\);/g) || [];
    expect(hits.length, '复用与唤醒两条路径都要体检').toBeGreaterThanOrEqual(2);
  });

  it('体检失败不影响复用（不能因为体检本身把部署挡住）', () => {
    expect(src).toMatch(/\/\* 体检失败不影响复用 \*\//);
  });
});
