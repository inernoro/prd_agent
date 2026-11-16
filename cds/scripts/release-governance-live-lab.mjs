/** Disposable real Git/SSH/CDS acceptance fixture. Never connects to production. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const runtime = process.env.CDS_LAB_RUNTIME || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const requestedRoot = process.env.CDS_LAB_ROOT;
const root = await fs.realpath(requestedRoot
  ? await fs.mkdir(requestedRoot, { recursive: true }).then(() => requestedRoot)
  : await fs.mkdtemp(path.join(os.tmpdir(), 'cds-governance-live-')));
if ((await fs.readdir(root)).length) throw new Error('Lab root must be empty; existing data was preserved.');
await fs.mkdir(path.join(root,'cds')); await fs.mkdir(path.join(root,'.cds'));
const { StateService } = await import(pathToFileURL(path.join(runtime,'dist/services/state.js')).href);
const sshModule = await import(pathToFileURL(path.join(runtime,'node_modules/ssh2/lib/index.js')).href);
const { Server } = sshModule.default;
const password = crypto.randomBytes(24).toString('base64url');
const agentKey = process.env.CDS_LAB_AGENT_KEY || 'cdsp_lab_' + crypto.randomBytes(30).toString('base64url');
const username = process.env.CDS_PREVIEW_USERNAME || 'reviewer';
const humanPassword = process.env.CDS_PREVIEW_PASSWORD || crypto.randomBytes(24).toString('base64url');
const pair = crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const hostKey = pair.privateKey.export({type:'pkcs1',format:'pem'});
const sockets = new Set();
const children = new Set();
const ssh = new Server({hostKeys:[hostKey]}, client => {
  sockets.add(client); client.on('error',()=>{}); client.on('close',()=>sockets.delete(client));
  client.on('authentication', context => {
    if (context.method === 'password' && context.username === 'lab' && context.password === password) context.accept(); else context.reject();
  });
  client.on('ready',() => client.on('session',(accept) => {
    const session = accept();
    session.on('pty', accept => accept());
    const commands = new Set();
    session.on('signal', (accept, _reject, info) => {
      for (const child of commands) if (child.exitCode === null) child.kill(info.name === 'KILL' ? 'SIGKILL' : 'SIGTERM');
      accept?.();
    });
    session.on('exec',(accept,_reject,info) => {
      const stream = accept();
      // This is the disposable target's real shell, with no parent credentials in its environment.
      const child = spawn('/bin/sh',['-c',info.command],{cwd:root,env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});
      children.add(child); commands.add(child); child.stdout.on('data',data=>stream.write(data)); child.stderr.on('data',data=>stream.stderr.write(data));
      child.on('close',code=>{children.delete(child);commands.delete(child);stream.exit(code ?? 1);stream.end();});
      stream.on('close',()=>{if(child.exitCode===null) child.kill('SIGTERM');});
    });
  }));
});
await new Promise(resolve=>ssh.listen(0,'127.0.0.1',resolve));
const sshPort = ssh.address().port;
const repo = path.join(root,'project'), origin = path.join(root,'origin.git'), debug = path.join(root,'debug'), conflict = path.join(root,'conflict');
await fs.mkdir(repo);
const git = (...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
execFileSync('git',['init','--bare','--initial-branch=main',origin],{stdio:'ignore'});
git('init','-b','main'); git('config','user.name','CDS 发布治理隔离验收'); git('config','user.email','release-lab@example.invalid');
git('remote','add','origin',origin);
await fs.mkdir(path.join(repo,'allowed'));
const marker = path.join(root,'live-version'), effects = path.join(root,'deploy-effects.jsonl');
await fs.writeFile(marker,'not-published\n');
await fs.writeFile(path.join(repo,'release.sh'),`#!/bin/sh\nset -eu\nprintf '%s\\n' "$CDS_COMMIT_SHA" > '${marker}'\nprintf '%s %s\\n' "$CDS_RELEASE_ID" "$CDS_COMMIT_SHA" >> '${effects}'\n`);
await fs.chmod(path.join(repo,'release.sh'),0o755);
await fs.writeFile(path.join(repo,'allowed/app.txt'),'base\n');git('add','.');git('commit','-m','初始化真实 Git 与 SSH 验收项目');
const ancestor = git('rev-parse','HEAD');
await fs.writeFile(path.join(repo,'allowed/app.txt'),'main baseline\n');git('add','.');git('commit','-m','主干初始版本');
const main = git('rev-parse','HEAD');git('push','origin','main');
git('worktree','add',debug,'-b','lab/debug',main);
const debugGit = (...args)=>execFileSync('git',['-C',debug,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
await fs.writeFile(path.join(debug,'allowed/ui.txt'),'first\n');debugGit('add','.');debugGit('commit','-m','第一轮范围内调试');
const first = debugGit('rev-parse','HEAD');
await fs.writeFile(path.join(debug,'allowed/ui.txt'),'second\n');debugGit('add','.');debugGit('commit','-m','第二轮范围内打磨');
const second = debugGit('rev-parse','HEAD');
await fs.writeFile(path.join(debug,'outside.txt'),'outside\n');debugGit('add','.');debugGit('commit','-m','越界负向用例');
const outside = debugGit('rev-parse','HEAD');
debugGit('rm','outside.txt');debugGit('commit','-m','撤回越界但保留累计历史');
const reverted = debugGit('rev-parse','HEAD');debugGit('checkout','--detach',first);
git('push','origin',`${first}:refs/heads/lab/debug`);
git('worktree','add',conflict,'-b','lab/conflict',ancestor);
await fs.writeFile(path.join(conflict,'allowed/app.txt'),'conflicting hotfix\n');
execFileSync('git',['-C',conflict,'add','.']);execFileSync('git',['-C',conflict,'commit','-m','真实冲突负向用例'],{stdio:'ignore'});
const conflictSha = execFileSync('git',['-C',conflict,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const surface = http.createServer(async (req,res) => {
  if(req.url?.startsWith('/preview/')){
    const target=req.url.includes('debug')?debug:req.url.includes('conflict')?conflict:repo;
    const sha=execFileSync('git',['-C',target,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    res.writeHead(200,{'Content-Type':'text/html'});res.end(`<html><body>真实运行的隔离验收项目 ${sha}<script src="/entry.js"></script></body></html>`);return;
  }
  if(req.url==='/entry.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end('document.body.dataset.ready="true";');return;}
  const sha=(await fs.readFile(marker,'utf8')).trim();
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'healthy',commit:sha}));return;}
  res.writeHead(200,{'Content-Type':'text/html'});res.end(`<html><body>CDS 隔离发布结果 ${sha}<script src="/entry.js"></script></body></html>`);
});
await new Promise(resolve=>surface.listen(0,'127.0.0.1',resolve));const surfacePort=surface.address().port;
const state = new StateService(path.join(root,'.cds/state.json'),root);state.load();
const now = new Date().toISOString(), projectId='release-live-lab', targetId='release-live-lab-target';
state.addProject({id:projectId,slug:'release-live-lab',name:'发布治理隔离验收 · 真实 Git / SSH',kind:'git',repoPath:repo,gitRepoUrl:origin,gitDefaultBranch:'main',cloneStatus:'ready',createdAt:now,updatedAt:now});
state.addAgentKey(projectId,{id:'release-lab-agent',label:'本轮隔离验收执行凭据',hash:crypto.createHash('sha256').update(agentKey).digest('hex'),scope:'rw',createdAt:now,expiresAt:new Date(Date.now()+24*60*60_000).toISOString()});
for(const [id,branch,worktreePath,sha] of [['lab-main','main',repo,main],['lab-debug','lab/debug',debug,first],['lab-conflict','lab/conflict',conflict,conflictSha]])state.addBranch({id,projectId,branch,worktreePath,githubCommitSha:sha,status:'running',services:{},createdAt:now,previewUrl:`http://127.0.0.1:${surfacePort}/preview/${id}`});
state.addRemoteHost({id:'release-lab-ssh',name:'隔离验收目标（仅本容器）',host:'127.0.0.1',sshPort,sshUser:'lab',sshAuthMethod:'password',sshPasswordEncrypted:password,sshPrivateKeyFingerprint:crypto.createHash('sha256').update(password).digest('hex').slice(0,16),tags:['isolated-acceptance'],isEnabled:true,createdAt:now});
state.upsertReleaseTarget({id:targetId,projectId,name:'隔离验收目标 · 实际执行发布',type:'ssh',environment:'staging',isEnabled:true,isCanonical:true,createdAt:now,strategy:{mode:'existing-script',command:'./release.sh'},ssh:{host:'127.0.0.1',port:sshPort,user:'lab',privateKeyRef:'release-lab-ssh',appPath:repo,deployCommand:'./release.sh',healthcheckUrl:`http://127.0.0.1:${surfacePort}/health`}});
await state.flush();
const workerProbe=http.createServer();await new Promise(resolve=>workerProbe.listen(0,'127.0.0.1',resolve));const workerPort=workerProbe.address().port;await new Promise(resolve=>workerProbe.close(resolve));
await fs.writeFile(path.join(root,'cds/cds.config.json'),JSON.stringify({repoRoot:root,workerPort}));
const credentialsPath=path.join(root,'.cds/lab-credentials.json');
await fs.writeFile(credentialsPath,JSON.stringify({projectId,targetId,agentKey,username,password:humanPassword,main,first,second,outside,reverted,conflictSha,root,effects,surfaceUrl:`http://127.0.0.1:${surfacePort}/`,branches:{main:'lab-main',debug:'lab-debug',conflict:'lab-conflict'}}),{mode:0o600});
const env={...process.env,CDS_PREVIEW_INSTANCE:'1',CDS_STORAGE_MODE:'json',CDS_REPO_ROOT:root,CDS_BIND_HOST:process.env.CDS_BIND_HOST||'127.0.0.1',CDS_PREVIEW_USERNAME:username,CDS_PREVIEW_PASSWORD:humanPassword};
delete env.CDS_SECRET_KEY; delete env.AI_ACCESS_KEY; delete env.CDS_PROJECT_KEY; delete env.CDS_MONGO_URI;
const mainProcess=spawn(process.execPath,[path.join(runtime,'dist/index.js')],{cwd:path.join(root,'cds'),env,stdio:'inherit'});
mainProcess.on('exit',()=>process.exit());
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{mainProcess.kill(signal);for(const child of children)child.kill(signal);for(const client of sockets)client.end();ssh.close();surface.close();});
const metadata={labRoot:root,credentialsPath,projectId,targetId,actualSsh:true,actualGit:true,noHostMounts:true};
if(process.env.CDS_LAB_METADATA_FILE) await fs.writeFile(process.env.CDS_LAB_METADATA_FILE,JSON.stringify(metadata),{mode:0o600});
console.log(JSON.stringify(metadata));
