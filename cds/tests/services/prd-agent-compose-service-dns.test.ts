/**
 * 应用容器互调必须使用 Compose 服务名，而不是 CDS profile id。
 *
 * profile id（例如 api-prd-agent）是控制面的配置标识；容器网络稳定提供的是
 * services 下的服务别名（api / llmgw / llmgw-serve）。把前者写进 URL 会出现
 * “所有容器都在运行，但 API 解析不到网关”的假健康。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = fs.readFileSync(path.join(repoRoot, 'cds-compose.yml'), 'utf8');
const compose = yaml.load(source) as {
  services: Record<string, { environment?: Record<string, string> }>;
  'x-cds-deploy-modes': Record<string, Record<string, { env?: Record<string, string> }>>;
};

describe('prd-agent CDS 内部服务 DNS', () => {
  it('不把项目专属 profile id 当成容器主机名', () => {
    expect(source).not.toMatch(/https?:\/\/(?:api|llmgw|llmgw-serve)-prd-agent(?=[:/])/);
  });

  it('源码模式与预构建模式都使用稳定 Compose 服务别名', () => {
    const modes = compose['x-cds-deploy-modes'];
    expect(modes.api.express.env?.ClaudeSdkExecutor__CallbackBaseUrl).toBe('http://api:8080');
    expect(modes['llmgw-web'].dev.env?.LLMGW_PROXY_TARGET).toBe('http://llmgw:8090');
    expect(modes['llmgw-web'].dev.env?.LLMGW_SERVING_PROXY_TARGET).toBe('http://llmgw-serve:8091');

    expect(compose.services.api.environment?.LlmGateway__ServeBaseUrl).toBe('http://llmgw-serve:8091');
    expect(compose.services.api.environment?.ClaudeSdkExecutor__CallbackBaseUrl).toBe('http://api:5000');
    expect(compose.services['llmgw-web'].environment?.LLMGW_PROXY_TARGET).toBe('http://llmgw:8090');
    expect(compose.services['llmgw-web'].environment?.LLMGW_SERVING_PROXY_TARGET).toBe('http://llmgw-serve:8091');
  });
});
