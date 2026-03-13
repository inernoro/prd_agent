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
import type { InfraService, InfraVolume, InfraHealthCheck } from '../types.js';

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
    // Skip services without an image (they use build — these are app services)
    if (!entry.image) continue;

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
      entry.volumes = svc.volumes.map(v => `${v.name}:${v.containerPath}`);
      for (const v of svc.volumes) volumeNames.add(v.name);
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

  return volumes
    .map(v => {
      // Format: "name:/container/path" or "/host/path:/container/path"
      const parts = v.split(':');
      if (parts.length >= 2) {
        const source = parts[0];
        const containerPath = parts[1];
        // Only named volumes (no absolute paths)
        if (!source.startsWith('/') && !source.startsWith('.')) {
          return { name: source, containerPath };
        }
      }
      return null;
    })
    .filter((v): v is InfraVolume => v !== null);
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
