import fs from 'node:fs';
import path from 'node:path';
import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export interface SwitcherOptions {
  confDir: string;
  distPath: string;
  gatewayContainerName: string;
}

export class SwitcherService {
  private readonly branchesDir: string;
  private readonly defaultConfPath: string;
  /** Saved symlink target for rollback on nginx -t / reload failure */
  private previousTarget: string | null = null;

  constructor(
    private readonly shell: IShellExecutor,
    private readonly options: SwitcherOptions,
  ) {
    this.branchesDir = path.join(options.confDir, 'branches');
    this.defaultConfPath = path.join(options.confDir, 'default.conf');

    // Ensure directory structure
    fs.mkdirSync(this.branchesDir, { recursive: true });

    // Ensure disconnected config exists
    this.ensureDisconnectedConfig();

    // If no default.conf exists at all, symlink to disconnected
    if (!this.linkOrFileExists(this.defaultConfPath)) {
      this.createSymlink('_disconnected');
    }
  }

  // ── Config generation (unchanged) ──

  generateConfig(upstream: string, mode: 'deploy' | 'run' = 'deploy', webUpstream?: string): string {
    // When upstream is null/sentinel, produce a config that returns 502 for API
    // without referencing any upstream host (avoids DNS resolution failure).
    if (upstream === '_disconnected_upstream_') {
      return `server {
    listen 80;
    server_name _;
    client_max_body_size 30m;
    absolute_redirect off;
    port_in_redirect off;

    root /usr/share/nginx/html;
    index index.html;

    # API disconnected — no active branch
    location ^~ /api/ {
        default_type application/json;
        return 502 '{"error":"No active branch connected"}';
    }

    location / {
        try_files $uri /index.html;
    }
}
`;
    }

    const proxyHeaders = `        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 3s;
        proxy_send_timeout 60s;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;`;

    // Source-run mode: dual-container dev (Vite dev server + dotnet API)
    if (mode === 'run') {
      const webTarget = webUpstream ?? upstream;
      const webPort = webUpstream ? 8000 : 8080;
      return `server {
    listen 80;
    server_name _;
    client_max_body_size 30m;
    absolute_redirect off;
    port_in_redirect off;

    # Docker embedded DNS — enables runtime resolution of container hostnames
    resolver 127.0.0.11 valid=30s ipv6=off;

    # Source-run mode — dual dev containers
    # API upstream: ${upstream}
    # Web upstream: ${webTarget}

    # API requests → dotnet container
    location ^~ /api/ {
        set $api_backend http://${upstream}:8080;
        proxy_pass $api_backend;
${proxyHeaders}
    }

    # Everything else → Vite dev server (with HMR WebSocket support)
    location / {
        set $web_backend http://${webTarget}:${webPort};
        proxy_pass $web_backend;
        proxy_http_version 1.1;
        # Use localhost as Host to pass Vite's allowedHosts check
        proxy_set_header Host localhost;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_connect_timeout 3s;
        proxy_send_timeout 60s;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        # WebSocket support for Vite HMR
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
`;
    }

    // Deploy mode: serve pre-built static files from dist, proxy API to container
    return `server {
    listen 80;
    server_name _;
    client_max_body_size 30m;
    absolute_redirect off;
    port_in_redirect off;

    root /usr/share/nginx/html;
    index index.html;

    # API reverse proxy — managed by branch-tester
    # Active upstream: ${upstream}
    location ^~ /api/ {
        proxy_pass http://${upstream}:8080;
${proxyHeaders}
    }

    location ^~ /assets/ {
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800" always;
    }

    location ~* \\.(?:js|css|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|json|txt)$ {
        try_files $uri =404;
        expires 7d;
        add_header Cache-Control "public, max-age=604800" always;
    }

    location / {
        try_files $uri /index.html;
    }
}
`;
  }

  // ── Per-branch config file management ──

  /** Write a branch's nginx config to conf.d/branches/{branchId}.conf */
  saveBranchConfig(branchId: string, content: string): void {
    const confPath = path.join(this.branchesDir, `${branchId}.conf`);
    fs.writeFileSync(confPath, content);
  }

  /** Read a branch's nginx config from disk (returns null if not found) */
  readBranchConfig(branchId: string): string | null {
    const confPath = path.join(this.branchesDir, `${branchId}.conf`);
    if (fs.existsSync(confPath)) {
      return fs.readFileSync(confPath, 'utf-8');
    }
    return null;
  }

