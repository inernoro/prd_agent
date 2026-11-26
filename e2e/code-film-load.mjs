import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const map = 'https://opendesign-sketchnote-film-codex-prd-agent.miduo.org';
const gateway = 'https://opendesign-sketchnote-film-codex-prd-agent-llmgw.miduo.org';
const lanes = Number(process.env.FILM_LANES);
const commit = process.env.FILM_COMMIT;
const terminal = new Set(['Done', 'Error', 'Cancelled']);
const sourceRun = 'db44117c9ec441789bc9bc0845ace02c';
const identity = process.env.GITHUB_RUN_ID;
assert.match(identity, /^\d+$/);
assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Review the original batch before starting another.');
assert.equal(process.env.E2E_BASE_URL, map);
assert.ok([1, 10, 30].includes(lanes));
assert.match(commit, /^[a-f0-9]{40}$/);
assert.ok(process.env.E2E_USER && process.env.E2E_PASSWORD);
const hash = (text) => createHash('sha256').update(text).digest('hex');
const originalInstruction = 'cfc8631202ec14fd5f88c61f65c4c0f0bb642d7802b6c622e5308db87e7fa7a1';
const originalSource = '940ba09667ffdbabd5693a800e977ff4d287100309af306479c9ccd86667428b';

async function request(host, path, {token, body, method, range} = {}) {
  const response = await fetch(new URL(path, host), {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {'X-Client':'admin', ...(token ? {Authorization:'Bearer ' + token} : {}),
      ...(body ? {'Content-Type':'application/json'} : {}), ...(range ? {Range:range} : {})},
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
  });
  if (range && response.status === 206) return response;
  const json = await response.json().catch(() => ({}));
  assert.ok(response.ok && json.success !== false, `${method ?? 'GET'} ${path.split('?')[0]} HTTP ${response.status} ${json.error?.code ?? ''}`);
  return json.data ?? json;
}

const version = await request(map, '/api/version');
assert.equal(version.actualCommit, commit);
const login = await request(map, '/api/v1/auth/login', {
  body: {username:process.env.E2E_USER,password:process.env.E2E_PASSWORD,clientType:'admin'},
});
const token = login.accessToken;
assert.ok(token);
const api = (path, options = {}) => request(map, path, {token, ...options});
const baseline = await api('/api/design-artifacts/runs/' + sourceRun);
assert.equal(baseline.status, 'Done');
assert.equal(hash(baseline.instruction), originalInstruction);
assert.equal(baseline.uploadedSources.length, 1);
const baselineSource = baseline.uploadedSources[0];
assert.match(baselineSource.contentHash, /^[a-f0-9]{64}$/);
assert.match(baselineSource.fileName, /\.md$/);
assert.equal(baseline.resolvedModel, 'gpt-6.1-sol');
const ticket = await api('/api/llm-gateway/sso/ticket', {method:'POST'});
const gatewayLogin = await request(gateway, '/gw/auth/map-sso', {body:{code:ticket.code}});
assert.ok(gatewayLogin.token);

const started = Date.now();
const deadline = started + 57 * 60_000;
const prefix = 'ADR 视觉笔记 CDS 压测 ' + identity;
const cases = Array.from({length:lanes}, (_, index) => ({lane:index+1, title:prefix+'-'+(index+1)}));
const sameAttachment = run => run?.uploadedSources?.[0]?.attachmentId===baselineSource.attachmentId
  && run.uploadedSources[0].contentHash===baselineSource.contentHash;
console.log(JSON.stringify({event:'batch-start',lanes,commit,at:new Date(started).toISOString(),originalInstruction,
  expectedRawSourceHash:originalSource,attachmentTextHash:baselineSource.contentHash}));
await Promise.all(cases.map(async item => {
  const began = performance.now();
  try {
    const run = await api('/api/design-artifacts/runs', {body:{
      artifactType:'code-film', sourceSurface:'web-hosting', modelOptionId:baseline.resolvedModel,
      instruction:baseline.instruction, attachmentIds:[baseline.uploadedSources[0].attachmentId], title:item.title,
    }});
    assert.match(run.runId, /^[a-f0-9]{32}$/);
    item.id = run.runId;
    item.run = run;
    item.admissionMs = Math.round(performance.now()-began);
    console.log(JSON.stringify({event:'admitted',lane:item.lane,runId:item.id,admissionMs:item.admissionMs,
      sourceMatches:sameAttachment(run),promptMatches:hash(run.instruction)===originalInstruction,
      model:run.llmRequestPolicy?.model,effort:run.llmRequestPolicy?.reasoningEffort}));
  } catch (error) {
    item.admissionError = error.message;
    console.log(JSON.stringify({event:'admission-unconfirmed',lane:item.lane,error:error.message}));
  }
}));

// A lost response is reconciled from the server's own recent list, never by sending the request again.
if (cases.some(item=>!item.id)) {
  const recent = await api('/api/design-artifacts/code-films').catch(() => ({items:[]}));
  for (const item of cases.filter(item=>!item.id)) {
    const run = recent.items.find(row=>row.title===item.title);
    if (run) { item.id=run.runId; item.run=run; }
  }
}
const ids = cases.flatMap(item => item.id ? [item.id] : []);
assert.equal(new Set(ids).size, ids.length, 'Each admitted lane must have its own run');

