import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseOpenTcpPorts(xml) {
  const ports = new Set();
  const portPattern = /<port\s+protocol="tcp"\s+portid="(\d+)"[^>]*>([\s\S]*?)<\/port>/g;
  for (const match of xml.matchAll(portPattern)) {
    if (!/<state\s+state="open"(?:\s|\/|>)/.test(match[2])) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65_535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export function parseAllowedPorts(raw) {
  const ports = String(raw || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65_535);
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function evaluatePublicSurface(openPorts, allowedPorts) {
  const open = new Set(openPorts);
  const allowed = new Set(allowedPorts);
  return {
    unexpectedOpenPorts: openPorts.filter((port) => !allowed.has(port)),
    missingRequiredPorts: allowedPorts.filter((port) => !open.has(port)),
  };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

export function runCli() {
  const xmlPath = argumentValue('--xml');
  const family = argumentValue('--family');
  const outputPath = argumentValue('--out');
  if (!xmlPath || !outputPath || !['ipv4', 'ipv6'].includes(family)) {
    throw new Error('usage: --xml <path> --family <ipv4|ipv6> --out <path>');
  }

  const allowedPorts = parseAllowedPorts(process.env.CDS_ALLOWED_PUBLIC_PORTS);
  if (allowedPorts.length === 0) throw new Error('CDS_ALLOWED_PUBLIC_PORTS is empty');
  const openPorts = parseOpenTcpPorts(fs.readFileSync(xmlPath, 'utf8'));
  const evaluation = evaluatePublicSurface(openPorts, allowedPorts);
  const passed = evaluation.unexpectedOpenPorts.length === 0
    && evaluation.missingRequiredPorts.length === 0;
  const report = {
    checkedAt: new Date().toISOString(),
    family,
    allowedPorts,
    openPorts,
    ...evaluation,
    passed,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`${family}: open=${openPorts.join(',') || 'none'} passed=${passed}`);
  if (!passed) process.exitCode = 1;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) runCli();
