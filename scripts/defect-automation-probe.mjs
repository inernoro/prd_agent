#!/usr/bin/env node
/**
 * Defect automation protocol probe.
 *
 * Safe default: validates connector and published-pending without claiming a defect.
 * Add --claim to exercise workflow/start-next. Use --defect <id-or-no> for a precise
 * rehearsal target; daily runs should not pass --claim from this probe.
 */

const args = new Set(process.argv.slice(2));
const argv = process.argv.slice(2);

function argValue(name, fallback = '') {
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}

const domain = (process.env.DEFECT_AGENT_DOMAIN || process.env.MAP_DEFECT_DOMAIN || '').replace(/\/+$/, '');
const key = process.env.DEFECT_AGENT_KEY || process.env.MAP_DEFECT_AGENT_KEY || process.env.PRD_AGENT_API_KEY || '';
const projectId = process.env.DEFECT_AGENT_PROJECT_ID || '';
const teamId = process.env.DEFECT_AGENT_TEAM_ID || '';
const status = process.env.DEFECT_AGENT_STATUS || 'submitted,assigned,processing';
const claim = args.has('--claim');
const safe = args.has('--safe') || !claim;
const defectId = argValue('--defect', process.env.DEFECT_AGENT_DEMO_DEFECT_ID || '');

function fail(message, detail) {
  const payload = {
    ok: false,
    phase: detail?.phase || 'probe',
    message,
    detail: detail || null,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(2);
}

if (!domain) fail('缺少 DEFECT_AGENT_DOMAIN');
if (!key) fail('缺少 DEFECT_AGENT_KEY');

async function request(path, options = {}) {
  const url = `${domain}${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${key}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    fail(`接口返回非 JSON: ${res.status}`, { phase: options.phase, url, body: text.slice(0, 300) });
  }
  if (!res.ok || json?.success === false) {
    fail(`接口失败: ${res.status}`, { phase: options.phase, url, response: json });
  }
  return json?.data ?? json;
}

function queryString(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const result = {
  ok: true,
  safe,
  claim,
  domain,
  projectId: projectId || null,
  teamId: teamId || null,
  status,
  checks: [],
};

const connector = await request(
  `/api/defect-agent/agent/connector${queryString({ projectId, teamId, status })}`,
  { phase: 'connector' },
);
const workflowVersion = connector?.workflow?.version;
const requiredScope = connector?.auth?.requiredScope;
result.checks.push({
  phase: 'connector',
  type: connector?.type,
  requiredScope,
  workflowVersion,
  keyName: connector?.auth?.currentKey?.Name || connector?.auth?.currentKey?.name || null,
});
if (requiredScope !== 'defect-agent:use') {
  fail('connector requiredScope 不符合缺陷自动化协议', { phase: 'connector', requiredScope });
}
if (workflowVersion !== 'defect-agent-workflow.v1') {
  fail('connector workflow.version 不符合缺陷自动化协议', { phase: 'connector', workflowVersion });
}

const pending = await request('/api/defect-agent/agent/published-pending?limit=20', { phase: 'published-pending' });
result.checks.push({
  phase: 'published-pending',
  pendingCount: Array.isArray(pending?.items) ? pending.items.length : 0,
});

if (claim) {
  const body = {
    triggerType: 'manual',
    projectId: projectId || undefined,
    teamId: teamId || undefined,
    status,
    defectId: defectId || undefined,
  };
  const started = await request('/api/defect-agent/agent/workflow/start-next', {
    method: 'POST',
    body,
    phase: 'workflow/start-next',
  });
  result.checks.push({
    phase: 'workflow/start-next',
    runId: started?.run?.id || started?.run?.Id || null,
    protocolVersion: started?.protocol?.version || null,
    hasNext: Boolean(started?.hasNext ?? started?.HasNext),
    defectNo: started?.defect?.defectNo || started?.defect?.DefectNo || null,
    defectId: started?.defect?.id || started?.defect?.Id || null,
  });
  if ((started?.protocol?.version || null) !== 'defect-agent-workflow.v1') {
    fail('start-next 未返回 defect-agent-workflow.v1', { phase: 'workflow/start-next', response: started });
  }
}

console.log(JSON.stringify(result, null, 2));
