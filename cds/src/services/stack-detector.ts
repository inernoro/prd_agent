/**
 * Stack detector — P4 Part 18 (G10) + FU-03 framework layer.
 *
 * Scans a directory (typically a worktree) for known tech-stack
 * signals and returns a set of reasonable defaults for the
 * BuildProfile form: dockerImage, install/build/run commands,
 * container port, etc. This is a "90% case" heuristic, not a
 * perfect replacement for nixpacks — the goal is to save users
 * from typing four fields every time they add a service.
 *
 * Two layers of detection:
 *   1. Base stack — which manifest file exists (package.json /
 *      go.mod / Cargo.toml / requirements.txt / …). Resolves the
 *      broad ecosystem (nodejs / python / ruby / go / rust / java /
 *      php / dockerfile).
 *   2. Framework (FU-03) — for nodejs / python / ruby, peek into
 *      the manifest's declared dependencies and pick a more
 *      precise default (Next.js / NestJS / Express / Remix /
 *      Vite+React / Django / FastAPI / Flask / Rails). When a
 *      framework is identified we adjust `dockerImage` and
 *      surface `suggestedRunCommand` / `suggestedBuildCommand` so
 *      the BuildProfile form lands on a near-correct answer
 *      without the user having to retype anything.
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

/**
 * Framework sub-discriminator for detected stacks (FU-03).
 *
 * This is a best-effort refinement: a base stack like `nodejs`
 * covers the ecosystem, `framework` narrows it to the specific
 * runtime we should spin up. When no framework is identified we
 * leave this field unset so callers can fall back to the base
 * stack defaults.
 */
export type DetectedFramework =
  | 'nextjs'
  | 'nestjs'
  | 'express'
  | 'remix'
  | 'vite-react'
  | 'django'
  | 'fastapi'
  | 'flask'
  | 'rails';

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
  /**
   * Framework sub-discriminator (FU-03) — present only when we
   * positively identified a known framework from manifest deps.
   * Existing callers that only read `stack` + `dockerImage` keep
   * working; newer callers can render a more precise label.
   */
  framework?: DetectedFramework;
  /**
   * Framework-specific start command suggestion (FU-03). When
   * present this overrides the default `runCommand` that was
   * inferred from scripts.start / scripts.dev. The base
   * `runCommand` field is always filled in too so legacy callers
   * don't break.
   */
  suggestedRunCommand?: string;
  /**
   * Framework-specific build command suggestion (FU-03). Used by
   * static-site frameworks (e.g. Vite+React) and SSR frameworks
   * (e.g. Next.js) that need a build step distinct from install.
   */
  suggestedBuildCommand?: string;
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

type NodePackageManager = 'pnpm' | 'yarn' | 'npm';

function detectNodePackageManager(
  searchPath: string,
  pkg: Record<string, unknown>,
  signals?: string[],
): NodePackageManager {
  const pkgManagerField = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  if (pkgManagerField.startsWith('pnpm')) return 'pnpm';
  if (pkgManagerField.startsWith('yarn')) return 'yarn';
  if (fs.existsSync(path.join(searchPath, 'pnpm-lock.yaml'))) {
    signals?.push('pnpm-lock.yaml');
    return 'pnpm';
  }
  if (fs.existsSync(path.join(searchPath, 'yarn.lock'))) {
    signals?.push('yarn.lock');
    return 'yarn';
  }
  if (fs.existsSync(path.join(searchPath, 'package-lock.json'))) {
    signals?.push('package-lock.json');
    return 'npm';
  }
  return 'npm';
}

function nodeRunScript(pm: NodePackageManager, script: string): string {
  if (pm === 'yarn') return `yarn ${script}`;
  if (script === 'start') return `${pm} start`;
  return `${pm} run ${script}`;
}

