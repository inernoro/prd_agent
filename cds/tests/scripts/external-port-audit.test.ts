import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  evaluatePublicSurface,
  parseAllowedPorts,
  parseOpenTcpPorts,
} from '../../scripts/validate-external-port-report.mjs';

describe('external port audit report', () => {
  it('parses only open TCP ports from nmap XML', () => {
    const xml = `<?xml version="1.0"?>
      <nmaprun><host><ports>
        <port protocol="tcp" portid="22"><state state="open"/></port>
        <port protocol="tcp" portid="80"><state state="filtered"/></port>
        <port protocol="udp" portid="443"><state state="open"/></port>
        <port protocol="tcp" portid="443"><state state="open"/></port>
      </ports></host></nmaprun>`;
    expect(parseOpenTcpPorts(xml)).toEqual([22, 443]);
  });

  it('passes only when the public surface exactly matches the allowlist', () => {
    const allowed = parseAllowedPorts('22,443,80,80');
    expect(allowed).toEqual([22, 80, 443]);
    expect(evaluatePublicSurface([22, 80, 443], allowed)).toEqual({
      unexpectedOpenPorts: [],
      missingRequiredPorts: [],
    });
  });

  it('reports both unexpected exposure and required-port outage', () => {
    expect(evaluatePublicSurface([22, 12_345], [22, 80, 443])).toEqual({
      unexpectedOpenPorts: [12_345],
      missingRequiredPorts: [80, 443],
    });
  });

  it('runs the CDS public audit from an off-host runner over both IP families', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/cds-external-port-audit.yml', import.meta.url),
      'utf8',
    );

    expect(workflow).toContain('secrets.CDS_EDGE_AUDIT_HOST');
    expect(workflow).toContain('secrets.CDS_EDGE_AUDIT_IPV6');
    expect(workflow).toContain('secrets.PRODUCTION_EDGE_AUDIT_IPV6');
    expect(workflow).toContain("matrix.environment == 'cds'");
    expect(workflow).toContain('nmap -4');
    expect(workflow).toContain('nmap -6');
    expect(workflow).toContain('--family ipv4');
    expect(workflow).toContain('--family ipv6');
  });

  // 「一个端口都没扫到」既可能是暴露面干净，也可能是根本没扫成，两者在报告里都是
  // openPorts: []。观测点发不出 IPv6 报文时必须在扫描之前就判失败，否则一次没发生的
  // 扫描会被当成结论读。这条守卫盯的就是那步自检别被顺手删掉。
  it('proves the IPv6 runner can originate IPv6 before it trusts an empty scan', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/cds-external-port-audit.yml', import.meta.url),
      'utf8',
    );

    const capabilityCheck = workflow.indexOf('ip -6 addr show scope global 2>/dev/null');
    const ipv6Scan = workflow.indexOf('nmap -6');
    expect(capabilityCheck).toBeGreaterThan(-1);
    expect(ipv6Scan).toBeGreaterThan(-1);
    // 自检必须排在扫描之前——排在后面等于扫完才发现扫不了，那份空报告已经产出了。
    expect(capabilityCheck).toBeLessThan(ipv6Scan);
  });

  // 扫描没跑到的时候不该再抛一条「找不到产物」，那会把真正的失败原因埋在噪音下面。
  it('uploads evidence only when the scan step actually ran', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/cds-external-port-audit.yml', import.meta.url),
      'utf8',
    );

    const uploadGates = workflow.match(/if: \$\{\{ always\(\) && steps\.scan\.outcome != 'skipped' \}\}/g);
    expect(uploadGates).toHaveLength(2);
    expect(workflow).not.toContain('if: always()');
  });
});
