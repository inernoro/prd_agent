/**
 * Compose Parser — reads docker-compose.yml and extracts service definitions.
 *
 * Supports two formats:
 *
 * **v1 (legacy)**: Uses `x-cds-profiles` and `x-cds-inject` custom extensions.
 *
 * **v2 (standard compose)**: Zero custom extensions. Auto-detects app vs infra:
 *   - Services with relative volume mounts (`./xxx:/path`) → app services (BuildProfile)
 *   - Services without relative mounts → infra services
 *   - `depends_on` → startup ordering
 *   - `labels.cds.path-prefix` → proxy routing
 *   - App environment uses `${CDS_<SERVICE>_PORT}` for dynamic port injection
 *
 * Both formats produce the same internal types (CdsComposeConfig).
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { InfraService, InfraVolume, InfraHealthCheck, BuildProfile, RoutingRule } from '../types.js';

/** Parsed infrastructure service from a compose file */
export interface ComposeServiceDef {
  id: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  volumes: InfraVolume[];
  env: Record<string, string>;
  injectEnv: Record<string, string>;
  healthCheck?: InfraHealthCheck;
  /** v2 format flag — when true, CDS auto-generates CDS_<SERVICE>_PORT env vars */
  isV2Format?: boolean;
}

/** Raw compose YAML structure */
interface ComposeFile {
  services?: Record<string, ComposeServiceEntry>;
  volumes?: Record<string, unknown>;
  /** CDS extension (v1): project metadata */
  'x-cds-project'?: { name?: string; description?: string };
  /** CDS extension (v1): build profiles */
  'x-cds-profiles'?: Record<string, CdsProfileEntry>;
  /** CDS extension: shared environment variables (used in both v1 and v2) */
  'x-cds-env'?: Record<string, string>;
  /** CDS extension: routing rules (used in both v1 and v2) */
  'x-cds-routing'?: Array<{
    id: string;
    name?: string;
    type?: 'header' | 'domain' | 'pattern';
    match: string;
    branch: string;
    priority?: number;
    enabled?: boolean;
  }>;
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
  /** Standard compose: full command to run */
  command?: string | string[];
  /** Standard compose: working directory inside the container */
  working_dir?: string;
  /** Standard compose: service dependencies for startup ordering */
  depends_on?: Record<string, { condition?: string }> | string[];
  /** Standard compose: labels (used for cds.path-prefix in v2) */
  labels?: Record<string, string> | string[];
  /** Standard compose: entrypoint override */
  entrypoint?: string | string[];
  /** CDS extension (v1): env vars to inject into branch containers */
  'x-cds-inject'?: Record<string, string>;
  /** CDS extension (v1): display name for this service */
  'x-cds-name'?: string;
}

/** CDS profile entry in x-cds-profiles (v1 format) */
interface CdsProfileEntry {
  name?: string;
  dockerImage: string;
  workDir?: string;
  installCommand?: string;
  buildCommand?: string;
  runCommand: string;
  containerPort?: number;
  icon?: string;
  env?: Record<string, string>;
  cacheMounts?: Array<{ hostPath: string; containerPath: string }>;
  buildTimeout?: number;
  pathPrefixes?: string[];
}

/** Result of parsing a full CDS compose file (infra + profiles + env + routing) */
export interface CdsComposeConfig {
  project?: { name?: string; description?: string };
  buildProfiles: Array<CdsProfileEntry & { id: string; command?: string; containerWorkDir?: string; dependsOn?: string[] }>;
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
  /** Whether this config was parsed from v2 standard compose format */
  isV2Format?: boolean;
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

    // v2 detection: skip services with relative volume mounts (app services)
    if (hasRelativeVolumeMount(entry.volumes)) continue;

    const containerPort = extractContainerPort(entry.ports);
    if (!containerPort) continue; // No port = not a network service CDS should manage

