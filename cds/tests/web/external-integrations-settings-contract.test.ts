/**
 * CDS 外部接入页契约。
 *
 * 防止 MAP 系统配对与缺陷转发再次散落到不同设置分组，导致用户已经完成一条接入
 * 仍看到笼统的“未接入”。这里只锁住信息架构和配置端点，具体样式由组件构建覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/CdsSettingsPage.tsx'),
  'utf8',
);
const connectionsSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/cds-settings/tabs/ConnectionsTab.tsx'),
  'utf8',
);
const searchIndexSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/lib/settingsSearchIndex.ts'),
  'utf8',
);
const mapConnectionsSource = fs.readFileSync(
  path.resolve(process.cwd(), '../prd-admin/src/pages/infra-services/InfraServicesPage.tsx'),
  'utf8',
);
const mapConnectionServiceSource = fs.readFileSync(
  path.resolve(
    process.cwd(),
    '../prd-api/src/PrdAgent.Infrastructure/Services/InfraConnections/InfraConnectionService.cs',
  ),
  'utf8',
);
const mapConnectionModelSource = fs.readFileSync(
  path.resolve(process.cwd(), '../prd-api/src/PrdAgent.Core/Models/InfraConnection.cs'),
  'utf8',
);

describe('CDS 外部接入页', () => {
  it('外部接入归入接入分组，并保持 connections 深链兼容', () => {
    expect(settingsSource).toMatch(/label: '接入'[\s\S]*?value: 'connections', label: '外部接入'/);
    expect(settingsSource).toContain('<TabsContent value="connections">');
  });

  it('同页分别展示 MAP 系统互联和 MAP 缺陷转发的真实状态', () => {
    expect(connectionsSource).toContain('MAP 系统互联');
    expect(connectionsSource).toContain('MAP 缺陷转发');
    expect(connectionsSource).toContain('同一次授权中完成');
    expect(connectionsSource).toContain('/api/cds-system/connections');
    expect(connectionsSource).toContain('/api/cds-system/integrations/bug-report');
    expect(connectionsSource).toContain('/api/cds-system/integrations/bug-report/test');
  });

  it('只提供 MAP 跳转授权，不要求用户填写或搬运凭据', () => {
    expect(connectionsSource).toContain('authorizationUrl');
    expect(connectionsSource).toContain('前往 MAP 授权');
    expect(connectionsSource).not.toContain('bug-report-map-base-url');
    expect(connectionsSource).not.toContain('bug-report-map-token');
    expect(connectionsSource).not.toContain('创建连接密钥');
    expect(mapConnectionsSource).toContain("params.get('authorizeCds')");
    expect(mapConnectionsSource).toContain('startCdsAuthorization(authorizeCds, window.location.origin)');
    expect(mapConnectionsSource).not.toContain('function PasteDialog');
    expect(mapConnectionsSource).not.toContain('pasteInfraConnection');
  });

  it('MAP 创建永久缺陷授权并在连接撤销或替换时同步吊销', () => {
    expect(mapConnectionServiceSource).toContain('private const string DefectAgentScope = "defect-agent:use"');
    expect(mapConnectionServiceSource).toMatch(/new\[\] \{ DefectAgentScope \}[\s\S]*?ttlDays: 0/);
    expect(mapConnectionServiceSource).toContain('/api/cds-system/integrations/bug-report/authorize');
    expect(mapConnectionServiceSource).toContain('_agentApiKeyService.RevokeAsync');
    expect(mapConnectionModelSource).toContain('public string MapAgentApiKeyId');
  });

  it('设置搜索可直接命中外部接入能力', () => {
    expect(searchIndexSource).toContain("connections: '外部接入'");
    expect(searchIndexSource).toMatch(/id: 'sys:connections:map'[\s\S]*?MAP 系统互联[\s\S]*?MAP 缺陷转发/);
  });
});
