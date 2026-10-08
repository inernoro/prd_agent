import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const read = (file: string) => fs.readFileSync(path.resolve('web/src', file), 'utf8');

describe('human project access UI wiring', () => {
  const list = read('pages/ProjectListPage.tsx');
  it('treats a scoped empty list as authoritative, not a reason to revive revoked cards', () => {
    expect(list).toMatch(/const canManageProjects = projectsRes\.canManageProjects !== false/);
    expect(list).toMatch(/if \(nextProjects\.length > 0 \|\| !canManageProjects\)/);
    expect(list).toMatch(/const suspiciousEmpty =\s*canManageProjects && nextProjects\.length === 0/);
  });
  it('hides owner actions and explains how an unassigned member gets access', () => {
    expect(list).toContain('center={canManageProjects ? (');
    expect(list).toContain('{canManageProjects ? <DropdownMenu');
    expect(list).toContain('canManageProjects={canManageProjects}');
    expect(list).toContain('还没有获授权的项目');
    expect(list).toContain('用户管理 → 项目授权');
  });
  it('binds the user selection to the persisted user ID and server-authoritative saved set', () => {
    const dialog = read('pages/cds-settings/components/UserProjectAccessDialog.tsx');
    expect(dialog).toContain('encodeURIComponent(user.id)');
    expect(dialog).toContain('method: \'PUT\', body: { projectIds: selected }');
    expect(dialog).toContain('setData(result)');
    expect(dialog).not.toMatch(/localStorage|sessionStorage/);
  });
});
