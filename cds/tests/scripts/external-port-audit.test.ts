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
    expect(workflow).toContain('nmap -4');
    expect(workflow).toContain('nmap -6');
    expect(workflow).toContain('--family ipv4');
    expect(workflow).toContain('--family ipv6');
  });
});
