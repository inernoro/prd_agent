import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { parseInstanceCatalog } from '../shared/instance-catalog.js';

export function createInstanceCatalogRouter(repoRoot: string, bundledFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../web/dist/cds-instances.json',
)): Router {
  const router = Router();
  router.get('/instance-catalog', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const sourceFile = path.join(repoRoot, 'cds-instances.json');
      const file = fs.existsSync(sourceFile) ? sourceFile : bundledFile;
      const catalog = fs.existsSync(file)
        ? parseInstanceCatalog(JSON.parse(fs.readFileSync(file, 'utf8')))
        : { version: 1, instances: [] };
      res.json(catalog);
    } catch {
      res.status(503).json({ error: 'instance_catalog_invalid', message: '主备 CDS 配置无法读取，请检查仓库根目录的 cds-instances.json' });
    }
  });
  return router;
}
