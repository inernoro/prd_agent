import { z } from 'zod';
import { createProjectApiClient, localFile } from './bridge.mjs';

const readTool = 'cds_design_read';
const publishTool = 'cds_design_publish';
const frameworkPublishTool = 'cds_design_framework_publish';
const feedbackTool = 'cds_design_feedback';
const acceptanceTool = 'cds_design_acceptance';
const implementationCommands = new Set(['design.freeze', 'design.unfreeze', 'implementation.start', 'implementation.cancel', 'implementation.bind']);
const fileLimit = 4 * 1024 * 1024;
const id = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.@+-]+$/);
const positiveVersion = z.number().int().positive();
const version = positiveVersion.optional();
const diffRows = key => {
  const rows = z.array(z.object({ [key]: z.string().min(1), fields: z.array(z.string()).optional() }));
  return z.object({ added: rows, removed: rows, changed: rows });
};
const diffResult = z.object({
  projectId: z.string(), designId: id, fromVersion: positiveVersion, toVersion: positiveVersion,
  screens: diffRows('id'), acceptance: diffRows('id'), files: diffRows('path'),
});
const designKey = z.string().trim().max(129).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
const sourceCommit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i);
const scopeId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64);
const moduleRef = z.object({ systemId: scopeId, moduleId: scopeId });
const scope = moduleRef.extend({ related: z.array(moduleRef).max(12).optional() });
function implementationState(entry) {
  const { frozen: baselineVersion, implementedVersion, versionGap, upgrade } = entry;
  return Object.fromEntries(Object.entries({ baselineVersion, implementedVersion, versionGap, upgrade })
    .filter(([, value]) => value !== undefined));
}
const intakeResult = z.object({
  protocolVersion: z.literal(1), projectId: z.string(),
  permissions: z.object({ write: z.boolean(), feedback: z.boolean().optional(), frameworkPublish: z.boolean().optional(), implementation: z.boolean().optional() }),
  frameworks: z.array(z.object({ id, title: z.string(), latestVersion: positiveVersion, adoptedVersion: version })).optional(),
  designs: z.array(z.object({ designId: id, designKey: designKey.optional(), latestVersion: positiveVersion,
    sourceCommit, sourcePaths: z.array(z.string()), canRevise: z.boolean(), scope: scope.optional() })),
  systems: z.array(z.object({ id: scopeId, name: z.string(), framework: id.optional(),
    modules: z.array(z.object({ id: scopeId, name: z.string(), framework: id.optional(), note: z.string().optional() })) })).optional(),
  requirements: z.array(z.object({ designKey, planId: id, planVersion: positiveVersion, proposalId: id,
    title: z.string().min(1), requirements: z.string().min(1), sharedAt: z.string(), scope: scope.optional() })).optional(),
});
const feedbackBase = { requestId: id, designId: id };
const feedbackBody = z.string().trim().min(1).max(4_000);
const paragraph = z.string().trim().min(1).max(300);
const lead = z.string().trim().min(1).max(80);
const replyMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), lead, items: z.array(id).min(1).max(60) }).strict(),
  z.object({ kind: z.literal('propose'), lead, conclusion: paragraph, scope: paragraph }).strict(),
  z.object({ kind: z.literal('evidence'), lead, runId: id, commit: z.string().regex(/^[a-f0-9]{7,40}$/i) }).strict(),
  z.object({ kind: z.literal('confirm'), lead }).strict(),
]);
const workflowReason = z.string().trim().min(1).max(1_000);
const slot = z.enum(['desktop-light', 'desktop-dark', 'phone-light', 'phone-dark']);
const imagePath = z.string().trim().min(1).max(1200);
const checkId = z.string().regex(/^V-(?:0[1-9]|10)$/);
const acceptanceBase = { ...feedbackBase, runId: id, commit: sourceCommit };
const dimension = z.enum(['correctness', 'compatibility', 'performance', 'security', 'operations', 'experience']);
const evidenceStatus = z.enum(['passed', 'failed', 'missing']);
const evidenceRecord = { id, title: z.string().trim().min(1).max(180),
  dimension };
const observation = { expected: z.string().trim().min(1).max(800), actual: z.string().trim().min(1).max(1200),
  status: evidenceStatus };