    const parsed: ComposeServiceDef = {
      id: serviceId,
      name: entry['x-cds-name'] || generateDisplayName(serviceId, entry.image),
      dockerImage: entry.image,
      containerPort,
      volumes: extractVolumes(entry.volumes),
      env: extractEnv(entry.environment),
      injectEnv: entry['x-cds-inject'] || {},
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
      name: entry['x-cds-name'] || generateDisplayName(serviceId, entry.image),
      dockerImage: entry.image,
      containerPort,
      volumes: extractVolumes(entry.volumes),
      env: extractEnv(entry.environment),
      injectEnv: entry['x-cds-inject'] || {},
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

    // v1 compat: CDS inject extension (only for non-v2 services)
    if (!svc.isV2Format && Object.keys(svc.injectEnv).length > 0) {
      entry['x-cds-inject'] = { ...svc.injectEnv };
    }

    // CDS name extension (only if different from auto-generated)
    const autoName = generateDisplayName(svc.id, svc.dockerImage);
    if (svc.name !== autoName) {
      entry['x-cds-name'] = svc.name;
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
 * Parse a full CDS compose YAML — supports both v1 (x-cds-profiles) and v2 (standard compose).
 *
 * Detection order:
 * 1. If `x-cds-profiles` exists → v1 format
 * 2. If services have relative volume mounts (./xxx:/path) → v2 format (auto-detect)
 * 3. If only `x-cds-env` or `x-cds-routing` → v1 format (infra-only)
 *
 * Returns null if the YAML can't be parsed as either format.
 */
export function parseCdsCompose(yamlString: string): CdsComposeConfig | null {
  const doc = yaml.load(yamlString) as ComposeFile | null;
  if (!doc) return null;

  // Check for v1 extensions
  const hasCdsProfiles = !!doc['x-cds-profiles'];
  const hasCdsExtensions =
    hasCdsProfiles || doc['x-cds-env'] || doc['x-cds-project'] || doc['x-cds-routing'];

  // Check for v2 signals: any service with a relative volume mount
  const hasV2AppServices = doc.services
    ? Object.values(doc.services).some(entry => hasRelativeVolumeMount(entry.volumes))
    : false;

  // If no CDS extensions AND no v2 app services, not a CDS compose file
  if (!hasCdsExtensions && !hasV2AppServices) return null;

  // Use v2 parsing if we have app services with relative mounts and no x-cds-profiles
  if (hasV2AppServices && !hasCdsProfiles) {
    return parseV2Compose(doc);
  }

  // v1 parsing (original behavior)
  return parseV1Compose(doc);
}

/**
 * v1 format parser — uses x-cds-profiles and x-cds-inject extensions.
 */
function parseV1Compose(doc: ComposeFile): CdsComposeConfig {
  // Extract build profiles from x-cds-profiles
  const buildProfiles: CdsComposeConfig['buildProfiles'] = [];
  if (doc['x-cds-profiles']) {
    for (const [id, entry] of Object.entries(doc['x-cds-profiles'])) {
      buildProfiles.push({
        id,
        name: entry.name || id,
        dockerImage: entry.dockerImage,
        workDir: entry.workDir || '.',
        installCommand: entry.installCommand,
        buildCommand: entry.buildCommand,
        runCommand: entry.runCommand,
        containerPort: entry.containerPort || 8080,
        icon: entry.icon,
        env: entry.env,
        cacheMounts: entry.cacheMounts,
        buildTimeout: entry.buildTimeout,
        pathPrefixes: entry.pathPrefixes,
      });
    }
  }

  // Extract env vars from x-cds-env
  const envVars: Record<string, string> = doc['x-cds-env'] ? { ...doc['x-cds-env'] } : {};

  // Extract routing rules from x-cds-routing
  const routingRules = parseRoutingRules(doc);

  // Extract infra services from standard services section
  const infraServices: ComposeServiceDef[] = [];
  if (doc.services) {
    for (const [serviceId, entry] of Object.entries(doc.services)) {
      if (entry.build || !entry.image) continue;
      const containerPort = extractContainerPort(entry.ports);
      if (!containerPort) continue;
      infraServices.push({
        id: serviceId,
        name: entry['x-cds-name'] || generateDisplayName(serviceId, entry.image),
        dockerImage: entry.image,
        containerPort,
        volumes: extractVolumes(entry.volumes),
        env: extractEnv(entry.environment),
        injectEnv: entry['x-cds-inject'] || {},
        healthCheck: extractHealthCheck(entry.healthcheck),
      });
    }
  }

  return {
    project: doc['x-cds-project'],
    buildProfiles,
    envVars,
    infraServices,
    routingRules,
  };
}

/**
 * v2 format parser — zero custom extensions, standard compose auto-detection.
 *
 * Classification rules:
 * - Service with relative volume mount (./xxx:/path) → app service (BuildProfile)
 * - Service without relative mount → infra service
 * - `depends_on` → startup ordering
 * - `labels.cds.path-prefix` → proxy routing
 * - App `environment` may use `${CDS_<SERVICE>_PORT}` for dynamic port injection
 */
function parseV2Compose(doc: ComposeFile): CdsComposeConfig {
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

        buildProfiles.push({
          id: serviceId,
          name: serviceId,
          dockerImage: entry.image,
          workDir: relMount?.hostPath || '.',
          containerWorkDir: entry.working_dir || '/app',
          command: command || undefined,
          runCommand: command || '',  // v1 compat fallback
          containerPort,
          env: extractEnv(entry.environment),
          pathPrefixes: pathPrefix ? pathPrefix.split(',').map(s => s.trim()) : undefined,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          // Extract non-relative volume mounts as cache mounts
          cacheMounts: extractCacheMounts(entry.volumes),
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
          injectEnv: {},  // v2: no injectEnv, uses CDS_<SERVICE>_PORT pattern
          healthCheck: extractHealthCheck(entry.healthcheck),
          isV2Format: true,
        });
      }
    }
  }

