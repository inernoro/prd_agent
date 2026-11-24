import {describe,it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {ReleaseComparisonReader} from '../../src/services/release-comparison.js';
const a='a'.repeat(40), b='b'.repeat(40), base='c'.repeat(40);
describe('固定版本文件比较',()=>{
 it('区分生产、主干和重叠文件，保留特殊文件名',async()=>{
  const reader=new ReleaseComparisonReader(()=>'/repo',undefined,args=>args.includes('merge-base')?base:args.includes(a)?'shared.ts\0main.ts\0':'shared.ts\0production\nname.ts\0');
  const result=await reader.read('p',a,b);
  expect(result.baseSha).toBe(base);expect(result.overlapCount).toBe(1);
  expect(result.files).toContainEqual({path:'production\nname.ts',side:'production'});
  expect(result.conflictStatus).toBe('not-checked');
 });
 it('Git 失败不能判为零差异',async()=>{
  const r=await new ReleaseComparisonReader(()=>'/repo',undefined,()=>{throw Error('failed')}).read('p',a,b);
  expect(r.reason).toBeTruthy();expect(r.overlapCount).toBeUndefined();
 });
 it('不完整路径输出不能当作完整差异',async()=>{
  const r=await new ReleaseComparisonReader(()=>'/repo',undefined,args=>args.includes('merge-base')?base:'incomplete').read('p',a,b);
  expect(r.reason).toBeTruthy();expect(r.productionFileCount).toBeUndefined();
 });
 it('长列表先展示双方重叠文件，不被前 200 个单方文件挤掉', async () => {
  const production = [...Array.from({ length: 205 }, (_, i) => `a-${i}.ts`), 'z-shared.ts'].join('\0') + '\0';
  const reader = new ReleaseComparisonReader(() => '/repo', undefined, args =>
   args.includes('merge-base') ? base : args.includes(a) ? 'z-shared.ts\0' : production);
  const result = await reader.read('p', a, b);
  expect(result.overlapCount).toBe(1);
  expect(result.files[0]).toEqual({ path: 'z-shared.ts', side: 'both' });
  expect(result.truncated).toBe(true);
 });
 it('无效或选项形状的提交不执行 Git',async()=>{
  let calls=0;const r=await new ReleaseComparisonReader(()=>'/repo',undefined,()=>{calls++;return ''}).read('p','--help',b);
  expect(calls).toBe(0);expect(r.reason).toBeTruthy();
 });
 it('只读命令不 fetch、不切换、不修改索引',async()=>{
  const commands:string[]=[];const reader=new ReleaseComparisonReader(()=>'/repo',undefined,args=>{commands.push(args[2]);return args.includes('merge-base')?base:''});
  await reader.read('p',a,b);await reader.read('p',a,b);
  expect(commands).toEqual(['merge-base','diff','diff']);
 });
 it('在真实分叉仓库上比较固定 SHA，保留未提交文件与当前分支', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-comparison-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  try {
   git('init', '-b', 'main');
   git('config', 'user.name', 'Comparison fixture');
   git('config', 'user.email', 'comparison@example.invalid');
   fs.writeFileSync(path.join(root, 'shared.ts'), 'base\n');
   git('add', '.'); git('commit', '-m', 'base');
   const baseSha = git('rev-parse', 'HEAD').trim();
   fs.writeFileSync(path.join(root, 'shared.ts'), 'main\n');
   fs.writeFileSync(path.join(root, 'main.ts'), 'main\n');
   git('add', '.'); git('commit', '-m', 'main');
   const mainSha = git('rev-parse', 'HEAD').trim();
   git('checkout', '-b', 'hotfix', baseSha);
   fs.writeFileSync(path.join(root, 'shared.ts'), 'hotfix\n');
   fs.writeFileSync(path.join(root, 'hotfix.ts'), 'hotfix\n');
   git('add', '.'); git('commit', '-m', 'hotfix');
   const productionSha = git('rev-parse', 'HEAD').trim();
   fs.writeFileSync(path.join(root, 'shared.ts'), 'uncommitted data\n');
   const before = git('status', '--porcelain');
   const reader = new ReleaseComparisonReader(() => root, undefined, args =>
    execFileSync('git', [...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
   const result = await reader.read('fixture', mainSha, productionSha);
   expect(result).toMatchObject({ baseSha, mainFileCount: 2, productionFileCount: 2, overlapCount: 1, conflictStatus: 'not-checked' });
   expect(result.files).toContainEqual({ path: 'shared.ts', side: 'both' });
   expect(git('status', '--porcelain')).toBe(before);
   expect(git('branch', '--show-current').trim()).toBe('hotfix');
   expect(fs.readFileSync(path.join(root, 'shared.ts'), 'utf8')).toBe('uncommitted data\n');
  } finally {
   fs.rmSync(root, { recursive: true, force: true });
  }
 });
});
