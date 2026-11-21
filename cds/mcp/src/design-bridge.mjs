import { z } from 'zod';
import { createProjectApiClient, localFile } from './bridge.mjs';

const readTool = 'cds_design_read';
const publishTool = 'cds_design_publish';
const fileLimit = 4 * 1024 * 1024;
const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.@+-]+$/);
const positiveVersion = z.number().int().positive();
const version = positiveVersion.optional();
const designKey = z.string().trim().max(129).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sourceCommit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i);
const intakeResult = z.object({
  protocolVersion: z.literal(1), projectId: z.string(), permissions: z.object({ write: z.boolean() }),
  designs: z.array(z.object({ designId: id, designKey: designKey.optional(), latestVersion: positiveVersion,
    sourceCommit, sourcePaths: z.array(z.string()), canRevise: z.boolean() })),
});
const schemas = {
  [readTool]: z.discriminatedUnion('view', [
    z.object({ view: z.literal('intake') }).strict(),
    z.object({ view: z.literal('designs') }).strict(),
    z.object({ view: z.literal('frameworks') }).strict(),
    z.object({ view: z.literal('design'), id, version }).strict(),
    z.object({ view: z.literal('framework'), id, version }).strict(),
  ]),
  [publishTool]: z.object({
    requestId: id, designId: id.optional(), zipPath: z.string().trim().min(1).max(1200),
    sourceCommit, sourcePath: z.string().trim().min(1).max(400),
    note: z.string().trim().min(1).max(1000).optional(),
    intent: z.enum(['create', 'revise']).optional(), designKey: designKey.optional(), expectedVersion: version,
  }).strict().superRefine((args, context) => {
    const issue = (field, message) => context.addIssue({ code: 'custom', path: [field], message });
    if (args.intent === 'create') {
      if (!args.designKey) issue('designKey', '新建须提供 module/draft 标识');
      if (args.designId) issue('designId', '新稿件 ID 由 CDS 分配');
      if (args.expectedVersion) issue('expectedVersion', '新稿从 V1 开始');
    } else if (args.intent === 'revise') {
      if (!args.designId) issue('designId', '续版须指定已有稿件');
      if (!args.expectedVersion) issue('expectedVersion', '续版须声明已经读过的版本');
    } else if (args.designKey || args.expectedVersion) {
      issue('intent', '请明确新建或续版');
    }
  }),
};
const descriptions = {
  [readTool]: '设计接入先用 intake 读取当前项目、稳定稿件标识、最新版本、已核验 Git 目录和续版权限。用 design 或 framework 读取固定版本。目标或基线无法唯一确定时，开工前一次澄清。',
  [publishTool]: '先查询 intake。新稿或新模块用 intent=create、独立的 module/draft 标识和 Git 目录。同稿用 intent=revise、原 designId 和读到的 expectedVersion。续版权限或基线不清楚时先澄清。ZIP 与项目 Git 一致。重试沿用 requestId 和相同内容。',
};
const tools = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name], inputSchema: { ...z.toJSONSchema(schema), type: 'object' },
  annotations: { readOnlyHint: name === readTool, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

export function createDesignBridge(credentials, options = {}) {
  const client = createProjectApiClient(credentials, options);
  const projectId = credentials.projectId;
  const path = `/api/projects/${encodeURIComponent(projectId)}/design`;
  async function workspace() {
    const result = await client.request('GET', path);
    if (result.projectId !== projectId || typeof result.permissions?.write !== 'boolean'
      || !Array.isArray(result.frameworks) || !Array.isArray(result.designs)
      || [...result.frameworks, ...result.designs].some(row => row?.projectId !== projectId || !Array.isArray(row.versions))) {
      throw new Error('CDS 设计结果与当前项目或桥接契约不符');
    }
    return result;
  }

  async function intake() {
    const result = await client.request('GET', `${path}/intake`);
    if (result.projectId !== projectId || !intakeResult.safeParse(result).success) {
      throw new Error('CDS 设计接入结果与当前项目或协议不符');
    }
    return result;
  }

  return {
    close: () => client.close(),
    async listTools() {
      const result = await workspace();
      return tools.filter(tool => tool.name === readTool || result.permissions.write);
    },
    async call(name, input = {}) {
      if (!Object.hasOwn(schemas, name)) throw new Error('未知 CDS 设计工具');
      const parsed = schemas[name].safeParse(input);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')).filter(Boolean))];
        const detail = fields.length ? `请核对 ${fields.join('、')}。` : '请核对工具参数。';
        throw new Error(`设计参数无效。${detail}项目、稿件或版本仍不明确时，先向委托方澄清。`);
      }
      const args = parsed.data;
      if (name === readTool) {
        if (args.view === 'intake') return intake();
        const data = await workspace();
        const items = args.view === 'design' || args.view === 'designs' ? data.designs : data.frameworks;
        if (args.view === 'designs' || args.view === 'frameworks') {
          return { projectId, items: items.map(item => ({ id: item.id, latest: item.versions.at(-1)?.version,
            title: item.versions.at(-1)?.title, versions: item.versions.map(row => row.version) })) };
        }
        const item = items.find(row => row.id === args.id);
        const selected = args.version === undefined ? item?.versions.at(-1) : item?.versions.find(row => row.version === args.version);
        if (!item || !selected) {
          const listView = args.view === 'design' ? 'designs' : 'frameworks';
          throw new Error(`请先通过 ${listView} 查询当前项目，再核对编号和版本。无法唯一确定时，先确认本轮基线。`);
        }
        return { projectId, id: item.id, version: selected };
      }
      const { zipPath, ...fields } = args;
      const data = fields.intent ? await intake() : await workspace();
      if (!data.permissions.write) throw new Error('当前凭据没有稿件发布权限');
      const targetField = fields.intent ? 'designId' : 'id';
      if (fields.designId !== undefined && !data.designs.some(item => item[targetField] === fields.designId)) {
        throw new Error('请先通过 intake 或 designs 查询当前项目。找不到要续发的原稿时，先确认稿件和基线再发布。');
      }
      const { bytes } = await localFile(credentials, zipPath, ['.zip'], fileLimit);
      const query = new URLSearchParams({ ...fields, requireGit: 'true' });
      let receipt;
      try { receipt = await client.request('POST', `${path}/packages?${query}`, bytes); } catch (error) {
        if (error instanceof Error && /请求失败或超时|返回非 JSON/.test(error.message)) {
          throw new Error('CDS 未返回可确认的发布结果，请用相同 requestId 和内容重试');
        }
        throw error;
      }
      if (receipt.projectId !== projectId || typeof receipt.reused !== 'boolean' || receipt.result?.type !== 'package'
        || !id.safeParse(receipt.result.designId).success || !Number.isSafeInteger(receipt.result.version) || receipt.result.version < 1
        || (fields.designId !== undefined && receipt.result.designId !== fields.designId)
        || (fields.intent === 'create' && receipt.result.version !== 1)
        || (fields.intent === 'revise' && receipt.result.version !== fields.expectedVersion + 1)) {
        throw new Error('CDS 返回的发布回执与当前稿件或项目不符');
      }
      return receipt;
    },
  };
}
