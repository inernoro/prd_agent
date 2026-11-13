#!/usr/bin/env python3
"""Refresh the public five-skill receipt after editing the bundle."""
import datetime
import hashlib
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
skills = ['cds', 'cds-project-scan', 'cds-deploy-pipeline', 'cds-release', 'preview-url']
receipt = root / 'cds/cli/cds-skill-manifest.json'
version = re.search(r'^VERSION = "([0-9.]+)"', (root / 'cds/cli/cdscli.py').read_text(), re.M)[1]
files = {}
for skill in skills:
    for file in sorted((root / skill).rglob('*')):
        if file == receipt or '__pycache__' in file.parts or file.name == '.DS_Store' or file.suffix == '.pyc':
            continue
        if file.is_symlink():
            raise SystemExit('Unsupported link in skill bundle')
        if file.is_file():
            files[file.relative_to(root).as_posix()] = hashlib.sha256(file.read_bytes()).hexdigest()
    assert skill + '/SKILL.md' in files
receipt.write_text(json.dumps({'format': 'agent-skills', 'version': version, 'skills': skills,
                              'files': files, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()},
                             ensure_ascii=False, indent=2) + '\n')
print(f'Updated public skill receipt: {version}, {len(files)} files')