  /** Remove a branch's nginx config file */
  removeBranchConfig(branchId: string): void {
    const confPath = path.join(this.branchesDir, `${branchId}.conf`);
    try { fs.unlinkSync(confPath); } catch { /* may not exist */ }
  }

  // ── Symlink-based activation (like nvm/pnpm) ──

  /**
   * Activate a branch: symlink default.conf → branches/{branchId}.conf,
   * then validate and reload nginx.
   */
  async activateBranch(branchId: string): Promise<void> {
    const targetConf = path.join(this.branchesDir, `${branchId}.conf`);
    if (!fs.existsSync(targetConf)) {
      throw new Error(`No nginx config for branch "${branchId}" at ${targetConf}`);
    }

    this.backupSymlink();
    this.createSymlink(branchId);

    try {
      await this.validateAndReload();
    } catch (err) {
      this.rollbackSymlink();
      throw err;
    }
  }

  /** Disconnect gateway: symlink to the _disconnected config */
  async disconnect(): Promise<void> {
    this.ensureDisconnectedConfig();
    await this.activateBranch('_disconnected');
  }

  /** Get the branch ID currently pointed to by the default.conf symlink */
  getActiveBranchFromSymlink(): string | null {
    try {
      const target = fs.readlinkSync(this.defaultConfPath);
      const match = target.match(/^branches\/(.+)\.conf$/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  /** Read the currently active nginx config content (follows symlink) */
  readActiveConfig(): string | null {
    try {
      return fs.readFileSync(this.defaultConfPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ── Static file sync (unchanged) ──

  async syncStaticFiles(sourceDir: string, targetDir: string): Promise<void> {
    const result = await this.shell.exec(
      `rsync -a --delete "${sourceDir}/" "${targetDir}/"`,
    );
    if (result.exitCode !== 0) {
      // fallback to cp if rsync not available
      const cpResult = await this.shell.exec(
        `rm -rf "${targetDir}"/* && cp -r "${sourceDir}/"* "${targetDir}/"`,
      );
      if (cpResult.exitCode !== 0) {
        throw new Error(`Failed to sync static files:\n${combinedOutput(cpResult)}`);
      }
    }
  }

  // ── Private helpers ──

  private ensureDisconnectedConfig(): void {
    const disconnectedPath = path.join(this.branchesDir, '_disconnected.conf');
    if (!fs.existsSync(disconnectedPath)) {
      const content = this.generateConfig('_disconnected_upstream_');
      fs.writeFileSync(disconnectedPath, content);
    }
  }

  private backupSymlink(): void {
    try {
      if (fs.lstatSync(this.defaultConfPath).isSymbolicLink()) {
        this.previousTarget = fs.readlinkSync(this.defaultConfPath);
      } else {
        this.previousTarget = null;
      }
    } catch {
      this.previousTarget = null;
    }
  }

  private rollbackSymlink(): void {
    if (!this.previousTarget) return;
    try { fs.unlinkSync(this.defaultConfPath); } catch { /* ok */ }
    fs.symlinkSync(this.previousTarget, this.defaultConfPath);
    this.previousTarget = null;
  }

  /** Create symlink: default.conf → branches/{branchId}.conf */
  private createSymlink(branchId: string): void {
    const relativeTarget = path.join('branches', `${branchId}.conf`);

    // Remove existing default.conf (file or symlink)
    try { fs.unlinkSync(this.defaultConfPath); } catch { /* may not exist */ }

    fs.symlinkSync(relativeTarget, this.defaultConfPath);
  }

  private linkOrFileExists(p: string): boolean {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  }

  private async validateAndReload(): Promise<void> {
    const { gatewayContainerName } = this.options;

    const testResult = await this.shell.exec(
      `docker exec ${gatewayContainerName} nginx -t`,
    );
    if (testResult.exitCode !== 0) {
      throw new Error(`Nginx syntax validation failed:\n${combinedOutput(testResult)}`);
    }

    const reloadResult = await this.shell.exec(
      `docker exec ${gatewayContainerName} nginx -s reload`,
    );
    if (reloadResult.exitCode !== 0) {
      throw new Error(`Nginx reload failed:\n${combinedOutput(reloadResult)}`);
    }
  }
}
