/**
 * Compose Parser — reads docker-compose.yml and extracts infrastructure service definitions.
 *
 * Design: CDS reads a standard docker-compose file (or a CDS-specific compose file)
 * to define infrastructure services. This replaces the old hardcoded INFRA_PRESETS.
 *
 * CDS extension: `x-cds-inject` on a service defines environment variables to inject
 * into all branch containers (supports {{host}} and {{port}} placeholders).
 *
 * The compose file can also be used directly with `docker compose` — the `x-` prefix
 * fields are ignored by Docker.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { InfraService, InfraVolume, InfraHealthCheck, BuildProfile, RoutingRule } from '../types.js';

/** Parsed service from a compose file */
export interface ComposeServiceDef {
  id: string;
  name: string;
  dockerImage: string;
  containerPort: number;
  volumes: InfraVolume[];
  env: Record<string, string>;
  injectEnv: Record<string, string>;
  healthCheck?: InfraHealthCheck;
}

/** Raw compose YAML structure (subset we care about) */
interface ComposeFile {
  services?: Record<string, ComposeServiceEntry>;
  volumes?: Record<string, unknown>;
  /** CDS extension: project metadata */
  'x-cds-project'?: { name?: string; description?: string };
  /** CDS extension: build profiles */
  'x-cds-profiles'?: Record<string, CdsProfileEntry>;
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
  /** CDS extension: env vars to inject into branch containers */
  'x-cds-inject'?: Record<string, string>;
  /** CDS extension: display name for this service */
  'x-cds-name'?: string;
}

/** CDS profile entry in x-cds-profiles */
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
  buildProfiles: Array<CdsProfileEntry & { id: string }>;
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
 * Only services with an `image` field are extracted (build-based services are
 * considered application services and skipped).
 *
 * If no `x-cds-inject` is found, the service is still included but without
 * auto-injected env vars (the user can add them later via the UI).
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

    // CDS inject extension
    if (Object.keys(svc.injectEnv).length > 0) {
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
 * Parse a full CDS compose YAML — extracts everything: profiles, env, infra, routing.
 *
 * This is the primary import format. A single compose YAML file contains:
 * - `x-cds-project`: project metadata
 * - `x-cds-profiles`: build profile definitions (how to build/run each service)
 * - `x-cds-env`: shared environment variables
 * - `x-cds-routing`: routing rules
 * - `services`: infrastructure services (standard compose format with x-cds-inject)
 *
 * Returns null if the YAML doesn't contain any x-cds-* extensions (not a CDS compose file).
 */
export function parseCdsCompose(yamlString: string): CdsComposeConfig | null {
  const doc = yaml.load(yamlString) as ComposeFile | null;
  if (!doc) return null;

  // Detect: must have at least one x-cds-* extension to be considered a CDS compose file
  const hasCdsExtensions =
    doc['x-cds-profiles'] || doc['x-cds-env'] || doc['x-cds-project'] || doc['x-cds-routing'];
  if (!hasCdsExtensions) return null;

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

  // Extract infra services from standard services section (reuse existing logic)
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
 * Export full CDS config as a single compose YAML with x-cds-* extensions.
 *
 * This produces a file that is both:
 * - A valid docker-compose file (services section works with `docker compose up`)
 * - A complete CDS config file (x-cds-* extensions contain all CDS settings)
 */
export function toCdsCompose(
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
        runCommand: p.runCommand,
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

// ── Internal helpers ──

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
