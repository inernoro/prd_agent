import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ApiError } from '../../web/src/lib/api.js';
import { projectUnavailable } from '../../web/src/lib/project-availability.js';
import { reduceBranchListState } from '../../web/src/lib/branch-list-state.js';

describe('项目读取失败的界面语义', () => {
  it('已删除项目明确返回列表，不引导检测技术栈', () => {
    expect(projectUnavailable(new ApiError(404, {}, 'not found'))).toContain('项目不存在或已删除');
  });
  it('无权限不泄露项目存在性，暂时失败留给刷新重试', () => {
    expect(projectUnavailable(new ApiError(403, {}, 'forbidden'))).toContain('登录和项目权限');
    expect(projectUnavailable(new ApiError(502, {}, 'gateway', undefined, true))).toBeNull();
    expect(projectUnavailable(new Error('offline'))).toBeNull();
  });
});

const page = fs.readFileSync(new URL('../../web/src/pages/BranchListPage.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('BranchListPage.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name: string) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (!node) throw new Error(`Missing production function: ${name}`);
  return node.getText(ast);
}
function callback(name: string) {
  const component = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'ProjectBranchList');
  if (!component) throw new Error('Missing production ProjectBranchList');
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name &&
        node.initializer && ts.isCallExpression(node.initializer)) found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(component);
  if (!found) throw new Error(`Missing production callback: ${name}`);
  return found.getText(ast);
}

// 执行真实页面回调；HTTP结果与React状态setter是边界夹具，不代浏览器验收。
async function runLoad(name: 'refresh' | 'confirmEmptyBranchList', project: unknown, branches: unknown[] = [], warm: boolean | 'empty' = false) {
  const old = { id: 'kept', projectId: 'current-project', status: 'running' };
  let state: any = warm ? {
    status: 'ok', project: { id: 'current-project', name: '原项目', branchCount: warm === 'empty' ? 0 : 1 },
    branches: warm === 'empty' ? [] : [old], lastKnownGoodBranches: warm === 'empty' ? [] : [old], remoteBranches: [],
  } : { status: 'loading' };
  const requests: string[] = [];
  const ctx: any = {
    ApiError, projectUnavailable, reduceBranchListState, projectId: 'current-project', canManageConsole: false,
    setState: (next: any) => { state = typeof next === 'function' ? next(state) : next; },
    apiRequest: async (url: string) => {
      requests.push(url);
      if (url === '/api/projects/current-project') {
        if (project instanceof Error) throw project;
        return project;
      }
      if (url.startsWith('/api/branches?')) return { branches };
      if (url.includes('/preview-mode')) return { mode: 'multi' };
      if (url.includes('/build-profiles')) return { profiles: [] };
      return {};
    },
    confirmEmptyBranchList: async () => {},
  };
  vm.createContext(ctx);
  const code = ['applyBranchListAction', 'fallbackProjectSummary', 'readableError'].map(declaration).join('\n') +
    `\nglobalThis.load = ${callback(name)};`;
  vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, ctx);
  await ctx.load();
  return { state, requests };
}

function runEnvNotice(state: unknown, kind: 'missing-required' | 'pending-env') {
  let effect: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' &&
        node.arguments[0]?.getText(ast).includes(`:${kind}:`)) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!effect) throw new Error(`Missing production notice effect: ${kind}`);
  const notices: any[] = [];
  const ctx = {
    state, projectId: 'current-project', noticeProject: { name: '原项目', slug: 'old-project' },
    pendingEnvKeys: ['TEST_ONLY'], missingRequiredKeys: ['TEST_ONLY'],
    window: { dispatchEvent: (event: any) => notices.push(event.detail) },
    CustomEvent: class { constructor(public type: string, public detail: unknown) { Object.assign(this, detail); } },
    displayName: (project: any) => project.name,
    projectEnvSettingsHref: () => '/project/current-project/settings',
  };
  vm.runInNewContext(ts.transpileModule(`(${effect.getText(ast)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, ctx);
  return notices;
}

describe('项目权威失效后不发布配置死链通知', () => {
  for (const kind of ['missing-required', 'pending-env'] as const) {
    it(`${kind} 在权威失败后即使缓存项目和配置键仍存在也不发通知`, async () => {
      for (const status of [401, 403, 404]) {
        const { state } = await runLoad('refresh', new ApiError(status, {}, 'unavailable'), [], true);
        expect(runEnvNotice(state, kind)).toEqual([]);
      }
    });
    it(`${kind} 保留真实可用项目提醒并抑制元信息降级提醒`, async () => {
      const { state } = await runLoad('refresh', { id: 'current-project', name: '真实项目', branchCount: 0 });
      const notices = runEnvNotice(state, kind);
      expect(notices).toHaveLength(1);
      expect(notices[0].id).toBe(`branch:current-project:${kind}:TEST_ONLY`);
      expect(runEnvNotice({ ...state, projectWarning: 'gateway' }, kind)).toEqual([]);
    });
  }
});

describe('真实分支页项目读取回调', () => {
  for (const name of ['refresh', 'confirmEmptyBranchList'] as const) {
    for (const status of [401, 403, 404]) {
      it(`${name} 对权威${status}撤销可操作项目状态`, async () => {
        const { state, requests } = await runLoad(name, new ApiError(status, {}, 'unavailable'), [], true);
        expect(requests).toContain('/api/projects/current-project');
        expect(state.status).toBe('unavailable');
        expect(state).not.toHaveProperty('project');
        expect(state).not.toHaveProperty('branches');
        expect(state.message).toContain(status === 404 ? '项目不存在或已删除' : '登录和项目权限');
      });
    }
    it(`${name} 暂时元信息失败仍保留已确认分支`, async () => {
      const kept = { id: 'kept', projectId: 'current-project', status: 'running' };
      const { state } = await runLoad(name, new ApiError(502, {}, 'gateway', undefined, true), [kept], true);
      expect(state.status).toBe('ok');
      expect(state.branches).toEqual([kept]);
      expect(state.projectWarning).toContain('gateway');
    });
  }
  it('首次元信息失败且无分支时不构造新项目引导', async () => {
    const { state } = await runLoad('refresh', new Error('offline'));
    expect(state.status).toBe('error');
    expect(state.message).toContain('项目读取失败');
  });
  it('临时元信息失败与空列表不能抹掉已确认分支', async () => {
    const { state } = await runLoad('refresh', new ApiError(502, {}, 'gateway', undefined, true), [], true);
    expect(state.status).toBe('ok');
    expect(state.branches.map((b: any) => b.id)).toEqual(['kept']);
    expect(state.lastKnownGoodBranches.map((b: any) => b.id)).toEqual(['kept']);
    expect(state.projectWarning).toContain('gateway');
  });
  it('临时元信息失败仍保留已确认的真实空项目', async () => {
    const { state } = await runLoad('refresh', new ApiError(502, {}, 'gateway', undefined, true), [], 'empty');
    expect(state.status).toBe('ok');
    expect(state.branches).toEqual([]);
    expect(state.lastKnownGoodBranches).toEqual([]);
    expect(state.projectWarning).toContain('gateway');
  });
  it('真实项目成功读取仍正常显示确认的空项目', async () => {
    const { state } = await runLoad('refresh', { id: 'current-project', name: '真实项目', branchCount: 0 });
    expect(state.status).toBe('ok');
    expect(state.project.name).toBe('真实项目');
    expect(state.branches).toEqual([]);
  });
});