function nodePackageExec(pm: NodePackageManager, pkg: string, args: string): string {
  if (pm === 'pnpm') return `pnpm dlx ${pkg} ${args}`;
  if (pm === 'yarn') return `yarn dlx ${pkg} ${args}`;
  return `npx --yes ${pkg} ${args}`;
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
  const pm = detectNodePackageManager(searchPath, pkg, signals);

  // ── Docker image from engines.node ──
  const engines = pkg.engines as Record<string, string> | undefined;
  const nodeVersion = engines?.node || '20';
  const majorMatch = nodeVersion.match(/(\d+)/);
  const major = majorMatch ? majorMatch[1] : '20';
  // pnpm+corepack is easier on the node:slim image; explicit pick.
  const dockerImage = `node:${major}-slim`;

  // ── Commands ──
  const hasPnpmLock = fs.existsSync(path.join(searchPath, 'pnpm-lock.yaml'));
  const hasYarnLock = fs.existsSync(path.join(searchPath, 'yarn.lock'));
  const hasNpmLock = fs.existsSync(path.join(searchPath, 'package-lock.json'));
  const installCommand = {
    pnpm: `corepack enable && pnpm install${hasPnpmLock ? ' --frozen-lockfile' : ''}`,
    yarn: `corepack enable && yarn install${hasYarnLock ? ' --frozen-lockfile' : ''}`,
    npm: hasNpmLock ? 'npm ci' : 'npm install',
  }[pm];

  const scripts = (pkg.scripts || {}) as Record<string, string>;
  const hasBuild = typeof scripts.build === 'string' && scripts.build.trim().length > 0;
  const hasStart = typeof scripts.start === 'string' && scripts.start.trim().length > 0;
  const hasDev = typeof scripts.dev === 'string' && scripts.dev.trim().length > 0;

  const buildCommand = hasBuild ? nodeRunScript(pm, 'build') : undefined;
  const runCommand = hasStart
    ? nodeRunScript(pm, 'start')
    : hasDev
      ? nodeRunScript(pm, 'dev')
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

// ────────────────────────────────────────────────────────────────
// Framework detection layer (FU-03)
// ────────────────────────────────────────────────────────────────

/**
 * Result of framework sniffing. All fields except `framework`
 * are overrides that get merged into the base-stack detection.
 */
interface FrameworkDetection {
  framework: DetectedFramework;
  dockerImage?: string;
  suggestedRunCommand?: string;
  suggestedBuildCommand?: string;
  /** Appended to base signals so the UI shows how we decided. */
  signals?: string[];
  /** Replaces the base summary when present. */
  summary?: string;
  /** Framework-specific container port hint. */
  containerPort?: number;
}

/**
 * Collect every declared dep from a package.json into a single
 * lowercase Set. We look at `dependencies`, `devDependencies`, and
 * `peerDependencies` — Next.js projects sometimes pin `next` as a
 * devDep (monorepo templates) and a library project may only have
 * the signal dep as a peer, so a union is safest.
 */
function collectNodeDeps(pkg: Record<string, unknown>): Set<string> {
  const bag = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const map = pkg[field] as Record<string, unknown> | undefined;
    if (map && typeof map === 'object') {
      for (const name of Object.keys(map)) {
        bag.add(name.toLowerCase());
      }
    }
  }
  return bag;
}

/**
 * Node.js framework detector. Reads package.json deps and picks
 * the first matching framework. Ordering matters: NestJS apps
 * often also have `express` in deps (Nest is built on it), so we
 * check Nest before Express.
 */
function detectNodejsFramework(
  searchPath: string,
  pkg: Record<string, unknown>,
): FrameworkDetection | null {
  const deps = collectNodeDeps(pkg);
  const pm = detectNodePackageManager(searchPath, pkg);
  const nodeImage = 'node:20-alpine';
  const buildCmd = nodeRunScript(pm, 'build');
  const startCmd = nodeRunScript(pm, 'start');

  // 1. Next.js — either declared dep or an explicit next.config.*
  const hasNextDep = deps.has('next');
  const hasNextConfig = ['next.config.js', 'next.config.mjs', 'next.config.ts']
    .some((f) => fs.existsSync(path.join(searchPath, f)));
  if (hasNextDep || hasNextConfig) {
    return {
      framework: 'nextjs',
      dockerImage: nodeImage,
      suggestedBuildCommand: buildCmd,
      suggestedRunCommand: `${buildCmd} && ${startCmd}`,
      signals: hasNextConfig ? ['next.config'] : ['deps:next'],
      summary: 'Next.js (Node.js)',
      containerPort: 3000,
    };
  }

  // 2. NestJS — @nestjs/core is the canonical marker
  if (deps.has('@nestjs/core')) {
    return {
      framework: 'nestjs',
      dockerImage: nodeImage,
      suggestedBuildCommand: buildCmd,
      suggestedRunCommand: nodeRunScript(pm, 'start:prod'),
      signals: ['deps:@nestjs/core'],
      summary: 'NestJS (Node.js)',
      containerPort: 3000,
    };
  }

  // 3. Remix — either `remix` classic or any `@remix-run/*` pkg
  const hasRemix = deps.has('remix')
    || Array.from(deps).some((d) => d.startsWith('@remix-run/'));
  if (hasRemix) {
    return {
      framework: 'remix',
      dockerImage: nodeImage,
      suggestedBuildCommand: buildCmd,
      suggestedRunCommand: startCmd,
      signals: ['deps:remix'],
      summary: 'Remix (Node.js)',
      containerPort: 3000,
    };
  }

  // 4. Vite + React — build static assets then serve dist/ from the
  // same Node image. This keeps the first-preview path one-click:
  // CDS currently runs source containers, not custom image builds, so
  // suggesting nginx here produced a profile that could not run npm.
  if (deps.has('vite') && (deps.has('react') || deps.has('react-dom'))) {
    return {
      framework: 'vite-react',
      dockerImage: nodeImage,
      suggestedBuildCommand: buildCmd,
      suggestedRunCommand: nodePackageExec(pm, 'serve', '-s dist -l $PORT'),
      signals: ['deps:vite+react'],
      summary: 'Vite + React (static preview via serve)',
      containerPort: 3000,
    };
  }

  // 5. Express — only if nothing more specific matched above.
  // Many Express apps don't have a start script, so we fall back
  // to a best-effort `node server.js` / `node index.js`.
  if (deps.has('express')) {
    const entry = ['server.js', 'server.ts', 'index.js', 'app.js']
      .find((f) => fs.existsSync(path.join(searchPath, f)));
    return {
      framework: 'express',
      dockerImage: nodeImage,
      suggestedRunCommand: entry ? `node ${entry}` : 'node server.js',
      signals: ['deps:express'],
      summary: 'Express (Node.js)',
      containerPort: 3000,
    };
  }

  return null;
}

