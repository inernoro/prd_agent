/**
 * Compose Parser — reads docker-compose.yml and extracts service definitions.
 *
 * Standard compose format: Zero custom extensions. Auto-detects app vs infra:
 *   - Services with relative volume mounts (`./xxx:/path`) → app services (BuildProfile)
 *   - Services without relative mounts → infra services
 *   - `depends_on` → startup ordering
 *   - `labels.cds.path-prefix` → proxy routing
 *   - App environment uses `${CDS_<SERVICE>_PORT}` for dynamic port injection
 *
 * Produces CdsComposeConfig for internal use.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { InfraService, InfraVolume, InfraHealthCheck, BuildProfile, RoutingRule, DeployModeOverride, ResourceLimits } from '../types.js';

/** Parsed infrastructure service from a compose file */
export interface ComposeServiceDef {
  id: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  volumes: InfraVolume[];
  env: Record<string, string>;
  healthCheck?: InfraHealthCheck;
}

/** Raw compose YAML structure */
interface ComposeFile {
  services?: Record<string, ComposeServiceEntry>;
  volumes?: Record<string, unknown>;
  /** CDS extension: project metadata */
  'x-cds-project'?: { name?: string; description?: string; repo?: string };
  /** CDS extension: shared environment variables */
  'x-cds-env'?: Record<string, string>;
  /** CDS extension: routing rules */
  'x-cds-routing'?: Array<{
    id: string;
    name?: string;
    type?: 'header' | 'domain' | 'pattern';
    match: string;
    branch: string;
    priority?: number;
    enabled?: boolean;
  }>;
  /**
   * CDS extension: deploy mode alternatives per service.
   * Keys are service IDs, values are mode maps: { modeId: { label, command?, image?, env? } }
   */
  'x-cds-deploy-modes'?: Record<string, Record<string, {
    label?: string;
    command?: string;
    image?: string;
    env?: Record<string, string>;
  }>>;
}

interface ComposeServiceEntry {
  image?: string;
  build?: unknown;
  ports?: Array<string | { target: number; published?: number }>;
  volumes?: string[];
  environment?: Record<string, string> | string[];
  healthcheck?: {
    test?: string | string[];
    interval?: string;
    retries?: number;
  };
  container_name?: string;
  command?: string | string[];
  working_dir?: string;
  depends_on?: Record<string, { condition?: string }> | string[];
  labels?: Record<string, string> | string[];
  entrypoint?: string | string[];
  /**
   * Standard compose v3+ deploy block. CDS reads `resources.limits` for
   * cgroup enforcement. `deploy.replicas` etc. are ignored — CDS is not Swarm.
   */
  deploy?: {
    resources?: {
      limits?: {
        memory?: string;  // e.g. "512M", "2G"
        cpus?: string;    // e.g. "1.5", "0.5"
      };
    };
  };
  /** CDS extension: simpler alternative to deploy.resources.limits */
  'x-cds-resources'?: {
    memoryMB?: number;
    cpus?: number;
  };
}

/**
 * Parse resource limits from a compose service entry.
 *
 * Priority order:
 *   1. `x-cds-resources` extension (our preferred format, numeric)
 *   2. `deploy.resources.limits` (standard compose format, string with units)
 *   3. undefined (no limits)
 *
 * Memory string parsing: "512M" → 512, "2G" → 2048, "1024" → 1024 (bytes → MB rounded).
 * CPU string parsing: "1.5" → 1.5, "0.5" → 0.5.
 *
 * Returns undefined when neither source is present so the downstream
 * code can skip adding cgroup flags entirely (backward compat).
 */
