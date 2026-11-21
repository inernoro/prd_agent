import { z } from 'zod';
import { createProjectApiClient, localFile } from './bridge.mjs';

const readTool = 'cds_design_read';
const publishTool = 'cds_design_publish';
const fileLimit = 4 * 1024 * 1024;
const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.@+-]+$/);
const version = z.number().int().positive().optional();
const schemas = {
  [readTool]: z.discriminatedUnion('view', [
    z.object({ view: z.literal('designs') }).strict(),
    z.object({ view: z.literal('frameworks') }).strict(),
    z.object({ view: z.literal('design'), id, version }).strict(),
    z.object({ view: z.literal('framework'), id, version }).strict(),
  ]),
  [publishTool]: z.object({
    requestId: id, designId: id.optional(), zipPath: z.string().trim().min(1).max(1200),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), sourcePath: z.string().trim().min(1).max(1200),
    note: z.string().trim().min(1).max(1000).optional(),
  }).strict(),
};
const descriptions = {
  [readTool]: '读取当前 CDS 项目的私有稿件或框架。先以 designs 或 frameworks 发现编号，再用 design 或 framework 读取固定版本。',
  [publishTool]: '经授权发布当前项目中已提交的私有设计稿。ZIP 路径须位于工作区内，服务按项目 Git 核对提交、目录和字节。更新稿件沿用 designId；重试沿用 requestId 和相同内容。',
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

  return {
    close: () => client.close(),
    async listTools() {
      const result = await workspace();
      return tools.filter(tool => tool.name === readTool || result.permissions.write);
    },
    async call(name, input = {}) {
      if (!Object.hasOwn(schemas, name)) throw new Error('未知 CDS 设计工具');
      const parsed = schemas[name].safeParse(input);
      if (!parsed.success) throw new Error('设计参数无效，请检查工具契约');
      const data = await workspace();
      if (name === readTool) {
        const args = parsed.data;
        const items = args.view === 'design' || args.view === 'designs' ? data.designs : data.frameworks;
        if (args.view === 'designs' || args.view === 'frameworks') {
          return { projectId, items: items.map(item => ({ id: item.id, latest: item.versions.at(-1)?.version,
            title: item.versions.at(-1)?.title, versions: item.versions.map(row => row.version) })) };
        }
        const item = items.find(row => row.id === args.id);
        const selected = args.version === undefined ? item?.versions.at(-1) : item?.versions.find(row => row.version === args.version);
        if (!item || !selected) throw new Error('当前项目没有这个稿件或框架版本');
        return { projectId, id: item.id, version: selected };
      }
      if (!data.permissions.write) throw new Error('当前凭据没有稿件发布权限');
      const { zipPath, ...fields } = parsed.data;
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
        || (fields.designId !== undefined && receipt.result.designId !== fields.designId)) {
        throw new Error('CDS 返回的发布回执与当前稿件或项目不符');
      }
      return receipt;
    },
  };
}
