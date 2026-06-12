import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseCenterSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/ReleaseCenterPage.tsx'),
  'utf8',
);

const branchListSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchListPage.tsx'),
  'utf8',
);

function stringLiterals(source: string): string[] {
  const literals: string[] = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    literals.push(match[2]);
  }
  return literals;
}

describe('release site publishing UI contract', () => {
  it('keeps the release center in site publishing language', () => {
    expect(releaseCenterSource).toContain('站点发布');
    expect(releaseCenterSource).toContain('还没有站点发布目标');
    expect(releaseCenterSource).toContain('添加站点发布');
    expect(releaseCenterSource).toContain('选择服务器');
    expect(releaseCenterSource).toContain('站点目录');
    expect(releaseCenterSource).toContain('./fast.sh');
    expect(releaseCenterSource).toContain('./exec_dep.sh');
    expect(releaseCenterSource).toContain('上线地址');
    expect(releaseCenterSource).toContain('发布记录');
    expect(releaseCenterSource).toContain('响应时间');
    expect(releaseCenterSource).toContain('最近检查');
    expect(releaseCenterSource).toContain('回滚策略');
    expect(releaseCenterSource).toContain('选择目标版本');
    expect(releaseCenterSource).toContain('确认回滚');
    expect(releaseCenterSource).toContain('重试发布');
    expect(releaseCenterSource).toContain('calc(100vw - 32px)');
  });

  it('keeps raw SSH target terminology out of visible release center copy', () => {
    const text = stringLiterals(releaseCenterSource).join('\n');
    expect(text).not.toContain('SSH Target');
    expect(text).not.toContain('App Path');
    expect(text).not.toContain('Deploy Command');
    expect(text).not.toContain('Health URL');
    expect(text).not.toContain('ReleaseRun');
  });

  it('keeps branch release confirmation in user-facing site language', () => {
    expect(branchListSource).toContain('从已验收预览分支发布到站点。');
    expect(branchListSource).toContain('发布站点');
    expect(branchListSource).toContain('发布确认');
    expect(branchListSource).toContain('发布目标');
    expect(branchListSource).toContain('服务器');
    expect(branchListSource).toContain('目录');
    expect(branchListSource).toContain('执行脚本');
    expect(branchListSource).toContain('发布脚本可执行');
    expect(branchListSource).toContain('上线地址');
    expect(branchListSource).toContain('开始发布');
    expect(branchListSource).toContain('等待发布日志');
    expect(branchListSource).toContain('calc(100vw - 32px)');
  });

  it('shows release run progress as business steps, not raw logs only', () => {
    expect(branchListSource).toContain('连接服务器');
    expect(branchListSource).toContain('进入站点目录');
    expect(branchListSource).toContain('执行 ${scriptOne.replace');
    expect(branchListSource).toContain('执行 ${scriptTwo.replace');
    expect(branchListSource).toContain('检查上线地址');
    expect(branchListSource).toContain('标记完成');
    expect(branchListSource).toContain('ReleaseRunStepList');
  });

  it('keeps raw SSH target terminology out of visible branch release copy', () => {
    const text = stringLiterals(branchListSource).join('\n');
    expect(text).not.toContain('SSH target');
    expect(text).not.toContain('SSH Target');
    expect(branchListSource).not.toMatch(/>\s*ReleaseRun\s*</);
    expect(branchListSource).not.toMatch(/['"`]ReleaseRun['"`]/);
  });
});