export function parseResourceLimits(entry: ComposeServiceEntry): ResourceLimits | undefined {
  // Preferred: x-cds-resources (numeric, unambiguous)
  if (entry['x-cds-resources']) {
    const r = entry['x-cds-resources'];
    const result: ResourceLimits = {};
    if (typeof r.memoryMB === 'number' && r.memoryMB > 0) result.memoryMB = Math.floor(r.memoryMB);
    if (typeof r.cpus === 'number' && r.cpus > 0) result.cpus = r.cpus;
    return Object.keys(result).length > 0 ? result : undefined;
  }

  // Fallback: standard compose deploy.resources.limits
  const limits = entry.deploy?.resources?.limits;
  if (!limits) return undefined;

  const result: ResourceLimits = {};
  if (limits.memory) {
    const mb = parseMemoryToMB(limits.memory);
    if (mb !== undefined) result.memoryMB = mb;
  }
  if (limits.cpus) {
    const n = Number(limits.cpus);
    if (Number.isFinite(n) && n > 0) result.cpus = n;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Convert a compose memory string like "512M" / "2G" / "1024" to MB. */
function parseMemoryToMB(s: string): number | undefined {
  const trimmed = String(s).trim();
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?[bB]?)?$/);
  if (!m) return undefined;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '' || unit === 'b') return Math.max(1, Math.round(num / (1024 * 1024)));
  if (unit.startsWith('k')) return Math.max(1, Math.round(num / 1024));
  if (unit.startsWith('m')) return Math.round(num);
  if (unit.startsWith('g')) return Math.round(num * 1024);
  return undefined;
}

/** Result of parsing a full CDS compose file (infra + profiles + env + routing) */
export interface CdsComposeConfig {
  project?: { name?: string; description?: string; repo?: string };
  buildProfiles: Array<{
    id: string;
    name: string;
    dockerImage: string;
    workDir: string;
    containerWorkDir?: string;
    command?: string;
    containerPort: number;
    env?: Record<string, string>;
    cacheMounts?: Array<{ hostPath: string; containerPath: string }>;
    buildTimeout?: number;
    pathPrefixes?: string[];
    dependsOn?: string[];
    readinessProbe?: { path?: string; intervalSeconds?: number; timeoutSeconds?: number };
    deployModes?: Record<string, DeployModeOverride>;
    resources?: ResourceLimits;
  }>;
  envVars: Record<string, string>;
  infraServices: ComposeServiceDef[];
  routingRules: Array<{
    id: string;
    name: string;
    type: 'header' | 'domain' | 'pattern';
    match: string;
    branch: string;
    priority: number;
    enabled: boolean;
  }>;
}

/**
 * Discover compose files in a directory.
 * Looks for (in order): cds-compose.yml, docker-compose.yml, docker-compose.dev.yml, compose.yml
 */
export function discoverComposeFiles(dir: string): string[] {
  const candidates = [
    'cds-compose.yml',
    'cds-compose.yaml',
    'docker-compose.yml',
    'docker-compose.yaml',
    'docker-compose.dev.yml',
    'docker-compose.dev.yaml',
    'compose.yml',
    'compose.yaml',
  ];

  return candidates
    .map(f => path.join(dir, f))
    .filter(f => fs.existsSync(f));
}

/**
 * Parse a compose file and extract infrastructure service definitions.
 *
 * Only services with an `image` field and no relative volume mounts are extracted
 * (services with relative mounts are considered application services).
 */
export function parseComposeFile(filePath: string): ComposeServiceDef[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const doc = yaml.load(content) as ComposeFile | null;

  if (!doc?.services) return [];

  const results: ComposeServiceDef[] = [];

  for (const [serviceId, entry] of Object.entries(doc.services)) {
    // Skip services that use build (they are app services, not infrastructure)
    // Also skip services without an image
    if (entry.build || !entry.image) continue;

    // Skip services with relative volume mounts (app services)
    if (hasRelativeVolumeMount(entry.volumes)) continue;

    const containerPort = extractContainerPort(entry.ports);
    if (!containerPort) continue; // No port = not a network service CDS should manage

    const parsed: ComposeServiceDef = {
      id: serviceId,
      name: generateDisplayName(serviceId, entry.image),
      dockerImage: entry.image,
      containerPort,
      volumes: extractVolumes(entry.volumes),
      env: extractEnv(entry.environment),

      healthCheck: extractHealthCheck(entry.healthcheck),
    };

    results.push(parsed);
  }

  return results;
}

/**
 * Parse an inline compose YAML string (e.g., from import config).
 */
