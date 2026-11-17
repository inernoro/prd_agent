import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ReleaseGovernanceGit, resolveReleaseProjectRepository, type GovernanceGitRunner } from '../../src/services/release-governance-git.js';
import { StateService } from '../../src/services/state.js';

describe('发布治理的真实隔离合并', () => {
  let root: string, repo: string, basis: string, reader: ReleaseGovernanceGit;
  const native: GovernanceGitRunner = async (args, cwd, isolated) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0',
      ...(isolated ? { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } : {}) } });
    return { stdout: result.stdout || '', exitCode: result.status };
  };
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const commit = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content); git('add', '--', file); git('commit', '-m', '测试变更');
    return git('rev-parse', 'HEAD');
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-governance-git-test-')); repo = path.join(root, 'source');
    fs.mkdirSync(repo); git('init','-b','main'); git('config','user.name','发布治理测试'); git('config','user.email','release@example.invalid');
    basis = commit('shared.txt', 'base\n');
    const remote = path.join(root, 'origin.git');
    spawnSync('git', ['init','--bare',remote], { encoding: 'utf8' });
    git('remote','add','origin',remote); git('push','origin','main');
    reader = new ReleaseGovernanceGit(() => repo, () => 'main', native);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  it('迁移的本地项目可核验真实回退仓库，未克隆的远端项目及不存在项目仍不可用',async()=>{
    const state=new StateService(path.join(root,'state.json'),repo);state.load();
    const now=new Date().toISOString();
    state.addProject({id:'legacy-local',slug:'legacy-local',name:'旧本地项目',kind:'git',createdAt:now,updatedAt:now});
    state.addProject({id:'uncloned',slug:'uncloned',name:'未克隆远端项目',kind:'git',gitRepoUrl:'https://example.invalid/not-cloned.git',createdAt:now,updatedAt:now});
    const resolved=new ReleaseGovernanceGit(id=>resolveReleaseProjectRepository(state,id,repo),()=> 'main',native);
    expect((await resolved.inspect('legacy-local',basis,basis))).toMatchObject({status:'clean',candidateSha:basis,mainSha:basis,includesBaseline:true});
    expect(await resolved.resolveCommit('legacy-local',basis.slice(0,7))).toBe(basis);
    for(const id of ['uncloned','missing']){
      expect(resolveReleaseProjectRepository(state,id,repo)).toBeUndefined();
      expect((await resolved.inspect(id,basis,basis)).status).toBe('unknown');
    }
    await state.flush();
  });
  it('从真实仓库解析旧短提交，拒绝未知与非提交输入',async()=>{
    expect(await reader.resolveCommit('p',basis.slice(0,7))).toBe(basis);
    await expect(reader.resolveCommit('p','--help')).rejects.toThrow('有效提交');
    await expect(reader.resolveCommit('p','fffffff')).rejects.toThrow('无法唯一核实');
  });
  it('真实文本冲突被检出，原索引、未提交内容和分支不变', async () => {
    commit('shared.txt','main\n'); git('push','origin','main');
    git('checkout','-b','hotfix',basis); const candidate = commit('shared.txt','hotfix\n');
    fs.writeFileSync(path.join(repo,'shared.txt'),'未提交内容\n');
    const status = git('status','--porcelain'), index = fs.readFileSync(path.join(repo,'.git/index'));
    const result = await reader.inspect('p',candidate,basis);
    expect(result.status).toBe('conflicts'); expect(result.conflicts).toEqual(['shared.txt']);
    expect(git('status','--porcelain')).toBe(status); expect(git('branch','--show-current')).toBe('hotfix');
    expect(fs.readFileSync(path.join(repo,'.git/index'))).toEqual(index);
    expect(fs.readFileSync(path.join(repo,'shared.txt'),'utf8')).toBe('未提交内容\n');
  });
  it('同文件产生相同结果时不把重叠误报为真实冲突', async () => {
    commit('shared.txt','same\n'); git('push','origin','main');
    git('checkout','-b','hotfix',basis); const candidate = commit('shared.txt','same\n');
    const result = await reader.inspect('p',candidate,basis);
    expect(result.status).toBe('clean'); expect(result.conflicts).toEqual([]); expect(result.includesBaseline).toBe(true);
  });
  it('累计检查包含已回退的越界修改与含换行的真实路径', async () => {
    git('checkout','-b','hotfix'); commit('outside.txt','once\n'); git('rm','outside.txt'); git('commit','-m','撤回越界改动');
    const candidate = commit('allowed/line\nname.txt','hello\n');
    const result = await reader.inspect('p',candidate,basis);
    expect(result.status).toBe('clean'); expect(result.changedPaths).toContain('outside.txt');
    expect(result.changedPaths).toContain('allowed/line\nname.txt');
    expect(result.changedPaths.every(p => !p.startsWith('\n'))).toBe(true);
  });
  it('吸收当前生产基线只计调试分支新增范围，不改变原索引、内容或对象库',async()=>{
    git('checkout','-b','debug');commit('allowed/ui.txt','debug\n');
    git('checkout','main');const production=commit('infra/hotfix.txt','already live\n');git('push','origin','main');
    git('checkout','debug');git('merge','--no-ff','main','-m','吸收线上基线');const candidate=git('rev-parse','HEAD');
    fs.writeFileSync(path.join(repo,'untracked.txt'),'保留未提交内容');
    const index=fs.readFileSync(path.join(repo,'.git/index')),status=git('status','--porcelain'),objects=git('count-objects','-v');
    const result=await reader.inspect('p',candidate,production);
    expect(result).toMatchObject({status:'clean',includesBaseline:true,changedPaths:['allowed/ui.txt']});
    expect(fs.readFileSync(path.join(repo,'.git/index'))).toEqual(index);expect(git('status','--porcelain')).toBe(status);
    expect(git('count-objects','-v')).toBe(objects);expect(git('branch','--show-current')).toBe('debug');
  });
  for(const octopus of [false,true])it(`合并时新增又在后续合并撤回的越界路径仍累计检查：${octopus?'多父合并':'双父合并'}`,async()=>{
    git('checkout','-b','side-a');commit('allowed/a.txt','one\n');
    if(octopus){git('checkout','-b','side-b',basis);commit('allowed/b.txt','one\n');}
    git('checkout','-b','debug',basis);commit('allowed/ui.txt','debug\n');
    git('merge','--no-ff','--no-commit','side-a',...(octopus?['side-b']:[]));
    commit('outside.txt','introduced only in merge\n');
    git('checkout','side-a');commit('allowed/a2.txt','two\n');
    if(octopus){git('checkout','side-b');commit('allowed/b2.txt','two\n');}
    git('checkout','debug');git('merge','--no-ff','--no-commit','side-a',...(octopus?['side-b']:[]));
    git('rm','outside.txt');git('commit','-m','合并时撤回越界');const candidate=git('rev-parse','HEAD');
    expect(git('diff','--name-only',basis,candidate)).not.toContain('outside.txt');
    const result=await reader.inspect('p',candidate,basis);
    expect(result.status).toBe('clean');expect(result.changedPaths).toContain('outside.txt');
  });
  it('从可信 PR 引用取齐对象并核对完整 head，拒绝错配版本', async () => {
    git('checkout','-b','hotfix'); const head = commit('allowed/ui.txt','review\n');
    git('push','origin',`${head}:refs/pull/7/head`);
    expect(await reader.includesPr('p',basis,7,head)).toBe(true);
    await expect(reader.includesPr('p',basis,7,basis)).rejects.toThrow('PR 已变化');
    await expect(reader.includesPr('p',basis,8,head)).rejects.toThrow('PR 已变化');
  });
  it('PR 和主干改写历史后刷新跟踪引用，不改本地主干或工作区',async()=>{
    git('checkout','-b','hotfix');const first=commit('allowed/first.txt','first\n');
    git('push','origin',`${first}:refs/pull/9/head`);
    expect(await reader.includesPr('p',basis,9,first)).toBe(true);
    git('checkout','--detach',basis);const rewritten=commit('allowed/rebased.txt','rebased\n');
    git('push','--force','origin',`${rewritten}:refs/pull/9/head`);
    expect(await reader.includesPr('p',basis,9,rewritten)).toBe(true);
    git('push','--force','origin',`${rewritten}:main`);
    git('update-ref','refs/remotes/origin/main',first);
    const index=fs.readFileSync(path.join(repo,'.git/index'));
    const check=await reader.inspect('p',rewritten,basis);
    expect(check).toMatchObject({status:'clean',mainSha:rewritten});
    expect(git('rev-parse','main')).toBe(basis);expect(git('rev-parse','HEAD')).toBe(rewritten);
    expect(fs.readFileSync(path.join(repo,'.git/index'))).toEqual(index);
  });
  it('主干读取失败或没有仓库时保持未知，不生成通过结论', async () => {
    const broken = new ReleaseGovernanceGit(() => repo, () => 'main', async () => ({ stdout: '', exitCode: 128 }));
    expect((await broken.inspect('p',basis,basis)).status).toBe('unknown');
    const unavailable = new ReleaseGovernanceGit(() => undefined, () => 'main', native);
    expect((await unavailable.inspect('p',basis)).status).toBe('unknown');
  });
});