  // Extract optional CDS extensions (still supported in v2 for routing/env)
  const envVars: Record<string, string> = doc['x-cds-env'] ? { ...doc['x-cds-env'] } : {};
  const routingRules = parseRoutingRules(doc);

  return {
    project: doc['x-cds-project'],
    buildProfiles,
    envVars,
    infraServices,
    routingRules,
    isV2Format: true,
  };
}

/**
 * Export full CDS config as a single compose YAML.
 *
 * If any profile has `command` set (v2 format), exports as standard compose.
 * Otherwise, falls back to v1 format with x-cds-* extensions.
 */
export function toCdsCompose(
  profiles: BuildProfile[],
  envVars: Record<string, string>,
  infraServices: InfraService[],
  routingRules: RoutingRule[],
): string {
  // Detect if any profiles use v2 format
  const hasV2Profiles = profiles.some(p => p.command);

  if (hasV2Profiles) {
    return toCdsComposeV2(profiles, envVars, infraServices, routingRules);
  }

  return toCdsComposeV1(profiles, envVars, infraServices, routingRules);
}

/**
 * Export as v2 standard compose format — zero custom extensions on services.
 * App services are standard compose entries with relative volume mounts.
 * Infra services are standard compose entries.
 */
function toCdsComposeV2(
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

    // labels (path prefix)
    if (p.pathPrefixes && p.pathPrefixes.length > 0) {
      entry.labels = { 'cds.path-prefix': p.pathPrefixes.join(',') };
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

  // Optional x-cds-env (still useful for global shared env vars)
  if (Object.keys(envVars).length > 0) {
    doc['x-cds-env'] = { ...envVars };
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
 * Export as v1 format with x-cds-* extensions (legacy).
 */
function toCdsComposeV1(
  profiles: BuildProfile[],
  envVars: Record<string, string>,
  infraServices: InfraService[],
  routingRules: RoutingRule[],
): string {
  const doc: Record<string, unknown> = {};

  // x-cds-project
  doc['x-cds-project'] = { name: '', description: '' };

  // x-cds-profiles
  if (profiles.length > 0) {
    const profilesMap: Record<string, Record<string, unknown>> = {};
    for (const p of profiles) {
      const entry: Record<string, unknown> = {
        name: p.name,
        dockerImage: p.dockerImage,
        workDir: p.workDir,
        runCommand: p.runCommand || p.command || '',
        containerPort: p.containerPort,
      };
      if (p.installCommand) entry.installCommand = p.installCommand;
      if (p.buildCommand) entry.buildCommand = p.buildCommand;
      if (p.icon) entry.icon = p.icon;
      if (p.env && Object.keys(p.env).length > 0) entry.env = p.env;
      if (p.cacheMounts && p.cacheMounts.length > 0) entry.cacheMounts = p.cacheMounts;
      if (p.buildTimeout) entry.buildTimeout = p.buildTimeout;
      if (p.pathPrefixes && p.pathPrefixes.length > 0) entry.pathPrefixes = p.pathPrefixes;
      profilesMap[p.id] = entry;
    }
    doc['x-cds-profiles'] = profilesMap;
  }

  // x-cds-env
  if (Object.keys(envVars).length > 0) {
    doc['x-cds-env'] = { ...envVars };
  }

  // x-cds-routing
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

  // Standard services section (infra)
  const servicesMap: Record<string, unknown> = {};
  const volumeNames = new Set<string>();

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

    if (Object.keys(svc.injectEnv).length > 0) {
      entry['x-cds-inject'] = { ...svc.injectEnv };
    }

    const autoName = generateDisplayName(svc.id, svc.dockerImage);
    if (svc.name !== autoName) {
      entry['x-cds-name'] = svc.name;
    }

    servicesMap[svc.id] = entry;
  }

  if (Object.keys(servicesMap).length > 0) {
    doc.services = servicesMap;
  }

  if (volumeNames.size > 0) {
    const volumes: Record<string, null> = {};
    for (const name of volumeNames) volumes[name] = null;
    doc.volumes = volumes;
  }

  return yaml.dump(doc, { lineWidth: 120, noRefs: true, sortKeys: false });
}

/**
 * Resolve ${CDS_*} env var templates in a value string.
 * Supports ${VAR} and ${VAR:-default} syntax.
 */
export function resolveEnvTemplates(
  env: Record<string, string>,
  cdsVars: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_match, name, defaultVal) => {
      return cdsVars[name] ?? defaultVal ?? '';
    });
  }
  return result;
}