export function parseComposeString(yamlString: string): ComposeServiceDef[] {
  const doc = yaml.load(yamlString) as ComposeFile | null;

  if (!doc?.services) return [];

  const results: ComposeServiceDef[] = [];

  for (const [serviceId, entry] of Object.entries(doc.services)) {
    if (!entry.image) continue;

    // Skip services with relative mounts (app services)
    if (hasRelativeVolumeMount(entry.volumes)) continue;

    const containerPort = extractContainerPort(entry.ports);
    if (!containerPort) continue;

    results.push({
      id: serviceId,
      name: generateDisplayName(serviceId, entry.image),
      dockerImage: entry.image,
      containerPort,
      volumes: extractVolumes(entry.volumes),
      env: extractEnv(entry.environment),

      healthCheck: extractHealthCheck(entry.healthcheck),
    });
  }

  return results;
}

/**
 * Convert InfraService definitions back to compose YAML format.
 */
export function toComposeYaml(services: InfraService[]): string {
  const compose: Record<string, unknown> = {
    services: {} as Record<string, unknown>,
  };

  const volumeNames = new Set<string>();
  const servicesMap = compose.services as Record<string, unknown>;

  for (const svc of services) {
    const entry: Record<string, unknown> = {
      image: svc.dockerImage,
      ports: [`${svc.containerPort}`],
    };

    // Volumes
    if (svc.volumes.length > 0) {
      entry.volumes = svc.volumes.map(v => {
        const suffix = v.readOnly ? ':ro' : '';
        return `${v.name}:${v.containerPath}${suffix}`;
      });
      for (const v of svc.volumes) {
        // Only named volumes go into the top-level volumes section
        if (v.type !== 'bind') volumeNames.add(v.name);
      }
    }

    // Container env
    if (Object.keys(svc.env).length > 0) {
      entry.environment = { ...svc.env };
    }

    // Health check
    if (svc.healthCheck) {
      entry.healthcheck = {
        test: svc.healthCheck.command,
        interval: `${svc.healthCheck.interval}s`,
        retries: svc.healthCheck.retries,
      };
    }

    servicesMap[svc.id] = entry;
  }

  // Add named volumes
  if (volumeNames.size > 0) {
    const volumes: Record<string, null> = {};
    for (const name of volumeNames) volumes[name] = null;
    compose.volumes = volumes;
  }

  return yaml.dump(compose, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/**
 * Parse a full CDS compose YAML.
 *
 * Detection:
 * - Services with relative volume mounts (./xxx:/path) → app services (BuildProfile)
 * - Services without relative mounts → infra services
 * - `x-cds-env` / `x-cds-routing` extensions are supported for global config
 *
 * Returns null if the YAML can't be parsed as a CDS compose file.
 */
export function parseCdsCompose(yamlString: string): CdsComposeConfig | null {
  const doc = yaml.load(yamlString) as ComposeFile | null;
  if (!doc) return null;

  const hasCdsExtensions = doc['x-cds-env'] || doc['x-cds-project'] || doc['x-cds-routing'] || doc['x-cds-deploy-modes'];

  // Check for app services: any service with a relative volume mount
  const hasAppServices = doc.services
    ? Object.values(doc.services).some(entry => hasRelativeVolumeMount(entry.volumes))
    : false;

  // Need at least CDS extensions or app services to be a CDS compose file
  if (!hasCdsExtensions && !hasAppServices) return null;

  return parseStandardCompose(doc);
}

/**
 * Standard compose parser — auto-detects app vs infra services.
 *
 * Classification rules:
 * - Service with relative volume mount (./xxx:/path) → app service (BuildProfile)
 * - Service without relative mount → infra service
 * - `depends_on` → startup ordering
 * - `labels.cds.path-prefix` → proxy routing
 * - App `environment` may use `${CDS_<SERVICE>_PORT}` for dynamic port injection
 */
function parseStandardCompose(doc: ComposeFile): CdsComposeConfig {
  const buildProfiles: CdsComposeConfig['buildProfiles'] = [];
  const infraServices: ComposeServiceDef[] = [];

  if (doc.services) {
    for (const [serviceId, entry] of Object.entries(doc.services)) {
      if (!entry.image) continue;

      if (hasRelativeVolumeMount(entry.volumes)) {
        // App service — extract as BuildProfile
        const relMount = findRelativeMount(entry.volumes);
        const containerPort = extractContainerPort(entry.ports) || 8080;
        const labels = extractLabels(entry.labels);
        const pathPrefix = labels['cds.path-prefix'];
        const dependsOn = extractDependsOn(entry.depends_on);
        const command = extractCommand(entry.command);

        // Readiness probe from compose label
        const readinessPath = labels['cds.readiness-path'];
        const readinessTimeout = labels['cds.readiness-timeout'];
        const readinessInterval = labels['cds.readiness-interval'];
        const readinessProbe = readinessPath ? {
          path: readinessPath,
          ...(readinessTimeout ? { timeoutSeconds: parseInt(readinessTimeout, 10) } : {}),
          ...(readinessInterval ? { intervalSeconds: parseInt(readinessInterval, 10) } : {}),
        } : undefined;

        buildProfiles.push({
          id: serviceId,
          name: serviceId,
          dockerImage: entry.image,
          workDir: relMount?.hostPath || '.',
          containerWorkDir: entry.working_dir || '/app',
          command: command || undefined,
          containerPort,
          env: extractEnv(entry.environment),
          pathPrefixes: pathPrefix ? pathPrefix.split(',').map(s => s.trim()) : undefined,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          cacheMounts: extractCacheMounts(entry.volumes),
          readinessProbe,
          resources: parseResourceLimits(entry),
        });
      } else {
        // Infra service — no relative mount
        const containerPort = extractContainerPort(entry.ports);
        if (!containerPort) continue;

        infraServices.push({
          id: serviceId,
          name: generateDisplayName(serviceId, entry.image),
          dockerImage: entry.image,
          containerPort,
          volumes: extractVolumes(entry.volumes),
          env: extractEnv(entry.environment),
    
          healthCheck: extractHealthCheck(entry.healthcheck),
        });
      }
    }
  }

  // Attach deploy modes from x-cds-deploy-modes extension
  const deployModesConfig = doc['x-cds-deploy-modes'];
  if (deployModesConfig) {
    for (const bp of buildProfiles) {
      const modes = deployModesConfig[bp.id];
      if (!modes) continue;
      const parsed: Record<string, DeployModeOverride> = {};
      for (const [modeId, mode] of Object.entries(modes)) {
        parsed[modeId] = {
          label: mode.label || modeId,
          command: mode.command,
          dockerImage: mode.image,
          env: mode.env,
        };
      }
      bp.deployModes = parsed;
    }
  }

  // Extract optional CDS extensions (routing/env)
  const envVars: Record<string, string> = doc['x-cds-env'] ? { ...doc['x-cds-env'] } : {};
  const routingRules = parseRoutingRules(doc);

  return {
    project: doc['x-cds-project'],
    buildProfiles,
    envVars,
    infraServices,
    routingRules,
  };
}

/**
 * Export full CDS config as a standard compose YAML.
 * App services are compose entries with relative volume mounts.
 * Infra services are standard compose entries.
 */
export function toCdsCompose(
  profiles: BuildProfile[],
  envVars: Record<string, string>,
  infraServices: InfraService[],
  routingRules: RoutingRule[],
): string {
  const doc: Record<string, unknown> = {};
  const servicesMap: Record<string, Record<string, unknown>> = {};
  const volumeNames = new Set<string>();

  // App services from profiles
  for (const p of profiles) {
    const entry: Record<string, unknown> = {
      image: p.dockerImage,
    };

    // working_dir
    const containerWorkDir = p.containerWorkDir || '/app';
    entry.working_dir = containerWorkDir;

    // volumes: relative mount for source + cache mounts
    const volumes: string[] = [];
    const workDir = p.workDir === '.' ? '.' : `./${p.workDir.replace(/^\.\//, '')}`;
    volumes.push(`${workDir}:${containerWorkDir}`);
    if (p.cacheMounts) {
      for (const cm of p.cacheMounts) {
        volumes.push(`${cm.hostPath}:${cm.containerPath}`);
        // Named volumes need top-level declaration
        if (!cm.hostPath.startsWith('/') && !cm.hostPath.startsWith('.')) {
          volumeNames.add(cm.hostPath);
        }
      }
    }
    entry.volumes = volumes;

    // ports
    entry.ports = [`${p.containerPort}`];

    // command
    if (p.command) {
      entry.command = p.command;
    }

    // depends_on
    if (p.dependsOn && p.dependsOn.length > 0) {
      const depsMap: Record<string, { condition: string }> = {};
      for (const dep of p.dependsOn) {
        // If the dependency has a healthcheck, use service_healthy
        const infraSvc = infraServices.find(s => s.id === dep);
        const condition = infraSvc?.healthCheck ? 'service_healthy' : 'service_started';
        depsMap[dep] = { condition };
      }
      entry.depends_on = depsMap;
    }

    // environment
    if (p.env && Object.keys(p.env).length > 0) {
      entry.environment = { ...p.env };
    }

    // labels (path prefix + readiness probe)
    const entryLabels: Record<string, string> = {};
    if (p.pathPrefixes && p.pathPrefixes.length > 0) {
      entryLabels['cds.path-prefix'] = p.pathPrefixes.join(',');
    }
    if (p.readinessProbe?.path) {
      entryLabels['cds.readiness-path'] = p.readinessProbe.path;
      if (p.readinessProbe.timeoutSeconds) entryLabels['cds.readiness-timeout'] = String(p.readinessProbe.timeoutSeconds);
      if (p.readinessProbe.intervalSeconds) entryLabels['cds.readiness-interval'] = String(p.readinessProbe.intervalSeconds);
    }
    if (Object.keys(entryLabels).length > 0) {
      entry.labels = entryLabels;
    }

    servicesMap[p.id] = entry;
  }

  // Infra services
  for (const svc of infraServices) {
    const entry: Record<string, unknown> = {
      image: svc.dockerImage,
      ports: [`${svc.containerPort}`],
    };

    if (svc.volumes.length > 0) {
      entry.volumes = svc.volumes.map(v => {
        const suffix = v.readOnly ? ':ro' : '';
        return `${v.name}:${v.containerPath}${suffix}`;
      });
      for (const v of svc.volumes) {
        if (v.type !== 'bind') volumeNames.add(v.name);
      }
    }

    if (Object.keys(svc.env).length > 0) {
      entry.environment = { ...svc.env };
    }

    if (svc.healthCheck) {
      entry.healthcheck = {
        test: svc.healthCheck.command,
        interval: `${svc.healthCheck.interval}s`,
        retries: svc.healthCheck.retries,
      };
    }

    servicesMap[svc.id] = entry;
  }

  if (Object.keys(servicesMap).length > 0) {
    doc.services = servicesMap;
  }

  // Optional x-cds-env (useful for global shared env vars)
  if (Object.keys(envVars).length > 0) {
    doc['x-cds-env'] = { ...envVars };
  }

  // Optional x-cds-deploy-modes
  const deployModesOut: Record<string, Record<string, { label: string; command?: string; image?: string; env?: Record<string, string> }>> = {};
  for (const p of profiles) {
    if (p.deployModes && Object.keys(p.deployModes).length > 0) {
      const modes: Record<string, { label: string; command?: string; image?: string; env?: Record<string, string> }> = {};
      for (const [modeId, mode] of Object.entries(p.deployModes)) {
        modes[modeId] = {
          label: mode.label,
          ...(mode.command ? { command: mode.command } : {}),
          ...(mode.dockerImage ? { image: mode.dockerImage } : {}),
          ...(mode.env ? { env: mode.env } : {}),
        };
      }
      deployModesOut[p.id] = modes;
    }
  }
  if (Object.keys(deployModesOut).length > 0) {
    doc['x-cds-deploy-modes'] = deployModesOut;
  }

  // Optional x-cds-routing
  if (routingRules.length > 0) {
    doc['x-cds-routing'] = routingRules.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      match: r.match,
      branch: r.branch,
      priority: r.priority,
      enabled: r.enabled,
    }));
  }

  // Named volumes
  if (volumeNames.size > 0) {
    const volumes: Record<string, null> = {};
    for (const name of volumeNames) volumes[name] = null;
    doc.volumes = volumes;
  }

  return yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/**
 * Resolve ${VAR} env var templates in a value string.
 * Lookup order: cdsVars → process.env (host) → default → empty string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 *
 * 嵌套展开(2026-05-01,Phase 1 fix):cdsVars 里的值如果本身含 ${VAR},
 * 必须先展开成最终值,然后才用来替换 env。否则会出现下面的现象:
 *   cdsVars.MONGO_PASSWORD = "secret"
 *   cdsVars.MONGODB_URL    = "mongodb://${MONGO_USER}:${MONGO_PASSWORD}@host"
 *   env.DATABASE_URL       = "${MONGODB_URL}"
 *
 *   单次替换 → DATABASE_URL = "mongodb://${MONGO_USER}:${MONGO_PASSWORD}@host"  ❌
 *   嵌套展开 → DATABASE_URL = "mongodb://root:secret@host"                      ✓
 *
 * 用 fixed-point iteration:迭代展开 cdsVars 自身,直到稳定或达到 8 次上限
 * (8 次足够覆盖任何合理的引用深度,防止循环引用造成无限循环)。
 */
