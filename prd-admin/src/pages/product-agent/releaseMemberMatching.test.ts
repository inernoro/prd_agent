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
    expect(workflow).toContain('if (temporary) setProjectMembers');
    expect(workflow).toContain('pastedMembers.pendingCount > 0');
    expect(workflow).toContain('对应多位成员，请选择');
  });

  it('正式申领只有一处成员区，识别与手动增删共用选中 ID 名单', () => {
    expect(workflow.match(/aria-label="项目组成员"/g)).toHaveLength(1);
    expect(workflow).toContain('{temporary && <Field label="项目组成员名称">');
    expect(workflow).toContain('useReleasePastedMembers(isNew && !temporary, addTeamMembers)');
    expect(workflow).toContain('setTeamIds((previous) => mergeMemberIds(previous, ids))');
    expect(workflow).toContain('selected={teamIds} onChange={setTeamIds}');
    expect(workflow).toContain('<UserSearchSelect value=""');
    expect(workflow).toContain('onChange(selected.filter((value) => value !== id))');
  });

  it('已选成员使用可换行的紧凑标签，保留可访问的单人移除按钮', () => {
    const selectedMembers = workflow.slice(workflow.indexOf('<section aria-label="已选项目成员"'), workflow.indexOf('<section aria-label="添加项目成员"'));
    expect(selectedMembers).toContain('className="flex min-h-0 flex-wrap items-start gap-2"');
    expect(selectedMembers).toContain('className="inline-flex max-w-full items-center gap-1');
    expect(selectedMembers).toContain('min-w-0 truncate text-xs text-token-primary');
    expect(selectedMembers).toContain('title={memberName(id)}');
    expect(selectedMembers).toContain('aria-label={`移除成员 ${memberName(id)}`}');
    expect(selectedMembers).toContain('onChange(selected.filter((value) => value !== id))');
    expect(selectedMembers).toContain('<X size={12} aria-hidden="true" />');
    expect(selectedMembers).not.toContain('justify-between');
    expect(selectedMembers).not.toContain('/>移除');
  });

  it('正式申领不提交另一份原文姓名，手动增删后由服务端按最终 ID 生成姓名', () => {
    const submission = workflow.slice(workflow.indexOf('const res = await createRelease('), workflow.indexOf('setBusy(false);', workflow.indexOf('const res = await createRelease(')));
    const beforeTemporary = submission.slice(0, submission.indexOf('...(temporary ? {'));
    const afterTemporary = submission.slice(submission.indexOf('} : {}),') + '} : {}),'.length);
    expect(beforeTemporary).not.toContain('projectMemberNames:');
    expect(afterTemporary).not.toContain('projectMemberNames:');
    expect(afterTemporary).toContain('teamMemberIds: teamIds');
    expect(submission).toMatch(/\.\.\.\(temporary \? \{\s+projectMemberNames:/);
  });
});

describe('正式申领字段和开放规则', () => {
  it('负责人直接使用搜索单选框，不需要加号展开或固定显示登录人', () => {
    const fieldStart = workflow.indexOf('<Field label="产品负责人 *">');
    const field = workflow.slice(fieldStart, workflow.indexOf('</Field>', fieldStart));
    expect(field).toContain('<UserSearchSelect value={ownerId} onChange={setOwnerId} placeholder="搜索并选择产品负责人" />');
    expect(field.match(/<UserSearchSelect/g)).toHaveLength(1);
    expect(field).not.toContain('currentUser?.displayName');
    expect(field).not.toContain('<button');
    expect(workflow).not.toContain('showOwnerPicker');
    expect(workflow).not.toContain('setShowOwnerPicker');
    expect(workflow).toContain("const [ownerId, setOwnerId] = useState(currentUser?.userId ?? '');");
    expect(workflow).toContain('ownerName: temporary ? ownerName.trim() || undefined : undefined');
  });

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
