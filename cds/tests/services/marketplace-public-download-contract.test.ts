import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const controllerPath = path.join(
  repositoryRoot,
  'prd-api/src/PrdAgent.Api/Controllers/Api/MarketplaceSkillsOpenApiController.cs',
);
const source = fs.readFileSync(controllerPath, 'utf8');

describe('marketplace public download contract', () => {
  it('keeps every read endpoint explicitly anonymous', () => {
    for (const method of ['List', 'GetById', 'Tags', 'Fork', 'Download']) {
      expect(source).toMatch(new RegExp(`\\[AllowAnonymous\\][\\s\\S]{0,120} ${method}\\(`));
    }
  });

  it('returns an API download URL instead of exposing the storage URL', () => {
    expect(source).toContain('downloadUrl = BuildPublicDownloadUrl(skill.Id)');
    expect(source).toContain('zipUrl = BuildPublicDownloadUrl(s.Id)');
    expect(source).not.toContain('downloadUrl = skill.ZipUrl');
    expect(source).not.toContain('zipUrl = s.ZipUrl');
  });

  it('downloads the archive through the configured asset storage', () => {
    expect(source).toContain('_assetStorage.TryDownloadBytesAsync(skill.ZipKey, ct)');
    expect(source).toContain('return File(bytes, "application/zip"');
    expect(source).toContain('SKILL_ARCHIVE_UNAVAILABLE');
  });
});