const ENV_TEMPLATE_RE = /\$\{(\w+)(?::-(.*?))?\}/g;
const MAX_ENV_RESOLVE_ITERATIONS = 8;

function singlePassResolve(
  value: string,
  vars: Record<string, string>,
): string {
  return value.replace(ENV_TEMPLATE_RE, (_match, name, defaultVal) => {
    return vars[name] ?? process.env[name] ?? defaultVal ?? '';
  });
}

/** 把 cdsVars 自身做 fixed-point 展开,直到所有值都不再含 ${VAR}(或达上限)。 */
function expandVarsToFixedPoint(cdsVars: Record<string, string>): Record<string, string> {
  let current: Record<string, string> = { ...cdsVars };
  for (let i = 0; i < MAX_ENV_RESOLVE_ITERATIONS; i++) {
    const next: Record<string, string> = {};
    let changed = false;
    for (const [k, v] of Object.entries(current)) {
      const resolved = singlePassResolve(v, current);
      next[k] = resolved;
      if (resolved !== v) changed = true;
    }
    current = next;
    if (!changed) return current;
  }
  // 达到上限仍在变(几乎肯定循环引用),返回当前结果 + warn
  // 这里 console.warn,调用方(container.ts)会看到日志线索
  // eslint-disable-next-line no-console
  console.warn('[env-resolve] reached max iterations, possible circular ${VAR} reference');
  return current;
}

