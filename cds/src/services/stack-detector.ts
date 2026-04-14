/**
 * Stack detector — P4 Part 18 (G10).
 *
 * Scans a directory (typically a worktree) for known tech-stack
 * signals and returns a set of reasonable defaults for the
 * BuildProfile form: dockerImage, install/build/run commands,
 * container port, etc. This is a "90% case" heuristic, not a
 * perfect replacement for nixpacks — the goal is to save users
 * from typing four fields every time they add a service.
 *
 * Detection priority (highest wins):
 *   1. Dockerfile      — special case, marked as "manual" stack
 *                        since CDS doesn't build custom images yet
 *   2. package.json    — Node.js (detects pnpm/yarn/npm from
 *                        packageManager field + lockfiles)
 *   3. go.mod          — Go
 *   4. Cargo.toml      — Rust
 *   5. pyproject.toml  — Python (poetry / pip)
 *   6. requirements.txt — Python
 *   7. pom.xml         — Java (Maven)
 *   8. Gemfile         — Ruby
 *   9. composer.json   — PHP
 *
 * Pure function — takes a path, returns the detection result. No
 * network, no shell. Safe to call from any route handler.
 */

import fs from 'node:fs';
import path from 'node:path';

export type DetectedStack =
  | 'dockerfile'
  | 'nodejs'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  | 'php'
  | 'unknown';

export interface StackDetection {
  stack: DetectedStack;
  confidence: number; // 0..1 (1 = high confidence match)
  dockerImage: string;
  installCommand?: string;
  buildCommand?: string;
  runCommand: string;
  workDir: string;
  containerPort?: number;
  /** Files we found that contributed to the detection. */
  signals: string[];
  /** One-line human-readable summary for the UI. */
  summary: string;
  /**
   * Set to true when the detection needs user intervention (e.g.
   * we found a Dockerfile but CDS doesn't build custom images).
   */
  manualSetupRequired?: boolean;
}

