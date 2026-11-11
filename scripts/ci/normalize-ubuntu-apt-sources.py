#!/usr/bin/env python3
"""Normalize existing Ubuntu CI sources without changing suites or trust settings.

Official formats: https://manpages.ubuntu.com/manpages/noble/man5/sources.list.5.html
Transport bounds: https://manpages.ubuntu.com/manpages/noble/man1/apt-transport-http.1.html
The explicit --root permits fixture tests without touching the host's APT files.
"""

import argparse
from pathlib import Path
import re
from urllib.parse import urlsplit


MIRROR_FILES = {'/etc/apt/apt-mirrors.txt', '/etc/apt/apt-mirrors-security.txt'}
NETWORK_BOUNDS = '''// CI network bounds; package signature and TLS verification remain unchanged.
Acquire::Retries "2";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
'''


def canonical_uri(uri, security=False):
    parsed = urlsplit(uri)
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        return uri
    mirror_file = parsed.scheme == 'mirror+file' and not parsed.netloc and parsed.path in MIRROR_FILES
    official_http = (parsed.scheme in {'http', 'https'}
                     and parsed.netloc.lower() == (parsed.hostname or '').lower()
                     and parsed.path.rstrip('/') == '/ubuntu'
                     and ((parsed.hostname or '').lower() in {'archive.ubuntu.com', 'security.ubuntu.com'}
                          or (parsed.hostname or '').lower().endswith('.archive.ubuntu.com')))
    if not mirror_file and not official_http:
        return uri
    security = security or parsed.hostname == 'security.ubuntu.com' or parsed.path.endswith('apt-mirrors-security.txt')
    return f'https://{"security" if security else "archive"}.ubuntu.com/ubuntu'


def normalize_legacy(text):
    entry = re.compile(r'^(\s*deb(?:-src)?[ \t]+(?:\[[^\]\r\n]*\][ \t]+)?)(\S+)([ \t]+)(\S+)(.*)$')
    result = []
    for line in text.splitlines(keepends=True):
        match = entry.match(line.rstrip('\r\n'))
        if match:
            uri = canonical_uri(match[2], match[4].endswith('-security'))
            line = line[:match.start(2)] + uri + line[match.end(2):]
        result.append(line)
    return ''.join(result)


def normalize_stanza(text):
    lines = text.splitlines(keepends=True)
    fields = {}
    current = None
    for index, line in enumerate(lines):
        if line.startswith('#'):
            continue
        match = re.match(r'^([A-Za-z][A-Za-z0-9-]*):[ \t]*', line)
        if match:
            current = match[1].lower()
            fields.setdefault(current, []).append((index, match.end()))
        elif line.startswith((' ', '\t')) and current:
            fields[current].append((index, 0))
        else:
            current = None
    suites = ' '.join(lines[index][start:].strip() for index, start in fields.get('suites', [])).split()
    security = bool(suites) and all(suite.endswith('-security') for suite in suites)
    for index, start in fields.get('uris', []):
        lines[index] = lines[index][:start] + re.sub(r'\S+', lambda match: canonical_uri(match[0], security), lines[index][start:])
    return ''.join(lines)


def normalize_deb822(text):
    return ''.join(normalize_stanza(part) for part in re.split(r'(\r?\n[ \t]*\r?\n)', text))


def prepare(root):
    root = root.resolve(strict=True)
    apt = root / 'etc/apt'
    files = [apt / 'sources.list']
    if (apt / 'sources.list.d').exists():
        files += sorted((apt / 'sources.list.d').glob('*.list'))
        files += sorted((apt / 'sources.list.d').glob('*.sources'))
    changed = 0
    for path in files:
        if not path.is_file():
            continue
        # A fixture must never follow a source symlink outside its selected root.
        path.resolve().relative_to(root)
        original = path.read_bytes().decode('utf-8')
        normalized = normalize_deb822(original) if path.suffix == '.sources' else normalize_legacy(original)
        if normalized != original:
            path.write_bytes(normalized.encode('utf-8'))
            changed += 1
    config = apt / 'apt.conf.d/99-ci-network-bounds'
    config.parent.resolve().relative_to(root)
    config.parent.mkdir(parents=True, exist_ok=True)
    config.resolve().relative_to(root)
    config.write_text(NETWORK_BOUNDS, encoding='utf-8')
    config.chmod(0o644)
    return changed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='APT filesystem root; use / only on the CI runner')
    args = parser.parse_args()
    changed = prepare(args.root)
    print(f'Ubuntu CI APT: normalized {changed} source files; retries=2, connect/data timeout=20s')


if __name__ == '__main__':
    main()