// ── Internal helpers ──

/** Check if a service has any relative volume mounts (./xxx:/path) — indicates app service */
function hasRelativeVolumeMount(volumes?: string[]): boolean {
  if (!volumes) return false;
  return volumes.some(v => {
    const source = v.split(':')[0];
    return source.startsWith('./') || source === '.';
  });
}

/** Find the first relative volume mount and return host/container paths */
function findRelativeMount(volumes?: string[]): { hostPath: string; containerPath: string } | null {
  if (!volumes) return null;
  for (const v of volumes) {
    const parts = v.split(':');
    if (parts.length >= 2) {
      const source = parts[0];
      if (source.startsWith('./') || source === '.') {
        // Normalize: ./prd-api → prd-api, . → .
        const hostPath = source === '.' ? '.' : source.replace(/^\.\//, '');
        return { hostPath, containerPath: parts[1] };
      }
    }
  }
  return null;
}

/** Extract non-relative named volume mounts as cache mounts (for v2 profiles) */
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

/** Parse routing rules from x-cds-routing (shared between v1 and v2) */
function parseRoutingRules(doc: ComposeFile): CdsComposeConfig['routingRules'] {
  const routingRules: CdsComposeConfig['routingRules'] = [];
  if (doc['x-cds-routing']) {
    for (const r of doc['x-cds-routing']) {
      routingRules.push({
        id: r.id,
        name: r.name || r.id,
        type: r.type || 'header',
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