/** Return an "unknown" detection that callers can treat as fallback. */
function unknownDetection(searchPath: string): StackDetection {
  return {
    stack: 'unknown',
    confidence: 0,
    dockerImage: 'ubuntu:24.04',
    runCommand: 'echo "未识别出栈类型，请手动填写运行命令"',
    workDir: '.',
    signals: [],
    summary: `未在 ${searchPath} 识别出已知栈（package.json / go.mod / Cargo.toml / requirements.txt / pyproject.toml / pom.xml / Gemfile / composer.json / Dockerfile）`,
  };
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Node.js detector — reads package.json, infers the package
 * manager from lockfiles + packageManager field, and pulls
 * install/build/start scripts when present.
 */
function detectNodejs(searchPath: string): StackDetection | null {
  const pkgPath = path.join(searchPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = readJson(pkgPath);
  if (!pkg) return null;

  const signals = ['package.json'];

  // ── Package manager (pnpm > yarn > npm by lockfile preference) ──
  let pm: 'pnpm' | 'yarn' | 'npm' = 'npm';
  const pkgManagerField = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  if (pkgManagerField.startsWith('pnpm')) {
    pm = 'pnpm';
  } else if (pkgManagerField.startsWith('yarn')) {
    pm = 'yarn';
  } else if (fs.existsSync(path.join(searchPath, 'pnpm-lock.yaml'))) {
    pm = 'pnpm';
    signals.push('pnpm-lock.yaml');
  } else if (fs.existsSync(path.join(searchPath, 'yarn.lock'))) {
    pm = 'yarn';
    signals.push('yarn.lock');
  } else if (fs.existsSync(path.join(searchPath, 'package-lock.json'))) {
    pm = 'npm';
    signals.push('package-lock.json');
  }

  // ── Docker image from engines.node ──
  const engines = pkg.engines as Record<string, string> | undefined;
  const nodeVersion = engines?.node || '20';
  const majorMatch = nodeVersion.match(/(\d+)/);
  const major = majorMatch ? majorMatch[1] : '20';
  // pnpm+corepack is easier on the node:slim image; explicit pick.
  const dockerImage = `node:${major}-slim`;

  // ── Commands ──
  const installCommand = {
    pnpm: 'corepack enable && pnpm install --frozen-lockfile',
    yarn: 'corepack enable && yarn install --frozen-lockfile',
    npm: 'npm ci',
  }[pm];

  const scripts = (pkg.scripts || {}) as Record<string, string>;
  const hasBuild = typeof scripts.build === 'string' && scripts.build.trim().length > 0;
  const hasStart = typeof scripts.start === 'string' && scripts.start.trim().length > 0;
  const hasDev = typeof scripts.dev === 'string' && scripts.dev.trim().length > 0;

  const buildCommand = hasBuild ? `${pm} run build` : undefined;
  const runCommand = hasStart
    ? `${pm} start`
    : hasDev
      ? `${pm} run dev`
      : 'node index.js';

  // ── Port detection: heuristic look in package.json / common files ──
  const containerPort = detectPortFromPackageJson(pkg) ?? 3000;

  return {
    stack: 'nodejs',
    confidence: 0.95,
    dockerImage,
    installCommand,
    buildCommand,
    runCommand,
    workDir: '.',
    containerPort,
    signals,
    summary: `Node.js ${major}（${pm}${hasStart ? ' · 有 start 脚本' : hasDev ? ' · 有 dev 脚本' : ' · 无 start/dev 脚本'}${hasBuild ? ' · 有 build 脚本' : ''}）`,
  };
}

/** Sniff container port from common package.json fields. */
function detectPortFromPackageJson(pkg: Record<string, unknown>): number | undefined {
  // Some Next.js / Nuxt projects expose `"cds": { "port": 3000 }` etc.
  const cdsHint = (pkg.cds as Record<string, unknown> | undefined)?.port;
  if (typeof cdsHint === 'number') return cdsHint;
  // Scripts like "dev": "next dev -p 3000" — grab the -p/--port arg
  const scripts = (pkg.scripts || {}) as Record<string, string>;
  for (const val of Object.values(scripts)) {
    const m = /(?:-p|--port)[= ](\d{2,5})/.exec(val);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function detectDockerfile(searchPath: string): StackDetection | null {
  if (!fs.existsSync(path.join(searchPath, 'Dockerfile'))) return null;
  return {
    stack: 'dockerfile',
    confidence: 0.8,
    dockerImage: 'ubuntu:24.04', // placeholder — user should replace with their built image
    runCommand: '/app/start.sh',
    workDir: '.',
    containerPort: 8080,
    signals: ['Dockerfile'],
    summary: '检测到 Dockerfile — CDS 当前不支持自动构建自定义镜像，请先手动 docker build 后在这里填入已构建的镜像名',
    manualSetupRequired: true,
  };
}

function detectGo(searchPath: string): StackDetection | null {
  const goModPath = path.join(searchPath, 'go.mod');
  if (!fs.existsSync(goModPath)) return null;
  const goMod = readText(goModPath) || '';
  const match = goMod.match(/^go\s+(\d+\.\d+)/m);
  const goVersion = match ? match[1] : '1.22';
  return {
    stack: 'go',
    confidence: 0.95,
    dockerImage: `golang:${goVersion}-alpine`,
    installCommand: 'go mod download',
    buildCommand: 'go build -o app .',
    runCommand: './app',
    workDir: '.',
    containerPort: 8080,
    signals: ['go.mod'],
    summary: `Go ${goVersion}`,
  };
}

function detectRust(searchPath: string): StackDetection | null {
  const cargoPath = path.join(searchPath, 'Cargo.toml');
  if (!fs.existsSync(cargoPath)) return null;
  const cargo = readText(cargoPath) || '';
  const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
  const binName = nameMatch ? nameMatch[1] : 'app';
  return {
    stack: 'rust',
    confidence: 0.95,
    dockerImage: 'rust:1.77-slim',
    installCommand: 'cargo fetch',
    buildCommand: 'cargo build --release',
    runCommand: `./target/release/${binName}`,
    workDir: '.',
    containerPort: 8080,
    signals: ['Cargo.toml'],
    summary: `Rust (${binName})`,
  };
}

function detectPython(searchPath: string): StackDetection | null {
  const hasPyproject = fs.existsSync(path.join(searchPath, 'pyproject.toml'));
  const hasRequirements = fs.existsSync(path.join(searchPath, 'requirements.txt'));
  const hasSetupPy = fs.existsSync(path.join(searchPath, 'setup.py'));
  if (!hasPyproject && !hasRequirements && !hasSetupPy) return null;

  const signals: string[] = [];
  if (hasPyproject) signals.push('pyproject.toml');
  if (hasRequirements) signals.push('requirements.txt');
  if (hasSetupPy) signals.push('setup.py');

  // Poetry vs pip detection
  const pyproject = hasPyproject ? readText(path.join(searchPath, 'pyproject.toml')) || '' : '';
  const isPoetry = pyproject.includes('[tool.poetry]');

  const installCommand = isPoetry
    ? 'pip install poetry && poetry install --no-root'
    : hasRequirements
      ? 'pip install -r requirements.txt'
      : 'pip install -e .';

  // Run heuristic: common entry points
  let runCommand = 'python main.py';
  if (fs.existsSync(path.join(searchPath, 'main.py'))) runCommand = 'python main.py';
  else if (fs.existsSync(path.join(searchPath, 'app.py'))) runCommand = 'python app.py';
  else if (fs.existsSync(path.join(searchPath, 'server.py'))) runCommand = 'python server.py';
  else if (fs.existsSync(path.join(searchPath, 'manage.py'))) runCommand = 'python manage.py runserver 0.0.0.0:8000';

  return {
    stack: 'python',
    confidence: 0.9,
    dockerImage: 'python:3.12-slim',
    installCommand,
    runCommand,
    workDir: '.',
    containerPort: 8000,
    signals,
    summary: `Python 3.12 (${isPoetry ? 'poetry' : 'pip'})`,
  };
}

function detectJava(searchPath: string): StackDetection | null {
  const hasPom = fs.existsSync(path.join(searchPath, 'pom.xml'));
  const hasGradle = fs.existsSync(path.join(searchPath, 'build.gradle'))
    || fs.existsSync(path.join(searchPath, 'build.gradle.kts'));
  if (!hasPom && !hasGradle) return null;

  const signals: string[] = [];
  if (hasPom) signals.push('pom.xml');
  if (hasGradle) signals.push('build.gradle');

  const isMaven = hasPom;
  const installCommand = isMaven
    ? 'mvn dependency:resolve'
    : './gradlew dependencies';
  const buildCommand = isMaven
    ? 'mvn package -DskipTests'
    : './gradlew build -x test';
  const runCommand = isMaven
    ? 'java -jar target/*.jar'
    : 'java -jar build/libs/*.jar';

  return {
    stack: 'java',
    confidence: 0.85,
    dockerImage: 'eclipse-temurin:21-jdk',
    installCommand,
    buildCommand,
    runCommand,
    workDir: '.',
    containerPort: 8080,
    signals,
    summary: `Java (${isMaven ? 'Maven' : 'Gradle'})`,
  };
}

function detectRuby(searchPath: string): StackDetection | null {
  if (!fs.existsSync(path.join(searchPath, 'Gemfile'))) return null;
  return {
    stack: 'ruby',
    confidence: 0.85,
    dockerImage: 'ruby:3.3-slim',
    installCommand: 'bundle install',
    runCommand: 'bundle exec rails server -b 0.0.0.0',
    workDir: '.',
    containerPort: 3000,
    signals: ['Gemfile'],
    summary: 'Ruby (Bundler)',
  };
}

function detectPhp(searchPath: string): StackDetection | null {
  if (!fs.existsSync(path.join(searchPath, 'composer.json'))) return null;
  return {
    stack: 'php',
    confidence: 0.85,
    dockerImage: 'php:8.3-cli',
    installCommand: 'composer install --no-interaction',
    runCommand: 'php -S 0.0.0.0:8080 -t public',
    workDir: '.',
    containerPort: 8080,
    signals: ['composer.json'],
    summary: 'PHP (Composer)',
  };
}

/**
 * Run every detector in priority order and return the first match.
 * Falls back to an "unknown" marker if nothing matches so the
 * caller can surface a helpful message.
 */
export function detectStack(searchPath: string): StackDetection {
  if (!fs.existsSync(searchPath)) {
    return {
      stack: 'unknown',
      confidence: 0,
      dockerImage: 'ubuntu:24.04',
      runCommand: '',
      workDir: '.',
      signals: [],
      summary: `路径不存在: ${searchPath}`,
    };
  }
  const detectors = [
    detectDockerfile,
    detectNodejs,
    detectGo,
    detectRust,
    detectPython,
    detectJava,
    detectRuby,
    detectPhp,
  ];
  for (const d of detectors) {
    const result = d(searchPath);
    if (result) return result;
  }
  return unknownDetection(searchPath);
}