export function resolveEnvTemplates(
  env: Record<string, string>,
  cdsVars: Record<string, string>,
): Record<string, string> {
  const expandedVars = expandVarsToFixedPoint(cdsVars);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = singlePassResolve(value, expandedVars);
  }
  return result;
}

// ── Internal helpers ──

/**
 * 已知的"基础设施初始化脚本/配置"挂载目标前缀。挂到这些路径的相对路径
 * **不**应被判定为"应用源码挂载"(否则 mysql 这种带 init.sql 的 infra 会
 * 被误归类成 app)。Phase 6(2026-05-01)契约测试触发的真 bug 修复。
 */
const INIT_SCRIPT_TARGET_PREFIXES = [
  '/docker-entrypoint-initdb.d/',  // mysql / postgres / mongodb 标准初始化目录
  '/etc/',                          // 通用配置(redis.conf 等)
  '/usr/local/etc/',                // 通用配置变种
  '/init/',                         // 自定义 init 脚本约定路径
];

/**
 * 已知的"配置/初始化"文件扩展名。源路径以这些扩展名结尾的相对路径,
 * 一律不算"应用源码挂载"(它们是单文件配置/脚本,不是源码目录)。
 */
const CONFIG_FILE_EXT_RE = /\.(sql|conf|cnf|ini|json|ya?ml|env|sh|properties|xml|toml)$/i;