const schemas = {
  [readTool]: z.discriminatedUnion('view', [
    z.object({ view: z.literal('intake') }).strict(),
    z.object({ view: z.literal('designs') }).strict(),
    z.object({ view: z.literal('frameworks') }).strict(),
    z.object({ view: z.literal('design'), id, version }).strict(),
    z.object({ view: z.literal('diff'), id, fromVersion: positiveVersion, toVersion: positiveVersion }).strict(),
    z.object({ view: z.literal('run'), id, runId: id.optional() }).strict(),
    z.object({ view: z.literal('framework'), id, version }).strict(),
    z.object({ view: z.literal('delivery'), id, version }).strict(),
    z.object({ view: z.literal('handoff'), id, version: positiveVersion }).strict(),
    z.object({ view: z.literal('feedback'), id, version }).strict(),
    z.object({ view: z.literal('inbox') }).strict(),
    z.object({ view: z.literal('assignees') }).strict(),
    z.object({ view: z.literal('file'), id, version: positiveVersion, path: z.string().min(1).max(400),
      offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16_000).optional() }).strict(),
  ]),
  [feedbackTool]: z.discriminatedUnion('type', [
    z.object({ type: z.literal('brief.reply'), requestId: id, designKey, expectedVersion: positiveVersion, body: feedbackBody }).strict(),
    z.object({ type: z.literal('brief.claim'), requestId: id, designKey, expectedVersion: positiveVersion }).strict(),
    z.object({ type: z.literal('brief.release'), requestId: id, designKey, expectedVersion: positiveVersion }).strict(),
    z.object({ ...feedbackBase, type: z.literal('feedback.create'), version: positiveVersion,
      category: z.enum(['reuse', 'implementation', 'gap', 'constraint', 'acceptance']),
      title: z.string().trim().min(1).max(180), body: feedbackBody, screenId: id.optional(), filePath: z.string().trim().min(1).max(400).optional(),
      evidence: z.array(z.string().trim().min(1).max(1_000)).max(8).optional(), handlerId: id.optional(), confirmerId: id.optional() }).strict(),
    z.object({ ...feedbackBase, type: z.literal('feedback.reply'), feedbackId: id, body: feedbackBody,
      revision: version, supplement: z.literal(true).optional(), message: replyMessage.optional() }).strict(),
    z.object({ ...feedbackBase, type: z.literal('feedback.stage'), feedbackId: id, body: feedbackBody,
      action: z.enum(['take', 'deliver', 'confirm', 'return']), expectedStage: z.enum(['raised', 'working', 'review', 'returned', 'done']),
      proof: z.object({ runId: id, screenId: id, slot }).strict().optional() }).strict(),
    z.object({ ...feedbackBase, type: z.literal('feedback.attach'), feedbackId: id, title: z.string().trim().min(1).max(180),
      imagePath, version, screenId: id.optional(), slot: slot.optional() }).strict(),
    z.object({ ...feedbackBase, type: z.literal('feedback.resolve'), feedbackId: id, body: feedbackBody,
      decision: z.enum(['close', 'reopen']) }).strict(),
  ]),
  [acceptanceTool]: z.discriminatedUnion('type', [
    z.object({ ...feedbackBase, type: z.literal('handoff.check'), version: positiveVersion }).strict(),
    z.object({ ...feedbackBase, type: z.literal('design.freeze'), version: positiveVersion,
      expectedBaseline: positiveVersion.nullable(), reason: workflowReason.optional() }).strict(),
    z.object({ ...feedbackBase, type: z.literal('design.unfreeze'), version: positiveVersion }).strict(),
    z.object({ ...feedbackBase, type: z.literal('implementation.start'), version, expectedBaseline: positiveVersion.nullable() }).strict(),
    z.object({ ...feedbackBase, type: z.literal('implementation.cancel'), upgradeId: id, reason: workflowReason }).strict(),
    z.object({ ...feedbackBase, type: z.literal('implementation.bind'), version: positiveVersion,
      screens: z.array(z.object({ screenId: id, path: z.string().trim().min(1), readySelector: z.string().trim().min(1).max(300) }).strict()).min(1) }).strict(),
    z.object({ ...feedbackBase, type: z.literal('acceptance.capture'), runId: id, screenId: id, slot }).strict(),
    z.object({ ...feedbackBase, type: z.literal('acceptance.recheck'), runId: id, screenId: id, slot }).strict(),
    z.object({ ...acceptanceBase, type: z.literal('acceptance.visual'), screenId: id, slot,
      checks: z.record(checkId, z.object({ status: z.enum(['passed', 'failed', 'missing']), evidence: z.string().max(2000) }).strict()),
      imagePath: imagePath.optional(), referenceImagePath: imagePath.optional(),
      measured: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), theme: z.enum(['light', 'dark']),
        path: z.string().trim().min(1).max(1200) }).strict().optional(),
    }).strict().refine(args => Boolean(args.imagePath) === Boolean(args.measured), { path: ['measured'], message: '实拍和实拍条件须一起提交' }),
    z.object({ ...acceptanceBase, type: z.literal('acceptance.flow'),
      flow: z.object({ ...evidenceRecord, role: z.string().trim().min(1).max(120),
        steps: z.array(z.object({ action: z.string().trim().min(1).max(600), ...observation }).strict()).min(1).max(20) }).strict() }).strict(),
    z.object({ ...acceptanceBase, type: z.literal('acceptance.smoke'),
      smoke: z.object({ ...evidenceRecord, ...observation, target: z.enum(['page', 'api']),
        path: z.string().trim().min(1).max(1200).regex(/^\/(?!\/)[^\\\r\n]*$/) }).strict() }).strict(),
    z.object({ ...acceptanceBase, type: z.literal('acceptance.coverage'), dimension, ruleIds: z.array(id).max(60),
      risk: z.string().trim().min(1).max(1200).optional(), reason: z.string().trim().min(1).max(1200).optional() }).strict()
      .refine(args => args.reason ? args.ruleIds.length === 0 : Boolean(args.risk) && args.ruleIds.length > 0,
        { path: ['ruleIds'], message: '请选择记录风险和对应验收项，或写明该维度不适用' }),
    z.object({ ...acceptanceBase, type: z.literal('acceptance.regress'), issueId: id, status: evidenceStatus,
      evidence: z.string().trim().min(1).max(2000) }).strict(),
    z.object({ ...feedbackBase, type: z.literal('known.create'), problem: z.string().trim().min(1).max(250),
      how: z.string().trim().min(1).max(250), check: z.string().trim().min(1).max(1800), screenIds: z.array(id).max(100),
      sources: z.array(z.object({ kind: z.enum(['defect', 'ticket', 'feedback']), ref: id,
        count: z.number().int().min(1).max(10_000) }).strict()).min(1).max(50) }).strict(),
  ]),
  [frameworkPublishTool]: z.object({
    requestId: id, frameworkId: id, title: z.string().trim().min(1).max(150), expectedVersion: z.number().int().nonnegative(),
    sourceCommit, sourcePath: z.string().trim().min(1).max(400).optional(),
    note: z.string().trim().min(1).max(1000).optional(), charter: z.record(z.string(), z.unknown()).optional(),
    material: z.object({ tokens: z.record(z.string(), z.unknown()).optional(), rules: z.string().max(65_536).optional(),
      components: z.string().max(65_536).optional(), skeleton: z.string().max(65_536).optional() }).strict(),
  }).strict(),
  [publishTool]: z.object({
    requestId: id, designId: id.optional(), zipPath: z.string().trim().min(1).max(1200),
    sourceCommit, sourcePath: z.string().trim().min(1).max(400), sourceMode: z.literal('private').optional(),
    note: z.string().trim().min(1).max(1000).optional(),
    intent: z.enum(['create', 'revise']).optional(), designKey: designKey.optional(), expectedVersion: version,
  }).strict().superRefine((args, context) => {
    const issue = (field, message) => context.addIssue({ code: 'custom', path: [field], message });
    if (args.sourceMode === 'private') {
      if (!args.intent) issue('intent', '私有归档须明确新稿或续版');
      if (args.sourcePath === '.') issue('sourcePath', '私有归档须指定稿件子目录');
    }
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
  [readTool]: '用 intake 读取系统、模块、框架和已交给设计的原始需求、稿件标识、当前版本和权限。固定稿件或框架后，用 delivery 读交付资料、file 分段读原文、feedback 查处理记录。用 diff 固定两个版号查询 CDS 计算的画面、验收与文件净变化，调换顺序可查回退。稿件发布前可用 brief.reply 在当前需求下澄清。用 handoff 读取固定版本的交接检查。用 run 回读指定或最新验收运行。',
  [feedbackTool]: '稿件发布前用 brief.claim 认领需求，brief.reply 在原需求下澄清，brief.release 交回未出稿需求。在原稿登记实施反馈并回复，可以用 feedback.attach 提交当前工作区的私有 PNG。原反馈者或项目管理者核对处理结果。重试沿用 requestId。',
  [acceptanceTool]: '用 handoff.check 检查固定版原型。接入清单允许 implementation 时，可用 design.freeze 或 design.unfreeze 管理实施基线，implementation.start 或 implementation.cancel 管理本轮目标，implementation.bind 登记该版实际页面。验收先回读运行和提交。程序证据稿件用 acceptance.capture 同条件取证，稿件作者用 acceptance.recheck 独立重跑。旧稿沿用 visual、flow、smoke 和 regress 回填。coverage 关联维度风险与验收项，known.create 登记历史易错。重试沿用 requestId。',
  [publishTool]: '先查询 intake。新稿或新模块用 intent=create、独立的 module/draft 标识和 Git 目录。同稿用 intent=revise、原 designId 和读到的 expectedVersion。续版权限或基线不清楚时先澄清。本地稿件用 sourceMode=private 进入项目私有归档。已获授权且已同步的稿件可以核验项目 Git。重试沿用 requestId 和相同内容。',
  [frameworkPublishTool]: '用当前项目的设计发布授权提交框架材料。先读 intake。同一框架沿用 frameworkId，首发 expectedVersion 为 0，续版填写 latestVersion。回执可回读固定版。新版本可预览与试用，项目采用版本由成员在框架页切换。重试沿用 requestId。',
};
const tools = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name], inputSchema: { ...z.toJSONSchema(schema), type: 'object' },
  annotations: { readOnlyHint: name === readTool, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));

