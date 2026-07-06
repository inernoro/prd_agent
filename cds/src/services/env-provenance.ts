/*
 * env-provenance — 容器运行时 env 的「带溯源」解析(波2 配置检查器核心)。
 *
 * 背景:容器最终拿到的 env 是两段式合并的产物 ——
 *   段A getMergedEnv(branches.ts):cdsEnv → mirror → global/project customEnv → branch env
 *   段B resolveProfileRuntimeEnv(container.ts):customEnv → JWT 兜底 → node PATH →
 *       profile.env → 版本元数据 → per-branch DB 改写 → ${VAR} 模板展开
 * 此前没有任何地方能回答「容器里这个 JWT_SECRET 到底是哪一层给的」。
 *
 * 本模块把段B重写为**分层纯函数** resolveProfileRuntimeEnvWithProvenance:
 *   - 输入是「层数组」(每层带来源标注),输出 { env, provenance }
 *   - container.ts 的部署路径退化为「单层包装 + 只取 .env」——一条代码路径,
 *     部署行为与旧实现逐字节一致(顺序/条件/异常消息全部保留)
 *   - 检查器端点把段A/段B按真实来源拆层传入,免费获得逐 key 溯源
 *
 * 纯函数、不读 state、不碰 docker,可直接单测。
 */

import type { BuildProfile, EnvKeyProvenance, EnvSource } from '../types.js';
import { resolveEnvTemplates } from './compose-parser.js';
import { applyPerBranchDbIsolation } from './db-scope-isolation.js';

/** 一层 env 来源。合并顺序 = 数组顺序,靠后覆盖靠前(last-writer-wins)。 */
export interface EnvLayer {
  source: EnvSource;
  env: Record<string, string>;
  detail?: string;
}

/**
 * 值里引用了不存在的 ${VAR} 模板 → 返回缺失变量名列表。
 * 从 container.ts 迁来的 SSOT(container.ts 现在从这里 import,避免两份漂移)。
 */
export function missingEnvTemplates(env: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const value of Object.values(env)) {
    value.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_match, name: string, defaultVal: string | undefined) => {
      if (env[name] === undefined && process.env[name] === undefined && defaultVal === undefined) {
        missing.add(name);
      }
      return '';
    });
  }
  return Array.from(missing).sort();
}

/** 分支上下文:只取解析需要的字段,避免依赖完整 BranchEntry(便于单测)。 */
export interface EnvResolveBranchContext {
  branch: string;
  pinnedCommit?: string;
  githubCommitSha?: string;
  lastDeployDispatchCommitSha?: string;
  lastDeployDispatchAt?: string;
  lastPushAt?: string;
  createdAt?: string;
}

export interface EnvResolveResult {
  /** 与旧 resolveProfileRuntimeEnv 逐字节一致的最终 env(部署路径直接用) */
  env: Record<string, string>;
  /** 逐 key 溯源(检查器端点用;输出 API 前必须过 maskSecrets) */
  provenance: EnvKeyProvenance[];
}

interface TrackedEntry {
  value: string;
  source: EnvSource;
  detail?: string;
  shadowed: EnvSource[];
  templated?: boolean;
}

/** 往追踪 map 写一个 key:记录覆盖链(相同来源连续覆盖不重复记 shadow)。 */
function trackSet(
  map: Map<string, TrackedEntry>,
  key: string,
  value: string,
  source: EnvSource,
  detail?: string,
): void {
  const prev = map.get(key);
  if (prev) {
    const shadowed = prev.source === source
      ? prev.shadowed
      : [...prev.shadowed, prev.source];
    map.set(key, { value, source, detail, shadowed });
  } else {
    map.set(key, { value, source, detail, shadowed: [] });
  }
}

/**
 * 段B运行时 env 解析(带溯源)。**与旧 container.ts#resolveProfileRuntimeEnv 行为等价**:
 * 步骤顺序、条件判断、异常消息一字不差,只是把「合并」换成「带来源追踪的合并」。
 *
 * @param entry           分支上下文(版本元数据 + per-branch slug 来源)
 * @param profile         已解析的有效 profile(只读 dockerImage / dbScope;env 不从这读,
 *                        由 profileLayers 显式传入 —— 这样检查器可以拆 baseline/override/mode 层)
 * @param customEnvLayers 段A的 customEnv 层(部署路径传单层;检查器按真实来源拆层)。
 *                        flatten 后必须与部署路径的 getMergedEnv 输出一致。
 * @param profileLayers   profile env 层(部署路径传单层 profile.env;检查器拆
 *                        baseline/extra-service → branch-override → deploy-mode)
 * @param opts.jwtIssuer  Jwt__Issuer 兜底值(config.jwt.issuer)
 */