let maxRunning=0;
let nextLog=0;
while (Date.now() < deadline && cases.some(item=>item.id&&!terminal.has(item.run.status))) {
  const pending = cases.filter(item=>item.id&&!terminal.has(item.run.status));
  for (let offset=0; offset<pending.length; offset+=5) {
    await Promise.all(pending.slice(offset,offset+5).map(async item => {
      try {
        const next = await api('/api/design-artifacts/runs/'+item.id);
        if (!item.runningAt && next.status==='Running') item.runningAt=Date.now();
        item.run=next;
      } catch { item.pollFailures=(item.pollFailures??0)+1; }
    }));
  }
  maxRunning=Math.max(maxRunning,cases.filter(item=>item.run?.status==='Running').length);
  if (Date.now()>=nextLog) {
    const counts=Object.fromEntries([...new Set(cases.map(item=>item.run?.status??'AdmissionUnconfirmed'))]
      .map(state=>[state,cases.filter(item=>(item.run?.status??'AdmissionUnconfirmed')===state).length]));
    console.log(JSON.stringify({event:'progress',elapsedSeconds:Math.round((Date.now()-started)/1000),counts,
      modelCalls:cases.reduce((sum,item)=>sum+(item.run?.runtimeModelCallCount??0),0)}));
    nextLog=Date.now()+60_000;
  }
  if (cases.some(item=>item.id&&!terminal.has(item.run.status))) await delay(6_000);
}

function summarizeModel(items) {
  const spans=items.map(row=>[Date.parse(row.startedAt),Date.parse(row.endedAt)])
    .filter(([start,end])=>Number.isFinite(start)&&Number.isFinite(end)&&end>start).sort((a,b)=>a[0]-b[0]);
  let end=0;
  let total=0;
  for (const [start,stop] of spans) { total+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop); }
  return {gatewayCalls:items.length,completeSpans:spans.length,modelSeconds:total/1000,firstModelAt:spans[0]?.[0],
    failedGatewayCalls:items.filter(row=>row.statusCode>=400).length};
}

const rows=[];
for (const item of cases) {
  const run=item.run;
  const row={lane:item.lane,runId:item.id,status:run?.status??'AdmissionUnconfirmed',admissionMs:item.admissionMs,
    observedRunningSeconds:item.runningAt?Math.round((item.runningAt-Date.parse(run.createdAt))/1000):null,
    finalSeconds:run?.completedAt?Math.round((Date.parse(run.completedAt)-Date.parse(run.createdAt))/1000):null,
    calls:run?.runtimeModelCallCount,phaseCode:run?.phaseCode,failureCode:run?.failureCode,
    sourceMatches:sameAttachment(run),
    promptMatches:typeof run?.instruction==='string'&&hash(run.instruction)===originalInstruction,
    modelMatches:run?.resolvedModel===baseline.resolvedModel,effort:run?.llmRequestPolicy?.reasoningEffort};
  if (run?.status==='Done') {
    try {
      const film=await api('/api/design-artifacts/runs/'+item.id+'/film.mp4',{range:'bytes=0-31'});
      const header=Buffer.from(await film.arrayBuffer());
      row.outputValid=Boolean(run.workspaceResultSha256&&header.length===32&&header.toString('ascii',4,8)==='ftyp'
                           &&film.headers.get('content-type')==='video/mp4');
    } catch { row.outputValid=false; }
  } else if (item.id && !terminal.has(run.status)) {
    row.status='Timeout';
    try { await api('/api/design-artifacts/runs/'+item.id+'/cancel',{method:'POST'});row.cancelAccepted=true; }
    catch { row.cancelAccepted=false; }
  }
  if (item.id) {
    const filter=new URLSearchParams({runId:item.id,pageSize:'500',view:'logical',
      from:new Date(started-60_000).toISOString(),to:new Date().toISOString()});
    try { Object.assign(row,summarizeModel((await request(gateway,'/gw/logs?'+filter,{token:gatewayLogin.token})).items)); }
    catch { row.gatewayTimingUnavailable=true; }
  }
  row.passed=row.status==='Done'&&row.outputValid&&row.sourceMatches&&row.promptMatches&&row.modelMatches;
  rows.push(row);
  console.log(JSON.stringify({event:'lane-result',...row}));
}

const completed=rows.filter(row=>row.passed);
const timings=completed.map(row=>row.finalSeconds).filter(Number.isFinite).sort((a,b)=>a-b);
const percentile=(fraction)=>timings.length?timings[Math.ceil(timings.length*fraction)-1]:null;
console.log(JSON.stringify({event:'batch-result',lanes,admitted:ids.length,passed:completed.length,
  timedOut:rows.filter(row=>row.status==='Timeout').length,maxRunning,p50Seconds:percentile(.50),
  p95Seconds:percentile(.95),elapsedSeconds:Math.round((Date.now()-started)/1000)}));
if (completed.length!==lanes) process.exitCode=1;