export function createDesignBridge(credentials, options = {}) {
  const client = createProjectApiClient(credentials, options);
  const projectId = credentials.projectId;
  const path = `/api/projects/${encodeURIComponent(projectId)}/design`;
  async function workspace(query) {
    const result = await client.request('GET', query ? `${path}?${query}` : path);
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
      return tools.filter(tool => tool.name === readTool || (tool.name === publishTool && result.permissions.write)
        || (tool.name === frameworkPublishTool && result.permissions.write && result.permissions.frameworkPublish === true)
        || (tool.name === feedbackTool && result.permissions.feedback === true)
        || (tool.name === acceptanceTool && (result.permissions.visual === true || result.permissions.programRecheck === true
          || result.permissions.handoffCheck === true || result.permissions.implementation === true)));
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
        if (args.view === 'inbox' || args.view === 'assignees') {
          const result = await client.request('GET', `${path}?view=${args.view}`);
          if (result.projectId !== projectId || !Array.isArray(result.items)) throw new Error('CDS 返回的交接记录与当前项目不符');
          return result;
        }
        if (args.view === 'diff') {
          const query = new URLSearchParams({ designId: args.id, from: args.fromVersion, to: args.toVersion });
          const result = await client.request('GET', `${path}/diff?${query}`);
          if (!diffResult.safeParse(result).success || result.projectId !== projectId || result.designId !== args.id
            || result.fromVersion !== args.fromVersion || result.toVersion !== args.toVersion) {
            throw new Error('CDS 返回的净变化与当前项目、稿件或指定版本不符');
          }
          return result;
        }
        const readVersion = ['design', 'delivery', 'file', 'handoff'].includes(args.view);
        const query = readVersion ? new URLSearchParams({ designId: args.id,
          ...(args.version === undefined ? {} : { version: args.version }) }) : undefined;
        const data = await workspace(query);
        const isFramework = args.view === 'framework' || args.view === 'frameworks';
        const items = isFramework ? data.frameworks : data.designs;
        if (args.view === 'designs' || args.view === 'frameworks') {
          return { projectId, items: items.map(item => ({ id: item.id, latest: item.versions.at(-1)?.version,
            title: item.versions.at(-1)?.title, versions: item.versions.map(row => row.version),
            ...(isFramework ? {} : implementationState(item)) })) };
        }
        const item = items.find(row => row.id === args.id);
        if (args.view === 'run') {
          const run = args.runId ? item?.runs?.find(row => row.id === args.runId) : item?.runs?.at(-1);
          if (!run) throw new Error('当前稿件没有对应验收运行；请核对稿件及运行编号');
          return { projectId, id: item.id, run };
        }
        const selected = args.version === undefined ? item?.versions.at(-1) : item?.versions.find(row => row.version === args.version);
        if (!item || !selected) {
          throw new Error(`请先通过 ${isFramework ? 'frameworks' : 'intake'} 查询当前项目，再核对编号和版本。无法唯一确定时，先确认本轮基线。`);
        }
        if (args.view === 'handoff') {
          if (!selected.handoff || !['legacy', 'missing-plan', 'pending', 'running', 'passed', 'failed', 'unavailable'].includes(selected.handoff.status)) {
            throw new Error('请核对稿件版本及 CDS 交接能力');
          }
          return { projectId, designId: item.id, version: selected.version, handoff: selected.handoff };
        }
        if (args.view === 'delivery') {
          const screens = selected.screens ?? [];
          const renders = selected.renders ?? {};
          return { projectId, id: item.id, version: selected.version, delivery: selected.delivery ?? null,
            sourceCommit: selected.sourceCommit, sourcePath: selected.sourcePath, sourceVerification: selected.sourceVerification,
            ...(selected.goals ? { goals: selected.goals } : {}),
            ...(selected.demoData ? { demoData: selected.demoData } : {}),
            ...(selected.handoff ? { handoff: selected.handoff } : {}),
            sha256: selected.sha256, screens, acceptance: selected.acceptance, acceptancePlan: selected.acceptancePlan, checks: selected.checks,
            ...(selected.demo ? { demo: selected.demo } : {}), ...(selected.videos ? { videos: selected.videos } : {}),
            ...(item.methodSettings?.[selected.version] ? { methodSettings: item.methodSettings[selected.version] } : {}),
            summary: { screenCount: screens.length, withImplementation: screens.filter(screen => screen.impl).length,
              screenshotSlots: screens.reduce((sum, screen) => sum + screen.themes.length, 0),
              submittedScreenshots: Object.values(renders).reduce((sum, captures) => sum + Object.keys(captures).length, 0),
              requirements: selected.acceptance?.length ?? 0 } };
        }
        if (args.view === 'feedback') {
          const feedback = item.feedback ?? [];
          return { projectId, id: item.id, items: args.version === undefined ? feedback
            : feedback.filter(row => (row.status !== 'closed' && row.version < selected.version) || row.version === selected.version || row.replies.some(reply => reply.revision === selected.version)
              || row.attachments?.some(attachment => attachment.version === selected.version)) };
        }
        if (args.view === 'file') {
          const file = selected.delivery?.files.find(row => row.path === args.path);
          if (!file) throw new Error('所选版本没有这份交付资料。请读取 delivery 中的完整路径，历史稿请先核对 Git 来源。');
          if (!file.text && !/\.(?:diff|patch)$/i.test(file.path)) throw new Error('这份资料是二进制附件。请在 CDS 交付页按文件下载。');
          const query = new URLSearchParams({ view: 'text', offset: String(args.offset ?? 0), limit: String(args.limit ?? 12_000) });
          const result = await client.request('GET', `${path}/artifacts/${encodeURIComponent(file.id)}?${query}`);
          if (result.artifactId !== file.id || result.path !== file.path || result.sha256 !== file.sha256 || typeof result.text !== 'string') {
            throw new Error('交付资料回读与所选文件或版本不符');
          }
          return result;
        }
        return { projectId, id: item.id, version: selected, ...(isFramework ? {} : implementationState(item)),
          ...(args.view === 'design' && item.knownIssues ? { knownIssues: item.knownIssues } : {}) };
      }
      if (name === feedbackTool) {
        const data = await intake();
        if (!data.permissions.feedback) throw new Error('当前凭据没有设计反馈权限，请核对项目实施反馈授权或稿件发布授权');
        let body = args;
        if (args.type === 'feedback.attach') {
          const { imagePath, ...fields } = args;
          const { bytes } = await localFile(credentials, imagePath, ['.png'], 1.5 * 1024 * 1024);
          body = { ...fields, image: `data:image/png;base64,${bytes.toString('base64')}` };
        }
        const endpoint = args.type === 'feedback.attach' ? '/feedback/attachments' : '/feedback';
        const receipt = await client.request('POST', path + endpoint, body);
        const result = receipt.result;
        const targetMatches = args.type.startsWith('brief.') ? result?.designKey === args.designKey && result?.version === args.expectedVersion
          : result?.designId === args.designId;
        if (receipt.projectId !== projectId || !targetMatches || result?.type !== args.type
          || (args.feedbackId && result?.id !== args.feedbackId)
          || (args.type === 'feedback.attach' && (result.id !== args.feedbackId || !id.safeParse(result.artifactId).success
            || (args.version !== undefined && result.version !== args.version)))
          || typeof receipt.reused !== 'boolean' || !id.safeParse(result?.id).success) {
          throw new Error('CDS 返回的反馈回执与本次稿件或操作不符');
        }
        return receipt;
      }
      if (name === acceptanceTool) {
        if (implementationCommands.has(args.type)) {
          const receipt = await client.request('POST', path + '/commands', args);
          const result = receipt.result;
          if (receipt.projectId !== projectId || typeof receipt.reused !== 'boolean' || result?.type !== args.type
            || result.designId !== args.designId || !positiveVersion.safeParse(result.version).success
            || (args.version !== undefined && result.version !== args.version)
            || (args.type === 'implementation.start' && !id.safeParse(result.upgradeId).success)
            || (args.type === 'implementation.cancel' && result.upgradeId !== args.upgradeId)) {
            throw new Error('CDS 返回的实施回执与当前稿件或版本不符');
          }
          return receipt;
        }
        if (args.type === 'handoff.check') {
          const data = await workspace(new URLSearchParams({ designId: args.designId, version: args.version }));
          if (!data.permissions.handoffCheck) throw new Error('请使用本项目设计发布或实施授权运行交接检查');
          const receipt = await client.request('POST', path + '/handoff/check', args);
          if (receipt.projectId !== projectId || typeof receipt.reused !== 'boolean'
            || receipt.result?.type !== args.type || receipt.result.designId !== args.designId || receipt.result.version !== args.version) {
            throw new Error('CDS 返回了不同稿件或版本的检查回执');
          }
          return receipt;
        }
        const data = await workspace();
        const programRecheck = args.type === 'acceptance.recheck';
        if (programRecheck ? data.permissions.programRecheck !== true && data.permissions.visual !== true : data.permissions.visual !== true) {
          throw new Error('当前凭据没有所需验收权限，请使用实施授权或设计复验授权');
        }
        let body = args;
        const expected = { type: args.type, designId: args.designId, runId: args.runId };
        if (args.type === 'acceptance.capture' || programRecheck) {
          Object.assign(expected, { screenId: args.screenId, slot: args.slot });
        } else if (args.type === 'acceptance.visual') {
          Object.assign(expected, { screenId: args.screenId, slot: args.slot });
          const { imagePath, referenceImagePath, ...fields } = args;
          body = { ...fields };
          for (const [key, filename] of [['image', imagePath], ['referenceImage', referenceImagePath]]) {
            if (!filename) continue;
            const { bytes } = await localFile(credentials, filename, ['.png'], 1.5 * 1024 * 1024);
            body[key] = `data:image/png;base64,${bytes.toString('base64')}`;
          }
        } else if (args.type === 'acceptance.coverage') expected.id = args.dimension;
        else if (args.type === 'acceptance.regress') expected.id = args.issueId;
        else if (args.type !== 'known.create') expected.id = (args.flow ?? args.smoke).id;
        const receipt = await client.request('POST', path + (programRecheck ? '/acceptance/recheck' : '/commands'), body);
        const result = receipt.result;
        if (receipt.projectId !== projectId || typeof receipt.reused !== 'boolean'
          || (args.type === 'known.create' && !id.safeParse(result?.id).success)
          || Object.entries(expected).some(([key, value]) => result?.[key] !== value)) {
          throw new Error('CDS 返回的验收回执与当前运行、画面或记录不符');
        }
        return receipt;
      }
      if (name === frameworkPublishTool) {
        const data = await intake();
        if (!data.permissions.write || data.permissions.frameworkPublish !== true) {
          throw new Error('当前项目未开放框架发布权限，请核对设计发布授权与 CDS 服务版本');
        }
        const type = 'framework.publish';
        const receipt = await client.request('POST', path + '/frameworks/publish', { ...args, type });
        if (receipt.projectId !== projectId || typeof receipt.reused !== 'boolean' || receipt.result?.type !== type
          || receipt.result.frameworkId !== args.frameworkId || receipt.result.version !== args.expectedVersion + 1) {
          throw new Error('CDS 框架发布回执与当前项目、框架或版本不符');
        }
        return receipt;
      }
      const { zipPath, ...fields } = args;
      const data = fields.intent ? await intake() : await workspace();
      if (!data.permissions.write) throw new Error('当前凭据没有稿件发布权限');
      const targetField = fields.intent ? 'designId' : 'id';
      if (fields.designId !== undefined && !data.designs.some(item => item[targetField] === fields.designId)) {
        throw new Error('请先通过 intake 或 designs 查询当前项目。找不到要续发的原稿时，先确认稿件和基线再发布。');
      }
      const { bytes } = await localFile(credentials, zipPath, ['.zip'], fileLimit);
      const query = new URLSearchParams({ ...fields, ...(fields.sourceMode ? {} : { requireGit: 'true' }) });
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
