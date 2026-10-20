import { describe, expect, it } from 'vitest';
import type { DirectoryUser } from '@/services/real/directory';
import { matchPastedMember, memberSearchQuery, mergeMemberIds, uniquePastedMemberNames } from './releaseMemberMatching';
import workflow from './ReleaseWorkflowDetail.tsx?raw';
import hook from './useReleasePastedMembers.ts?raw';

const user = (userId: string, displayName: string): DirectoryUser => ({ userId, displayName, username: `account-${userId}` });

describe('正式申领企微成员批量识别', () => {
  it('示例中的四位缺姓成员分别唯一匹配，不依赖产品成员列表', () => {
    const names = ['嘉颖', '宇凡', '舒怀', '宇鹏'];
    const directory = [user('a', '陈嘉颖'), user('b', '张宇凡'), user('c', '李舒怀'), user('d', '王宇鹏')];
    expect(names.map((name) => matchPastedMember(name, directory).userId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('完整姓名优先，重复目录 ID 不构成同名', () => {
    const exact = user('a', '张宇鹏');
    const result = matchPastedMember(' 张宇鹏 ', [exact, exact, user('b', '欧阳张宇鹏')]);
    expect(result.status).toBe('matched');
    expect(result.userId).toBe('a');
  });

  it('缺姓重名和全名重名均需要人工选，不选第一人', () => {
    const result = matchPastedMember('宇鹏', [user('a', '张宇鹏'), user('b', '李宇鹏')]);
    expect(result.status).toBe('ambiguous');
    expect(result.userId).toBeUndefined();
    expect(result.candidates.map((item) => item.userId)).toEqual(['a', 'b']);
    expect(matchPastedMember('张宇鹏', [user('a', '张宇鹏'), user('c', '张宇鹏')]).status).toBe('ambiguous');
  });

  it('不猜单字、谐音、超长后缀或仅用户名相似的账号', () => {
    for (const name of ['鹏', '宇朋', 'abc']) {
      expect(matchPastedMember(name, [user('a', '张宇鹏')]).status).toBe('missing');
    }
    expect(matchPastedMember('宇鹏', [user('a', '某个团队的宇鹏')]).status).toBe('missing');
    expect(matchPastedMember('宇鹏', [{ ...user('a', '其他人'), username: '宇鹏' }]).status).toBe('missing');
  });

  it('目录达到 50 条上限时不能宣称唯一匹配', () => {
    const directory = [user('a', '张宇鹏'), ...Array.from({ length: 49 }, (_, index) => user(`other-${index}`, `其他${index}`))];
    const result = matchPastedMember('宇鹏', directory);
    expect(result.status).toBe('limited');
    expect(result.userId).toBeUndefined();
  });

  it('重复粘贴追加去重，保留负责人和手动已选成员', () => {
    expect(uniquePastedMemberNames([' 嘉颖 ', '宇凡', '嘉颖', ''])).toEqual(['嘉颖', '宇凡']);
    expect(mergeMemberIds(['owner', 'manual', 'a'], ['a', 'b', 'b'])).toEqual(['owner', 'manual', 'a', 'b']);
  });

  it('将姓名按正则字面量查询，不解释姓名内的表达式', () => {
    expect(memberSearchQuery(' 张(宇鹏)+ ')).toBe('张\\(宇鹏\\)\\+');
  });

  it('使用登录态目录，限制并发并丢弃旧批次；应用切换保留正式申领成员', () => {
    expect(hook).toContain('searchDirectoryUsers(memberSearchQuery(name), 50, { signal: request.signal, timeoutMs: 10000 })');
    expect(hook).toContain('controller.current?.abort()');
    expect(hook).toContain('Math.min(4, pending.length)');
    expect(hook).toContain('if (current !== sequence.current) return;');
    expect(workflow).toContain('if (temporary) setTeamIds(ownerId ? [ownerId] : []);');
    expect(workflow).toContain('if (!pastedMembers.matches.length) setProjectMembers');
    expect(workflow).toContain('pastedMembers.pendingCount > 0');
    expect(workflow).toContain('对应多位成员，请选择');
  });
});

describe('正式申领字段和开放规则', () => {
  it('两个冗余输入仅在未调整的临时优化路径保留', () => {
    expect(workflow).toContain('{temporary && <Field label="合同签订方">');
    expect(workflow).toContain('{temporary && <Field label="项目需求描述">');
    expect(workflow).toContain('...(temporary ? {');
  });

  it('以方案或手填项目类别派生开放状态，提交同一有效值', () => {
    expect(workflow).toContain('selectedInitiation ? selectedInitiation.projectType : projectType');
    expect(workflow).toContain("effectiveProjectType === 'standard' ? 'yes' : 'no'");
    expect(workflow).toContain("if (temporary && parsed.isGlobalOpen != null)");
    expect(workflow).toContain("isGlobalOpen: effectiveGlobalOpen === '' ? undefined : effectiveGlobalOpen === 'yes'");
    expect(workflow).toContain('projectType: effectiveProjectType');
    expect(workflow).toContain('openBrandScope: effectiveOpenBrandScope');
    expect(workflow).toContain("editableOpenBrandScope.trim() || '非全域开放'");
  });
});