/**
 * Check if a service has any relative volume mounts (./xxx:/path) — indicates app service.
 *
 * Phase 6 fix(2026-05-01): 排除单文件 init 脚本/配置类挂载。
 * 真实场景:
 *   mysql 服务挂 ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
 *   旧逻辑:任意相对挂载 → 当 app → mysql 不被识别为 infra → CDS 部署炸
 *   新逻辑:排除 init script target + 排除以 .sql/.conf/.json 等结尾的源 → mysql 仍是 infra
 *
 * 判定剩下的"真"app 源码挂载:目录形式相对路径 + 目标不是 init/config 路径。
 */
function hasRelativeVolumeMount(volumes?: string[]): boolean {
  if (!volumes) return false;
  return volumes.some(isAppSourceMount);
}

/** 单个挂载条目是不是"应用源码"挂载(排除 init / 配置文件)。 */
function isAppSourceMount(v: string): boolean {
  const parts = v.split(':');
  const source = parts[0];
  const target = parts[1] || '';
  if (!source.startsWith('./') && source !== '.') return false;
  // 1. 目标路径是已知 init script 目录 → infra 初始化挂载,不算 app source
  if (INIT_SCRIPT_TARGET_PREFIXES.some(t => target.startsWith(t))) return false;
  // 2. 源路径以单文件配置扩展名结尾 → 单文件挂载,不算 app source
  if (CONFIG_FILE_EXT_RE.test(source)) return false;
  return true;
}

