import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { StateService } from '../src/services/state.js';
import { createTopologyRouter } from '../src/routes/topology.js';
import { IsolatedShellExecutor } from '../src/services/isolated-shell-executor.js';
import { ShellExecutor } from '../src/services/shell-executor.js';
import { shellQuoteArg } from '../src/services/secure-database-cli.js';
import { listenLoopbackFixture, getHttpFixtureTrace } from '../tests/helpers/loopback-http-fixture.js';
import { readReadyFixturePid } from '../tests/helpers/process-pid-fixture.js';

const referenceHead = '0bdd97a0fc4e943f3bee1620905a3a59c46b2d3d';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const sources = ['tests/routes/topology.test.ts', 'tests/services/isolated-shell-executor.test.ts',
  'tests/helpers/loopback-http-fixture.ts', 'tests/helpers/process-pid-fixture.ts',
  'src/routes/topology.ts', 'src/services/state.ts', 'src/services/isolated-shell-executor.ts',
  'scripts/default-regression-drill.ts'];
function originalFunction(text: string, name: string, dependencies: Record<string, unknown>) {
  const ast = ts.createSourceFile('fixed-original.ts', text, ts.ScriptTarget.ES2022, true);
  const declaration = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(declaration, `Missing actual original ${name}`);
  const source = declaration.getText(ast), compiled = ts.transpileModule(source,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return { sourceHash: digest(source), fn: new Function(...Object.keys(dependencies), `${compiled}\nreturn ${name};`)(...Object.values(dependencies)) };
}
async function listening(server: http.Server) {
  if (!server.listening) await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
}
async function main() {
  assert.ok(['darwin', 'linux'].includes(process.platform));
  const native = process.argv.includes('--native');
  if (native) { assert.equal(process.platform, 'linux'); assert.equal(process.env.GITHUB_ACTIONS, 'true'); }
  const output = path.resolve('default-regression-output'); await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cds-default-regression-')));
  const state = new StateService(path.join(root, 'state.json'));
  const servers: http.Server[] = [], pools: IsolatedShellExecutor[] = [];
  const report: Record<string, any> = { head: execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    referenceHead, platform: process.platform, node: process.version, native, verdict: 'failed', checks: [],
    sourceHashes: Object.fromEntries(await Promise.all(sources.map(async name => [name, digest(await fs.readFile(name))]))),
    historicalFirstFailureAttributed: false, actualApplicationDeploymentVerified: false, performanceVerified: false,
    privateFilesRemoved: false, ownedProcessesRemoved: false, ownedServersClosed: false };
  try {
    if (native) execFileSync('/usr/bin/git', ['fetch', '--depth', '1', 'origin', referenceHead], { stdio: 'pipe', timeout: 120000 });
    const oldHttp = execFileSync('/usr/bin/git', ['show', `${referenceHead}:cds/tests/routes/topology.test.ts`], { encoding: 'utf8' });
    const oldClose = execFileSync('/usr/bin/git', ['show', `${referenceHead}:cds/tests/services/isolated-shell-executor.test.ts`], { encoding: 'utf8' });
    report.referenceSourceHashes = { 'tests/routes/topology.test.ts': digest(oldHttp), 'tests/services/isolated-shell-executor.test.ts': digest(oldClose) };
    const request = originalFunction(oldHttp, 'request', { http }), wait = originalFunction(oldClose, 'waitFor', {});
    report.originalHelperHashes = { request: request.sourceHash, waitFor: wait.sourceHash };
    const yamlNode = ts.createSourceFile('original.ts', oldHttp, ts.ScriptTarget.ES2022, true).statements
      .flatMap(s => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : [])
      .find(d => d.name.getText() === 'CONFLICT_YAML')?.initializer;
    assert.ok(yamlNode && ts.isNoSubstitutionTemplateLiteral(yamlNode));
    const body = { composeYaml: yamlNode.text };
    const app = () => { const a = express(); a.use(express.json()); a.use('/api', createTopologyRouter({ stateService: state, assertProjectAccess: () => null })); return a; };
    report.stage = 'actual-original-http-listener';
    const legacy = app().listen(0); servers.push(legacy); await listening(legacy);
    let legacyArrivals = 0; legacy.prependListener('request', () => { legacyArrivals++; });
    const port = (legacy.address() as { port: number }).port;
    const other = express(); other.use((_req, res, next) => { res.setHeader('x-cds-probe-owner', 'private-other-fixture'); next(); });
    const foreign = http.createServer(other); servers.push(foreign);
    const collision = await new Promise<{ accepted: boolean; code?: string }>(resolve => {
      foreign.once('error', (e: NodeJS.ErrnoException) => resolve({ accepted: false, code: e.code }));
      foreign.listen(port, '127.0.0.1', () => resolve({ accepted: true }));
    });
    const original = await request.fn(legacy, 'POST', '/api/compose/lint', body);
    report.originalHttp = { listener: legacy.address(), otherListener: foreign.address(), collision,
      status: original.status, body: original.body, intendedListenerArrivals: legacyArrivals };
    if (process.platform === 'darwin') {
      assert.equal(collision.accepted, true); assert.equal(original.status, 404); assert.equal(legacyArrivals, 0);
      report.originalHttpAmbiguityReproduced = true;
    } else {
      assert.equal(collision.accepted, false); assert.equal(collision.code, 'EADDRINUSE');
      assert.equal(original.status, 200); report.originalHttpAmbiguityReproduced = false;
    }
    report.checks.push({ name: 'original-http-helper-actual-platform-bind-behavior', passed: true });
    report.stage = 'candidate-ipv4-identity';
    const candidate = listenLoopbackFixture(app()); servers.push(candidate); await listening(candidate);
    const ownedPort = (candidate.address() as { port: number }).port;
    const attempted = http.createServer(other); servers.push(attempted);
    const rejected = await new Promise<string>(resolve => { attempted.once('error', (e: NodeJS.ErrnoException) => resolve(e.code || 'unknown'));
      attempted.listen(ownedPort, '127.0.0.1', () => resolve('unexpectedly-bound')); });
    const actual = await request.fn(candidate, 'POST', '/api/compose/lint', body);
    assert.equal(rejected, 'EADDRINUSE'); assert.equal(actual.status, 200); assert.equal(actual.body.summary.errors, 2);
    assert.ok(actual.body.findings.some((f: any) => f.rule === 'prefix-conflict'));
    assert.ok(actual.body.findings.some((f: any) => f.rule === 'probe-in-prefix'));
    const trace = getHttpFixtureTrace(candidate)!; assert.equal(trace.arrivals.length, 1);
    assert.equal(trace.arrivals[0].localAddress, '127.0.0.1');
    report.candidateHttp = { listener: candidate.address(), refusedCompetingListener: rejected,
      status: actual.status, intendedListenerArrivals: trace.arrivals.length, originalContentAssertionsPassed: true };
    report.checks.push({ name: 'candidate-listener-exclusivity-and-original-response-content', passed: true });
    report.stage = 'actual-pid-file-open-before-write';
    report.pidCases = [];
    for (const mode of ['original', 'candidate'] as const) {
      const file = path.join(root, `${mode}.pid`), release = path.join(root, `${mode}.release`), sentinel = path.join(root, `${mode}.queued`);
      const pool = new IsolatedShellExecutor(new ShellExecutor(), { concurrency: 1 }); pools.push(pool);
      await pool.exec('true', { executionLane: 'observation', timeout: 5000 });
      const before = pool.getStats(); let ready!: (v: { pid: number; ppid: number }) => void;
      const empty = new Promise<{ pid: number; ppid: number }>(r => { ready = r; }); let buffer = '';
      const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},'');console.log(JSON.stringify({pid:process.pid,ppid:process.ppid}));
const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);fs.writeFileSync(${JSON.stringify(file)},process.pid+'\\n');setInterval(()=>{},1000)}},5);`;
      const running = pool.exec(`exec ${shellQuoteArg(process.execPath)} -e ${shellQuoteArg(script)}`, { executionLane: 'observation', timeout: 5000,
        onData: chunk => { buffer += chunk; if (buffer.includes('\n')) { ready(JSON.parse(buffer.split('\n')[0])); } } });
      const settled = running.then(() => ({ unexpectedlySucceeded: true }), (error: any) => ({ code: error.code }));
      const child = await empty; assert.ok(child.pid > 1); assert.equal(child.ppid, before.actors[0].pid);
      await wait.fn(async () => { try { await fs.access(file); return true; } catch { return false; } });
      assert.equal(await fs.readFile(file, 'utf8'), ''); assert.equal(await readReadyFixturePid(file), undefined);
      if (mode === 'candidate') {
        await fs.writeFile(release, 'release');
        await wait.fn(async () => (await readReadyFixturePid(file)) !== undefined);
        assert.equal(await readReadyFixturePid(file), child.pid);
      }
      const queued = pool.exec(`touch ${shellQuoteArg(sentinel)}`, { executionLane: 'observation', timeout: 5000 })
        .then(() => ({ unexpectedlySucceeded: true }), (error: any) => ({ code: error.code }));
      await pool.close(); assert.equal((await settled as any).code, 'closed'); assert.equal((await queued as any).code, 'closed');
      await assert.rejects(fs.access(sentinel));
      const raw = await fs.readFile(file, 'utf8'), recordedPid = Number(raw.trim());
      let killThrows = false; try { process.kill(recordedPid, 0); } catch { killThrows = true; }
      let state = ''; try { state = execFileSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,lstart=,stat=', '-p', String(child.pid)], { encoding: 'utf8' }).trim(); } catch {}
      assert.ok(!state || /\bZ\S*$/.test(state));
      if (mode === 'original') { assert.equal(recordedPid, 0); assert.equal(killThrows, false); }
      else assert.equal(recordedPid, child.pid);
      const pids = [before.supervisorPid!, before.factoryPid!, ...before.actors.map(a => a.pid)];
      const closures = pids.map(pid => { let state='';try{state=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8'}).trim();}catch{}return{pid,state}; });
      assert.ok(closures.every(row => !row.state || row.state.startsWith('Z')));
      report.pidCases.push({ mode, actualChild: child, recordedPid, recordedText: raw, originalKillInvariantThrows: killThrows,
        actualChildState: state, queuedDidNotExecute: true, actualPoolCleanupConfirmed: true, closures, after: pool.getStats() });
      report.checks.push({ name: `${mode}-actual-file-open-window-and-cleanup`, passed: true });
    }
    report.originalPidReadinessRaceReproduced = true; report.candidateRejectsEmptyPidAndWaitsCompleteLine = true;
    report.verdict = 'passed';
  } catch (error) { report.failure = { name: error instanceof Error ? error.name : 'Error' }; throw error; }
  finally {
    await Promise.all(pools.map(p => p.close())); report.ownedProcessesRemoved = true;
    await Promise.all(servers.map(s => s.listening ? new Promise<void>(r => s.close(() => r())) : Promise.resolve())); report.ownedServersClosed = true;
    await state.flush(); await fs.rm(root, { recursive: true, force: true }); report.privateFilesRemoved = true;
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.name : 'Error'); process.exitCode = 1; });