/**
 * Python framework detector. Reads requirements.txt +
 * pyproject.toml and picks the first matching framework. Case-
 * insensitive match on the bare package name (ignore version
 * specifiers and extras like `fastapi[all]`).
 */
function detectPythonFramework(searchPath: string): FrameworkDetection | null {
  const parts: string[] = [];
  const reqPath = path.join(searchPath, 'requirements.txt');
  if (fs.existsSync(reqPath)) parts.push(readText(reqPath) || '');
  const pyprojectPath = path.join(searchPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) parts.push(readText(pyprojectPath) || '');
  const haystack = parts.join('\n').toLowerCase();

  // Pull out every left-hand package identifier from requirements
  // lines: `fastapi[all]==0.110.0` → `fastapi`. For pyproject we
  // settle for substring match since TOML parsing would pull in a
  // dependency, which this rule file explicitly forbids.
  const deps = new Set<string>();
  for (const raw of haystack.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-z0-9][a-z0-9._-]*)/.exec(line);
    if (m) deps.add(m[1]);
  }
  const hasDep = (name: string) => deps.has(name) || haystack.includes(`"${name}"`) || haystack.includes(`'${name}'`);
  const pyImage = 'python:3.12-slim';

  // 1. Django — signal also includes manage.py which is unique
  if (hasDep('django') || fs.existsSync(path.join(searchPath, 'manage.py'))) {
    return {
      framework: 'django',
      dockerImage: pyImage,
      suggestedRunCommand: 'python manage.py runserver 0.0.0.0:$PORT',
      signals: hasDep('django') ? ['deps:django'] : ['manage.py'],
      summary: 'Django (Python)',
      containerPort: 8000,
    };
  }

  // 2. FastAPI — assume `main:app` as the ASGI entrypoint; most
  // FastAPI tutorials use exactly this shape.
  if (hasDep('fastapi')) {
    return {
      framework: 'fastapi',
      dockerImage: pyImage,
      suggestedRunCommand: 'uvicorn main:app --host 0.0.0.0 --port $PORT',
      signals: ['deps:fastapi'],
      summary: 'FastAPI (Python)',
      containerPort: 8000,
    };
  }

  // 3. Flask — classic WSGI; `flask run` assumes FLASK_APP env
  if (hasDep('flask')) {
    return {
      framework: 'flask',
      dockerImage: pyImage,
      suggestedRunCommand: 'flask run --host 0.0.0.0 --port $PORT',
      signals: ['deps:flask'],
      summary: 'Flask (Python)',
      containerPort: 5000,
    };
  }

  return null;
}

/**
 * Ruby framework detector. Parses Gemfile for `gem "rails"` or
 * `gem 'rails'`. We don't care about the version pin.
 */