/** Find the first relative volume mount and return host/container paths.
 *  Phase 6 fix(2026-05-01):跳过 init 脚本/配置类挂载,只取真正的"源码"挂载。
 */
function findRelativeMount(volumes?: string[]): { hostPath: string; containerPath: string } | null {
  if (!volumes) return null;
  for (const v of volumes) {
    if (!isAppSourceMount(v)) continue;
    const parts = v.split(':');
    if (parts.length < 2) continue;
    const source = parts[0];
    // Normalize: ./prd-api → prd-api, . → .
    const hostPath = source === '.' ? '.' : source.replace(/^\.\//, '');
    return { hostPath, containerPath: parts[1] };
  }
  return null;
}

/** Extract non-relative named volume mounts as cache mounts */
function extractCacheMounts(volumes?: string[]): Array<{ hostPath: string; containerPath: string }> | undefined {
  if (!volumes) return undefined;
  const mounts: Array<{ hostPath: string; containerPath: string }> = [];
  for (const v of volumes) {
    const parts = v.split(':');
    if (parts.length >= 2) {
      const source = parts[0];
      // Skip relative mounts (source code) and absolute paths
      if (!source.startsWith('./') && source !== '.' && !source.startsWith('/')) {
        mounts.push({ hostPath: source, containerPath: parts[1] });
      }
    }
  }
  return mounts.length > 0 ? mounts : undefined;
}

/** Extract labels from compose labels field (supports both dict and array format) */
function extractLabels(labels?: Record<string, string> | string[]): Record<string, string> {
  if (!labels) return {};

  if (Array.isArray(labels)) {
    const result: Record<string, string> = {};
    for (const entry of labels) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx > 0) {
        result[entry.substring(0, eqIdx)] = entry.substring(eqIdx + 1);
      }
    }
    return result;
  }

  return { ...labels };
}

/** Extract depends_on service IDs from compose depends_on field */
function extractDependsOn(dependsOn?: Record<string, { condition?: string }> | string[]): string[] {
  if (!dependsOn) return [];

  if (Array.isArray(dependsOn)) {
    return dependsOn;
  }

  return Object.keys(dependsOn);
}

/** Extract command string from compose command field (supports string and array) */
function extractCommand(command?: string | string[]): string {
  if (!command) return '';

  if (Array.isArray(command)) {
    return command.join(' ');
  }

  return command;
}

