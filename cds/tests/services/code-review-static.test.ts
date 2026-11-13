import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodeReviewStaticAnalysis } from '../../src/services/code-review-static.js';
import { buildZip } from '../../src/utils/zip.js';

const temporary: string[] = [];
async function executable(script: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-static-test-'));
  temporary.push(dir);
  const file = path.join(dir, 'analyzer');
  await fs.writeFile(file, '#!/usr/bin/env node\n' + script, { mode: 0o700 });
  return file;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

describe('fixed Semgrep static checks', () => {
  it('reports an explicit not-run note when optional tool is unavailable', async () => {
    const result = await runCodeReviewStaticAnalysis({ zip: buildZip([{ name: 'a.js', data: 'eval(input)' }]),
      signal: new AbortController().signal, executable: '/nonexistent/cds-semgrep' });
    expect(result.findings).toEqual([]);
    expect(result.notes[0]).toContain('静态检查未运行');
  });

  it('runs only the fixed local config in a private temporary directory, maps results and cleans up', async () => {
    const markerDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-static-marker-'));
    temporary.push(markerDir);
    const marker = path.join(markerDir, 'execution.json');
    const uploadedMarker = path.join(markerDir, 'uploaded-code-executed');
    const bin = await executable(`
      const fs=require('node:fs'), path=require('node:path');
      const args=process.argv.slice(2), source=args.at(-1), config=args[args.indexOf('--config')+1];
      const yaml=fs.readFileSync(config,'utf8');
      if(!yaml.includes('cds.python.eval') || !args.includes('--metrics=off') || !args.includes('--disable-version-check')) process.exit(3);
      fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),mode:fs.statSync(process.cwd()).mode & 511,args}));
      console.log(JSON.stringify({results:[{check_id:'cds.javascript.eval',path:path.join(source,'a.js'),start:{line:1},extra:{message:'动态 eval',severity:'WARNING',metadata:{category:'security'}}}],paths:{scanned:[path.join(source,'a.js')],skipped:[]},errors:[]}));
    `);
    const result = await runCodeReviewStaticAnalysis({ zip: buildZip([
      { name: 'a.js', data: `require('fs').writeFileSync(${JSON.stringify(uploadedMarker)},'executed')` },
      { name: '.semgrep.yml', data: 'rules: attacker-controlled' },
      { name: 'package.json', data: '{"scripts":{"prepare":"curl malicious"}}' },
    ]), signal: new AbortController().signal, executable: bin });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ filePath: 'a.js', line: 1, tool: 'Semgrep (cds.javascript.eval)', verified: false });
    const executed = JSON.parse(await fs.readFile(marker, 'utf8'));
    expect(executed.mode).toBe(0o700);
    expect(executed.args).toContain('--max-memory');
    await expect(fs.access(executed.cwd)).rejects.toThrow();
    await expect(fs.access(uploadedMarker)).rejects.toThrow();
  });

  it('preserves partial parse failures and ignores findings outside the verified snapshot', async () => {
    const bin = await executable(`console.log(JSON.stringify({results:[{check_id:'cds.python.eval',path:'/etc/passwd',extra:{message:'fake'}}],errors:[{type:'ParseError'}],paths:{scanned:[],skipped:['x.py']}}));`);
    const result = await runCodeReviewStaticAnalysis({ zip: buildZip([{ name: 'x.py', data: 'broken code' }]),
      signal: new AbortController().signal, executable: bin });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(' ')).toContain('1 项解析或执行错误');
    expect(result.notes.join(' ')).toContain('隔离目录外');
    expect(result.notes.join(' ')).toContain('成功扫描 0 个文件');
  });

  it.each(['process.exit(2)', 'console.log("invalid JSON")'])('does not claim a pass after tool failure: %s', async (script) => {
    const result = await runCodeReviewStaticAnalysis({ zip: buildZip([{ name: 'x.py', data: 'print(1)' }]),
      signal: new AbortController().signal, executable: await executable(script) });
    expect(result.findings).toEqual([]);
    expect(result.notes.join(' ')).toContain('静态检查未完成');
  });

  it('cancels the analyzer process instead of continuing after task cancellation', async () => {
    const controller = new AbortController();
    const run = runCodeReviewStaticAnalysis({ zip: buildZip([{ name: 'x.py', data: 'print(1)' }]),
      signal: controller.signal, executable: await executable('setInterval(()=>{},1000)') });
    setTimeout(() => controller.abort(new Error('cancelled-by-user')), 150);
    await expect(run).rejects.toThrow('cancelled-by-user');
  });

  it('rejects invalid source archives before launching the analyzer', async () => {
    await expect(runCodeReviewStaticAnalysis({ zip: Buffer.from('not a zip'), signal: new AbortController().signal,
      executable: '/nonexistent/cds-semgrep' })).rejects.toThrow();
  });

  it.skipIf(!process.env.CDS_TEST_SEMGREP_BIN)('detects real Python and JavaScript security and bug fixtures with Semgrep', async () => {
    const result = await runCodeReviewStaticAnalysis({ zip: buildZip([
      { name: 'unsafe.js', data: 'eval(userInput); if (value === NaN) { console.log(value); } require("child_process").exec(command);' },
      { name: 'unsafe.py', data: 'import subprocess\nvalue = eval(user_input)\nsubprocess.run(command, shell=True)\nassert (condition, "failure")\n' },
    ]), signal: new AbortController().signal, executable: process.env.CDS_TEST_SEMGREP_BIN });
    expect(result.findings.map((finding) => finding.tool)).toEqual(expect.arrayContaining([
      'Semgrep (cds.javascript.eval)', 'Semgrep (cds.javascript.nan-comparison)', 'Semgrep (cds.javascript.child-process-shell)',
      'Semgrep (cds.python.eval)', 'Semgrep (cds.python.shell-true)', 'Semgrep (cds.python.assert-tuple)',
    ]));
    expect(result.notes.join(' ')).toContain('成功扫描 2 个文件');
    expect(result.notes.join(' ')).not.toContain('未完成');
  }, 20_000);
});
