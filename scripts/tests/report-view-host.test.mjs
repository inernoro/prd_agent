import assert from 'node:assert/strict';
import test from 'node:test';
import { isConfiguredCdsTargetHost } from '../../.claude/skills/create-visual-test-to-kb/scripts/report-view.mjs';

for (const [label, target, configured, expected] of [
  ['完整HTTPS地址保留大小写规范化与端口', 'report.example.test:8443', 'https://REPORT.example.test:8443', true],
  ['裸公网主机沿用CLI默认HTTPS', 'report.example.test', 'report.example.test', true],
  ['裸本机默认HTTP端口沿用CLI', '127.0.0.1', '127.0.0.1:80', true],
  ['裸IPv6本机默认HTTP端口沿用CLI', '[::1]', '[::1]:80', true],
  ['其它端口不接受凭据', 'report.example.test:8444', 'report.example.test:8443', false],
  ['同后缀其它主机不接受凭据', 'other.example.test', 'report.example.test', false],
  ['伪造后缀不接受凭据', 'report.example.test.attacker.test', 'report.example.test', false],
  ['无明确配置不扩大信任', 'report.example.test', '', false],
  ['非HTTP协议沿用CLI拒绝', 'report.example.test', 'ftp://report.example.test', false],
  ['含用户信息沿用CLI拒绝', 'report.example.test', 'https://user:password@report.example.test', false],
]) test(label, () => assert.equal(isConfiguredCdsTargetHost(target, configured), expected));
