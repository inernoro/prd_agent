/*
 * ExtraServiceFormDialog — 分支级临时额外服务的新建/编辑表单（波1 W1b）。
 *
 * 服务端契约：PUT /api/branches/:id/extra-services（整体替换数组），字段校验与
 * cds/src/routes/branches.ts 的 PUT handler 一一对齐（id/镜像/端口/subdomain/
 * workDir/containerWorkDir/entrypoint/dbScope）。这里做同款客户端预校验，
 * 让用户在提交前就看到具体哪个字段不合法，而不是等 400 才知道。
 *
 * 零摩擦（zero-friction-input）：预设下拉（Nacos/Kafka/RabbitMQ/Redis/MinIO）
 * 一键填入镜像/端口/默认 env/建议子域，用户改差异即可，不必从空白表单开始。
 *
 * 掩码契约：编辑已有服务时 env 值可能是 ***（服务端脱敏）。保持原样回传是安全的
 * ——服务端 PUT 会剥离掩码哨兵并恢复旧值，绝不落库字面 ***。
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface ExtraServiceProfile {
  id: string;
  name?: string;
  dockerImage: string;
  containerPort: number;
  command?: string;
  workDir?: string;
  containerWorkDir?: string;
  entrypoint?: string;
  dbScope?: 'shared' | 'per-branch';
  subdomain?: string;
  env?: Record<string, string>;
  pathPrefixes?: string[];
  dependsOn?: string[];
  prebuiltImage?: boolean;
}

interface PresetDef {
  key: string;
  label: string;
  id: string;
  dockerImage: string;
  containerPort: number;
  command?: string;
  subdomain?: string;
  env?: Record<string, string>;
  note?: string;
}

// 预设都是「起点」不是「终点」：填入后所有字段仍可改（anti-detour：智能默认 + 可编辑）。
const PRESETS: PresetDef[] = [
  {
    key: 'nacos',
    label: 'Nacos（注册/配置中心）',
    id: 'nacos',
    dockerImage: 'nacos/nacos-server:v2.3.2',
    containerPort: 8848,
    subdomain: 'nacos',
    env: { MODE: 'standalone' },
    note: '单机模式，控制台路径 /nacos',
  },
  {
    key: 'kafka',
    label: 'Kafka（消息队列，KRaft 单节点）',
    id: 'kafka',
    dockerImage: 'bitnami/kafka:3.7',
    containerPort: 9092,
    env: {
      KAFKA_CFG_NODE_ID: '0',
      KAFKA_CFG_PROCESS_ROLES: 'controller,broker',
      KAFKA_CFG_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
      KAFKA_CFG_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CFG_CONTROLLER_QUORUM_VOTERS: '0@localhost:9093',
    },
  },
  {
    key: 'rabbitmq',
    label: 'RabbitMQ（消息队列，带管理台）',
    id: 'rabbitmq',
    dockerImage: 'rabbitmq:3.13-management',
    containerPort: 15672,
    subdomain: 'mq',
    note: '路由端口指向 15672 管理台；AMQP 走容器网 5672',
  },
  {
    key: 'redis',
    label: 'Redis（缓存，分支独享实例）',
    id: 'redis-local',
    dockerImage: 'redis:7-alpine',
    containerPort: 6379,
  },
  {
    key: 'minio',
    label: 'MinIO（对象存储）',
    id: 'minio',
    dockerImage: 'minio/minio:latest',
    containerPort: 9001,
    command: 'server /data --console-address :9001',
    subdomain: 'minio',
    env: { MINIO_ROOT_USER: 'admin', MINIO_ROOT_PASSWORD: 'change-me-now' },
    note: '路由端口指向 9001 控制台；S3 API 走容器网 9000',
  },
];

// 与服务端校验一一对齐（cds/src/routes/branches.ts PUT /extra-services +
// cds/src/services/branch-extra-services.ts）。
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/;
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const RESERVED_SUBDOMAINS = new Set(['null', 'undefined', 'none', 'true', 'false', 'nan']);
const WORKDIR_RE = /^[a-zA-Z0-9._/-]+$/;
const CONTAINER_WORKDIR_RE = /^\/[a-zA-Z0-9._/-]*$/;

function envToText(env?: Record<string, string>): string {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function textToEnv(text: string): { env: Record<string, string>; error?: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) return { env, error: `环境变量需要 KEY=VALUE 形式：${line}` };
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { env };
}

function validateDraft(draft: ExtraServiceProfile): string | null {
  if (!ID_RE.test(draft.id)) return '服务 id 非法：字母/数字开头，可含 - _，长度 1..63';
  if (!draft.dockerImage.trim()) return '镜像不能为空';
  if (!IMAGE_RE.test(draft.dockerImage.trim())) return '镜像引用仅允许字母/数字/._:/@-';
  if (!Number.isInteger(draft.containerPort) || draft.containerPort <= 0 || draft.containerPort > 65535) {
    return '容器端口须为 1..65535 的整数';
  }
  if (draft.subdomain) {
    const sd = draft.subdomain.trim().toLowerCase();
    if (!SUBDOMAIN_RE.test(sd) || RESERVED_SUBDOMAINS.has(sd)) {
      return '命名子域须为单个 DNS label（小写字母/数字/连字符，不以连字符开头/结尾，长度 1..40）';
    }
  }
  if (draft.workDir && (!WORKDIR_RE.test(draft.workDir) || draft.workDir.split('/').includes('..'))) {
    return '挂载目录仅允许相对路径（字母/数字/._-/），禁 .. 穿越';
  }
  if (draft.containerWorkDir && (!CONTAINER_WORKDIR_RE.test(draft.containerWorkDir) || draft.containerWorkDir.split('/').includes('..'))) {
    return '容器工作目录须为容器内绝对路径（字母/数字/._-/），禁 .. 穿越';
  }
  if (draft.entrypoint && draft.entrypoint !== '' && (/\s/.test(draft.entrypoint) || !/^\/?[a-zA-Z0-9._/-]+$/.test(draft.entrypoint))) {
    return 'entrypoint 须为单个可执行名/路径（无空格与 shell 元字符），或留空';
  }
  return null;
}

export function ExtraServiceFormDialog({
  open,
  initial,
  existingIds,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  /** 编辑时传入现有服务（env 可能已脱敏为 ***，原样保留即可）；新建传 null。 */
  initial: ExtraServiceProfile | null;
  /** 本分支已存在的额外服务 id（新建时用于撞名预警）。 */
  existingIds: string[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (draft: ExtraServiceProfile, redeploy: boolean) => void;
}): JSX.Element {
  const isEdit = initial != null;
  const [serviceId, setServiceId] = useState('');
  const [image, setImage] = useState('');
  const [port, setPort] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [dbScope, setDbScope] = useState<'' | 'shared' | 'per-branch'>('');
  const [command, setCommand] = useState('');
  const [envText, setEnvText] = useState('');
  const [workDir, setWorkDir] = useState('');
  const [containerWorkDir, setContainerWorkDir] = useState('');
  const [entrypoint, setEntrypoint] = useState('');
  const [pathPrefixes, setPathPrefixes] = useState('');
  const [dependsOn, setDependsOn] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [presetNote, setPresetNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [redeploy, setRedeploy] = useState(true);

  useEffect(() => {
    if (!open) return;
    setServiceId(initial?.id || '');
    setImage(initial?.dockerImage || '');
    setPort(initial?.containerPort ? String(initial.containerPort) : '');
    setSubdomain(initial?.subdomain || '');
    setDbScope(initial?.dbScope || '');
    setCommand(initial?.command || '');
    setEnvText(envToText(initial?.env));
    setWorkDir(initial?.workDir || '');
    setContainerWorkDir(initial?.containerWorkDir || '');
    setEntrypoint(initial?.entrypoint ?? '');
    setPathPrefixes((initial?.pathPrefixes || []).join(', '));
    setDependsOn((initial?.dependsOn || []).join(', '));
    setShowAdvanced(Boolean(initial?.workDir || initial?.containerWorkDir || initial?.entrypoint || initial?.pathPrefixes?.length || initial?.dependsOn?.length));
    setPresetNote('');
    setError(null);
    setRedeploy(true);
  }, [open, initial]);

  const idCollision = useMemo(
    () => !isEdit && serviceId !== '' && existingIds.includes(serviceId),
    [isEdit, serviceId, existingIds],
  );

  const applyPreset = (key: string): void => {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    // 撞已有 id 时给 -2 后缀，避免用户直接提交被拒
    let id = preset.id;
    let n = 2;
    while (existingIds.includes(id)) id = `${preset.id}-${n++}`;
    setServiceId(id);
    setImage(preset.dockerImage);
    setPort(String(preset.containerPort));
    setSubdomain(preset.subdomain || '');
    setCommand(preset.command || '');
    setEnvText(envToText(preset.env));
    setPresetNote(preset.note || '');
    setError(null);
  };

  const handleSubmit = (): void => {
    const { env, error: envError } = textToEnv(envText);
    if (envError) { setError(envError); return; }
    const draft: ExtraServiceProfile = {
      ...(initial || {}),
      id: serviceId.trim(),
      name: initial?.name || serviceId.trim(),
      dockerImage: image.trim(),
      containerPort: Number(port),
      command: command.trim(),
      workDir: workDir.trim(),
      // subdomain 契约：空串=有意清空命名 URL；非空=采用。编辑时字段总是显式携带，
      // 让「清空」也能表达（服务端把缺省视为继承旧值）。
      subdomain: subdomain.trim().toLowerCase(),
      ...(dbScope ? { dbScope } : {}),
      ...(containerWorkDir.trim() ? { containerWorkDir: containerWorkDir.trim() } : {}),
      // UI 简化：非空才发送 entrypoint；清空输入框 = 移除覆盖（PUT 整体替换，缺省字段即删除）。
      // 「空串清空镜像 ENTRYPOINT」的极端场景走 cdscli / API。
      ...(entrypoint.trim() ? { entrypoint: entrypoint.trim() } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(pathPrefixes.trim()
        ? { pathPrefixes: pathPrefixes.split(',').map((s) => s.trim()).filter(Boolean) }
        : {}),
      ...(dependsOn.trim()
        ? { dependsOn: dependsOn.split(',').map((s) => s.trim()).filter(Boolean) }
        : {}),
      // 无源码挂载的纯镜像服务按 prebuilt 处理（跳过源码构建阶段）
      ...(workDir.trim() === '' ? { prebuiltImage: true } : {}),
    };
    const validationError = validateDraft(draft);
    if (validationError) { setError(validationError); return; }
    setError(null);
    onSubmit(draft, redeploy);
  };

  const inputClass = 'h-9 w-full rounded-md border border-input bg-background px-3 text-sm';
  const labelClass = 'mb-1 block text-xs font-medium text-muted-foreground';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[90vh] w-full max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `编辑临时服务：${initial?.id}` : '添加临时服务'}</DialogTitle>
          <DialogDescription>
            只作用于当前分支的实验容器，不影响项目配置和其他分支；删除分支时一并清理。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {!isEdit ? (
            <div>
              <label className={labelClass}>常用预设（选后可改）</label>
              <select
                className={inputClass}
                defaultValue=""
                onChange={(e) => { if (e.target.value) applyPreset(e.target.value); }}
              >
                <option value="">自定义（从空白开始）</option>
                {PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
              {presetNote ? <div className="mt-1 text-xs text-muted-foreground">{presetNote}</div> : null}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>服务 id</label>
              <input
                className={inputClass}
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                placeholder="nacos"
                disabled={isEdit}
              />
              {idCollision ? (
                <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">该 id 已存在，保存将覆盖同名服务</div>
              ) : null}
            </div>
            <div>
              <label className={labelClass}>容器端口</label>
              <input
                className={inputClass}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8848"
                inputMode="numeric"
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>镜像</label>
            <input
              className={`${inputClass} font-mono`}
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="nacos/nacos-server:v2.3.2"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>命名子域（可选）</label>
              <input
                className={inputClass}
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder="nacos"
              />
              <div className="mt-1 text-xs text-muted-foreground">设置后获得独立入口 URL</div>
            </div>
            <div>
              <label className={labelClass}>数据库隔离</label>
              <select
                className={inputClass}
                value={dbScope}
                onChange={(e) => setDbScope(e.target.value as '' | 'shared' | 'per-branch')}
              >
                <option value="">默认（共享库）</option>
                <option value="shared">共享库</option>
                <option value="per-branch">分支独立库（DB 名加分支后缀）</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelClass}>启动命令（可选，镜像默认 CMD 够用则留空）</label>
            <input
              className={`${inputClass} font-mono`}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder=""
            />
          </div>

          <div>
            <label className={labelClass}>环境变量（每行一条 KEY=VALUE；已保存密钥显示为 ***，保持不动即保留原值）</label>
            <textarea
              className="min-h-[88px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'MODE=standalone'}
            />
          </div>

          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            高级选项（挂载 / 入口 / 路由前缀 / 启动依赖）
          </button>
          {showAdvanced ? (
            <div className="space-y-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>源码挂载目录（相对仓库根；纯镜像服务留空）</label>
                  <input className={`${inputClass} font-mono`} value={workDir} onChange={(e) => setWorkDir(e.target.value)} placeholder="" />
                </div>
                <div>
                  <label className={labelClass}>容器工作目录（绝对路径，默认 /app）</label>
                  <input className={`${inputClass} font-mono`} value={containerWorkDir} onChange={(e) => setContainerWorkDir(e.target.value)} placeholder="/app" />
                </div>
              </div>
              <div>
                <label className={labelClass}>entrypoint 覆盖（单个可执行名/路径；留空表示不覆盖）</label>
                <input className={`${inputClass} font-mono`} value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} placeholder="" />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass}>路由前缀（逗号分隔）</label>
                  <input className={`${inputClass} font-mono`} value={pathPrefixes} onChange={(e) => setPathPrefixes(e.target.value)} placeholder="/nacos" />
                </div>
                <div>
                  <label className={labelClass}>启动依赖（逗号分隔的服务 id）</label>
                  <input className={`${inputClass} font-mono`} value={dependsOn} onChange={(e) => setDependsOn(e.target.value)} placeholder="mysql, redis" />
                </div>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={redeploy}
              onChange={(e) => setRedeploy(e.target.checked)}
              className="h-4 w-4"
            />
            保存后立即重新部署本分支（让容器真正起来；不勾则下次部署时生效）
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? '保存中…' : redeploy ? '保存并重新部署' : '仅保存配置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
