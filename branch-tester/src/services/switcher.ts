import fs from 'node:fs';
import type { IShellExecutor } from '../types.js';
import { combinedOutput } from '../types.js';

export interface SwitcherOptions {
  nginxConfPath: string;
  distPath: string;
  gatewayContainerName: string;
}

export class SwitcherService {
  constructor(
    private readonly shell: IShellExecutor,
    private readonly options: SwitcherOptions,
  ) {}

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
      // When a web container is available, route /api/ to dotnet and everything else to Vite
      const webTarget = webUpstream ?? upstream;
      const webPort = webUpstream ? 8000 : 8080;
      return `server {
    listen 80;
    server_name _;
    client_max_body_size 30m;
    absolute_redirect off;
    port_in_redirect off;

    # Source-run mode — dual dev containers
    # API upstream: ${upstream}
    # Web upstream: ${webTarget}

    # API requests → dotnet container
    location ^~ /api/ {
        proxy_pass http://${upstream}:8080;
${proxyHeaders}
    }

    # Everything else → Vite dev server (with HMR WebSocket support)
    location / {
        proxy_pass http://${webTarget}:${webPort};
${proxyHeaders}
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

  backup(): void {
    const { nginxConfPath } = this.options;
    if (fs.existsSync(nginxConfPath)) {
      fs.copyFileSync(nginxConfPath, nginxConfPath + '.rollback');
    }
  }

  rollbackConfig(): void {
    const { nginxConfPath } = this.options;
    const rollbackPath = nginxConfPath + '.rollback';
    if (fs.existsSync(rollbackPath)) {
      fs.copyFileSync(rollbackPath, nginxConfPath);
    }
  }

  async applyConfig(configContent: string): Promise<void> {
    const { nginxConfPath, gatewayContainerName } = this.options;

    fs.writeFileSync(nginxConfPath, configContent);

    const testResult = await this.shell.exec(
      `docker exec ${gatewayContainerName} nginx -t`,
    );
    if (testResult.exitCode !== 0) {
      this.rollbackConfig();
      throw new Error(`Nginx syntax validation failed:\n${combinedOutput(testResult)}`);
    }

    const reloadResult = await this.shell.exec(
      `docker exec ${gatewayContainerName} nginx -s reload`,
    );
    if (reloadResult.exitCode !== 0) {
      this.rollbackConfig();
      throw new Error(`Nginx reload failed:\n${combinedOutput(reloadResult)}`);
    }
  }

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
}