/** Parse routing rules from x-cds-routing */
function parseRoutingRules(doc: ComposeFile): CdsComposeConfig['routingRules'] {
  const routingRules: CdsComposeConfig['routingRules'] = [];
  if (doc['x-cds-routing']) {
    for (const r of doc['x-cds-routing']) {
      routingRules.push({
        id: r.id,
        name: r.name || r.id,
        type: r.type || 'domain',
        match: r.match,
        branch: r.branch,
        priority: r.priority ?? 0,
        enabled: r.enabled ?? true,
      });
    }
  }
  return routingRules;
}

function extractContainerPort(ports?: Array<string | { target: number; published?: number }>): number | null {
  if (!ports || ports.length === 0) return null;

  for (const p of ports) {
    if (typeof p === 'string') {
      // Formats: "8080", "8080:8080", "127.0.0.1:8080:8080"
      const parts = p.split(':');
      // Container port is always the last number
      const containerPort = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(containerPort)) return containerPort;
    } else if (typeof p === 'object' && p.target) {
      return p.target;
    }
  }

  return null;
}

function extractVolumes(volumes?: string[]): InfraVolume[] {
  if (!volumes) return [];

  const result: InfraVolume[] = [];
  for (const v of volumes) {
    // Format: "name:/container/path[:ro]" or "/host/path:/container/path[:ro]" or "./rel:/container/path[:ro]"
    const parts = v.split(':');
    if (parts.length >= 2) {
      const source = parts[0];
      const containerPath = parts[1];
      const readOnly = parts[2] === 'ro' ? true : undefined;
      const type = (source.startsWith('/') || source.startsWith('.')) ? 'bind' : 'volume';
      result.push({ name: source, containerPath, type, readOnly });
    }
  }
  return result;
}

function extractEnv(environment?: Record<string, string> | string[]): Record<string, string> {
  if (!environment) return {};

  if (Array.isArray(environment)) {
    const result: Record<string, string> = {};
    for (const entry of environment) {
      const eqIdx = entry.indexOf('=');
      if (eqIdx > 0) {
        result[entry.substring(0, eqIdx)] = entry.substring(eqIdx + 1);
      }
    }
    return result;
  }

  return { ...environment };
}

function extractHealthCheck(hc?: ComposeServiceEntry['healthcheck']): InfraHealthCheck | undefined {
  if (!hc?.test) return undefined;

  let command: string;
  if (Array.isArray(hc.test)) {
    // ["CMD", "redis-cli", "ping"] or ["CMD-SHELL", "redis-cli ping"]
    if (hc.test[0] === 'CMD-SHELL') {
      command = hc.test.slice(1).join(' ');
    } else if (hc.test[0] === 'CMD') {
      command = hc.test.slice(1).join(' ');
    } else {
      command = hc.test.join(' ');
    }
  } else {
    command = hc.test;
  }

  let interval = 10;
  if (hc.interval) {
    // Parse "10s", "30s", "1m"
    const match = hc.interval.match(/^(\d+)(s|m)?$/);
    if (match) {
      interval = parseInt(match[1], 10);
      if (match[2] === 'm') interval *= 60;
    }
  }

  return {
    command,
    interval,
    retries: hc.retries || 3,
  };
}

function generateDisplayName(serviceId: string, image: string): string {
  // Extract image name and major version for a friendly name
  // e.g., "mongo:7" → "MongoDB 7", "redis:7-alpine" → "Redis 7"
  const knownNames: Record<string, string> = {
    mongo: 'MongoDB',
    mongodb: 'MongoDB',
    redis: 'Redis',
    postgres: 'PostgreSQL',
    postgresql: 'PostgreSQL',
    mysql: 'MySQL',
    mariadb: 'MariaDB',
    rabbitmq: 'RabbitMQ',
    elasticsearch: 'Elasticsearch',
    minio: 'MinIO',
    memcached: 'Memcached',
  };

  const imageName = image.split('/').pop()?.split(':')[0] || serviceId;
  const imageTag = image.split(':')[1] || '';
  const majorVersion = imageTag.match(/^(\d+)/)?.[1] || '';

  const displayName = knownNames[imageName.toLowerCase()] || imageName;
  return majorVersion ? `${displayName} ${majorVersion}` : displayName;
}
