// 假 CDS：完全用真实的 bootstrap 路由逻辑（含新的 cds-pack 匿名端点）。
import express from 'express';
import { createBootstrapRouter } from '/home/user/prd_agent/cds/src/routes/bootstrap.js';
import { SkillProxy } from '/home/user/prd_agent/cds/src/services/skill-proxy.js';

const MAP = 'https://skill-dynamic-listing-adaptation-cegoxl-claude-prd-agent.miduo.org';
const app = express();
app.use('/api', createBootstrapRouter({
  skillProxy: new SkillProxy({ mapBase: MAP, cacheDir: '/tmp/fake-cds-cache' }),
  cdsUpstream: 'https://cds.miduo.org',
  repoRoot: '/home/user/prd_agent/cds',   // 真实仓库根 → 会找到 ../.claude/skills
}));
app.listen(18974, () => console.log('fake-cds ready on http://127.0.0.1:18974'));