export function resolveProfileRuntimeEnvWithProvenance(
  entry: EnvResolveBranchContext,
  profile: Pick<BuildProfile, 'dockerImage' | 'dbScope'>,
  customEnvLayers: EnvLayer[],
  profileLayers: EnvLayer[],
  opts: { jwtIssuer: string },
): EnvResolveResult {
  const tracked = new Map<string, TrackedEntry>();

  // 1. 段A customEnv(旧实现:Object.assign(mergedEnv, customEnv))
  for (const layer of customEnvLayers) {
    for (const [k, v] of Object.entries(layer.env)) {
      trackSet(tracked, k, v, layer.source, layer.detail);
    }
  }
  const view = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, e] of tracked) out[k] = e.value;
    return out;
  };
  // 段A合并结果快照 —— 旧实现末段 resolveVars 的 customEnv 语义(profile.env 之前的状态)
  const customEnvSnapshot = customEnvLayers.length > 0 ? view() : undefined;

  // 2. JWT 兜底(在 profile.env 合并**之前**,与旧实现一致)
  const afterCustom = view();
  if (!afterCustom['Jwt__Secret'] && afterCustom['JWT_SECRET']) {
    trackSet(tracked, 'Jwt__Secret', afterCustom['JWT_SECRET'], 'platform-injected', 'jwt-fallback');
  }
  if (!tracked.get('Jwt__Issuer')?.value) {
    trackSet(tracked, 'Jwt__Issuer', opts.jwtIssuer, 'platform-injected', 'jwt-fallback');
  }

  // 3. node 容器 PATH / pnpm(同样在 profile.env 之前)
  const isNodeContainer = /\bnode:/.test(profile.dockerImage);
  if (isNodeContainer) {
    if (!tracked.get('PNPM_HOME')?.value) {
      trackSet(tracked, 'PNPM_HOME', '/pnpm', 'platform-injected', 'node-runtime');
    }
    if (!tracked.get('npm_config_store_dir')?.value) {
      trackSet(tracked, 'npm_config_store_dir', '/pnpm/store', 'platform-injected', 'node-runtime');
    }
    const currentPath = tracked.get('PATH')?.value || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    if (!currentPath.includes('/pnpm')) {
      trackSet(tracked, 'PATH', `/pnpm:${currentPath}`, 'platform-injected', 'node-runtime');
    }
  }

  // 4. profile env 层(旧实现:Object.assign(mergedEnv, profile.env))
  for (const layer of profileLayers) {
    for (const [k, v] of Object.entries(layer.env)) {
      trackSet(tracked, k, v, layer.source, layer.detail);
    }
  }

  // 5. 平台版本元数据(强制覆盖)
  const deployCommit = entry.pinnedCommit || entry.githubCommitSha || entry.lastDeployDispatchCommitSha;
  if (entry.branch) {
    trackSet(tracked, 'VITE_GIT_BRANCH', entry.branch, 'platform-injected', 'version-metadata');
  }
  if (deployCommit) {
    for (const key of ['GIT_COMMIT', 'COMMIT_SHA', 'GITHUB_SHA', 'SOURCE_VERSION', 'CDS_COMMIT_SHA']) {
      trackSet(tracked, key, deployCommit, 'platform-injected', 'version-metadata');
    }
    trackSet(tracked, 'VITE_BUILD_ID', deployCommit.slice(0, 12), 'platform-injected', 'version-metadata');
  }
  const deployTime = entry.lastDeployDispatchAt || entry.lastPushAt || entry.createdAt;
  if (deployTime) {
    trackSet(tracked, 'CDS_BUILD_TIME', deployTime, 'platform-injected', 'version-metadata');
  }

  // 6. per-branch DB 隔离改写(复用 SSOT applyPerBranchDbIsolation,对比 diff 打标)
  const beforeIsolation = view();
  const isolatedEnv = applyPerBranchDbIsolation(beforeIsolation, profile.dbScope, entry.branch);
  for (const [k, v] of Object.entries(isolatedEnv)) {
    if (beforeIsolation[k] !== v) {
      trackSet(tracked, k, v, 'per-branch-db', 'per-branch-db-suffix');
    }
  }

  // 7. 缺失模板校验(异常消息与旧实现一字不差 —— 调用方按消息文案兜底提示)
  const missingTemplates = missingEnvTemplates(isolatedEnv);
  if (missingTemplates.length > 0) {
    throw new Error(
      `环境变量模板缺少值: ${missingTemplates.join(', ')}。请在项目环境变量中填写，或先启动对应基础设施服务后再部署。`,
    );
  }

  // 8. ${VAR} 模板展开(resolveVars 语义保留:值为自引用模板且 customEnv 有真值时用后者)
  const resolveVars: Record<string, string> = { ...isolatedEnv };
  if (customEnvSnapshot) {
    for (const [k, v] of Object.entries(isolatedEnv)) {
      if (v === `\${${k}}` && customEnvSnapshot[k] !== undefined) {
        resolveVars[k] = customEnvSnapshot[k];
      }
    }
  }
  const resolvedEnv = resolveEnvTemplates(isolatedEnv, resolveVars);

  const provenance: EnvKeyProvenance[] = [];
  for (const [key, entryTracked] of tracked) {
    const finalValue = resolvedEnv[key];
    if (finalValue === undefined) continue;
    provenance.push({
      key,
      value: finalValue,
      source: entryTracked.source,
      ...(entryTracked.detail ? { detail: entryTracked.detail } : {}),
      ...(entryTracked.shadowed.length > 0 ? { shadowed: entryTracked.shadowed } : {}),
      ...(finalValue !== entryTracked.value ? { templated: true } : {}),
    });
  }
  provenance.sort((a, b) => a.key.localeCompare(b.key));

  return { env: resolvedEnv, provenance };
}