function detectRubyFramework(searchPath: string): FrameworkDetection | null {
  const gemfile = readText(path.join(searchPath, 'Gemfile')) || '';
  if (/^\s*gem\s+['"]rails['"]/m.test(gemfile)) {
    return {
      framework: 'rails',
      dockerImage: 'ruby:3.3-slim',
      suggestedRunCommand: 'bundle exec rails server -b 0.0.0.0',
      signals: ['gem:rails'],
      summary: 'Ruby on Rails',
      containerPort: 3000,
    };
  }
  return null;
}

/**
 * Framework dispatcher — picks the right sub-detector based on
 * the already-resolved base stack. Returns null when no framework
 * can be identified or when the base stack doesn't have a
 * framework layer yet (go / rust / java / php / dockerfile).
 */
export function detectFramework(
  kind: DetectedStack,
  repoRoot: string,
): FrameworkDetection | null {
  if (!fs.existsSync(repoRoot)) return null;
  switch (kind) {
    case 'nodejs': {
      const pkg = readJson(path.join(repoRoot, 'package.json'));
      if (!pkg) return null;
      return detectNodejsFramework(repoRoot, pkg);
    }
    case 'python':
      return detectPythonFramework(repoRoot);
    case 'ruby':
      return detectRubyFramework(repoRoot);
    default:
      return null;
  }
}

/**
 * Merge a framework detection onto the base-stack detection. The
 * base-stack fields remain the source of truth for anything the
 * framework didn't explicitly override — this keeps legacy
 * callers that only read `dockerImage` / `runCommand` happy.
 */
function applyFramework(
  base: StackDetection,
  fw: FrameworkDetection,
): StackDetection {
  return {
    ...base,
    framework: fw.framework,
    dockerImage: fw.dockerImage ?? base.dockerImage,
    suggestedRunCommand: fw.suggestedRunCommand,
    suggestedBuildCommand: fw.suggestedBuildCommand,
    // If the framework proposed a concrete start command we also
    // reflect it in the primary `runCommand` so the form UI (which
    // already reads that field) lands on the better default.
    runCommand: fw.suggestedRunCommand ?? base.runCommand,
    buildCommand: fw.suggestedBuildCommand ?? base.buildCommand,
    containerPort: fw.containerPort ?? base.containerPort,
    signals: fw.signals ? [...base.signals, ...fw.signals] : base.signals,
    summary: fw.summary ? `${base.summary} · ${fw.summary}` : base.summary,
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
    if (result) {
      // FU-03: after base-stack detection, attempt framework sniffing.
      // The framework layer is a best-effort refinement — if nothing
      // matches we return the base detection unchanged.
      const fw = detectFramework(result.stack, searchPath);
      return fw ? applyFramework(result, fw) : result;
    }
  }
  return unknownDetection(searchPath);
}

/**
 * Module-level detection result for a monorepo. Each entry corresponds
 * to a directory inside the repo that produced its own stack signal.
 *   subPath    relative path from the repo root (e.g. "prd-admin")
 *   detection  the per-directory stack detection
 */
export interface ModuleDetection {
  subPath: string;
  detection: StackDetection;
}

/**
 * Heuristic monorepo scan: when the repo root has nothing useful, walk
 * one level of immediate subdirectories and run the per-directory
 * detector on each. Returns every module that yielded a usable stack.
 *
 * Why this exists:
 *   The original `detectStack` only ever inspects `searchPath` itself.
 *   That is wrong for any monorepo — e.g. `prd_agent` has no manifest
 *   at the root, so detection returned `unknown` and the auto-profile
 *   creator skipped the project entirely. Users were then stuck on
 *   "尚未配置构建配置" with no obvious recovery path.
 *
 * Behaviour:
 *   - If the root itself has a stack (excluding `unknown`), return a
 *     single ModuleDetection with subPath = '.'.
 *   - Otherwise, scan immediate child directories (depth = 1). Skip
 *     hidden directories (`.git`, `.cds-repos`, `.vscode` …) and a few
 *     well-known noise paths (node_modules, dist, build, target).
 *   - Each child that yields a non-`unknown` detection becomes a
 *     module entry.
 *   - If still nothing, return an empty list so the caller can surface
 *     "未识别出已知栈" in a helpful way (e.g. offer a docker-compose
 *     fallback or a manual profile form).
 */
export function detectModules(searchPath: string): ModuleDetection[] {
  if (!fs.existsSync(searchPath)) return [];

  const root = detectStack(searchPath);
  if (root.stack !== 'unknown') {
    return [{ subPath: '.', detection: root }];
  }

  // Subdir scan. Hidden + heavy noise dirs filtered out. We accept the
  // small risk of double-counting nested monorepos (rare in practice)
  // for the sake of a simple, predictable scanner.
  const NOISE = new Set([
    'node_modules',
    'dist',
    'build',
    'target',
    '.git',
    '.cds-repos',
    '.vscode',
    '.idea',
    '.next',
    '.turbo',
    '.cache',
    'coverage',
    '__pycache__',
    'venv',
    '.venv',
  ]);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(searchPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ModuleDetection[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (NOISE.has(entry.name)) continue;
    const childPath = path.join(searchPath, entry.name);
    const detection = detectStack(childPath);
    if (detection.stack === 'unknown') continue;
    // workDir is relative to the repo root for the BuildProfile.
    const adjusted: StackDetection = {
      ...detection,
      workDir: entry.name,
      summary: `[${entry.name}] ${detection.summary}`,
    };
    out.push({ subPath: entry.name, detection: adjusted });
  }
  return out;
}
