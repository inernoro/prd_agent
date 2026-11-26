import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const propose = z.object({
  action: z.enum(['reset-password', 'disable-user', 'revoke-sessions']),
  targetId: z.string().trim().min(1).max(120),
  reason: z.string().trim().min(3).max(500),
}).strict();
const receipt = z.object({ requestId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const tools = [
  { name: 'cds_account_propose', description: '在本设备获授权的项目中提交成员账号操作提案，返回原申请回执。', inputSchema: {
    type: 'object', properties: {
      action: { enum: ['reset-password', 'disable-user', 'revoke-sessions'] },
      targetId: { type: 'string' }, reason: { type: 'string' },
    }, required: ['action', 'targetId', 'reason'], additionalProperties: false,
  } },
  { name: 'cds_account_receipt', description: '回读同一已授权设备提交的账号提案的处理状态。', inputSchema: {
    type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'], additionalProperties: false,
  } },
];

export async function readAccountCredentials() {
  try {
    const data = JSON.parse(await readFile(join(homedir(), '.cds', 'user-credentials.json'), 'utf8'));
    const settings = data.hosts || {};
    const host = process.env.CDS_HOST?.trim() || data.defaultHost || (Object.keys(settings).length === 1 ? Object.keys(settings)[0] : '');
    if (!host) throw new Error();
    const url = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error();
    const credential = settings[url.host.toLowerCase()]?.credential;
    if (typeof credential !== 'string' || !/^cdsu_[A-Za-z0-9_-]+$/.test(credential)) throw new Error();
    return { baseUrl: url.origin, credential };
  } catch {
    throw new Error('暂无匹配的 CDS 设备授权，请通过 CDS 设备接入获得账号提案权限。');
  }
}

export function createAccountBridge({ baseUrl, credential }, { fetchImpl = fetch } = {}) {
  return {
    async listTools() { return tools; },
    async close() {},
    async call(name, input) {
      let endpoint = '/api/auth/account-proposals';
      let body;
      if (name === 'cds_account_propose') {
        const parsed = propose.safeParse(input);
        if (!parsed.success) throw new Error('请提供账号编号、变更原因及允许的动作。');
        body = JSON.stringify(parsed.data);
      } else if (name === 'cds_account_receipt') {
        const parsed = receipt.safeParse(input);
        if (!parsed.success) throw new Error('请提供服务端原申请编号。');
        endpoint += `/${parsed.data.requestId}`;
      } else throw new Error('此工具仅提供提案和回读。');
      try {
        const response = await fetchImpl(baseUrl + endpoint, {
          method: body ? 'POST' : 'GET', body, redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-AI-Access-Key': credential },
        });
        if (response.status === 401 || response.status === 403) throw new Error('authorization');
        if (!response.ok) throw new Error('service');
        return await response.json();
      } catch (error) {
        if (error instanceof Error && error.message === 'authorization') throw new Error('当前设备或目标缺少账号提案权限。');
        throw new Error('账号提案暂无法读取，请使用原申请号重试。');
      }
    },
  };
}
