"""Freeze native repository sources once; resumed scans never fetch moving branches."""
import asyncio
import os
import zipfile
from pathlib import PurePosixPath
from urllib.parse import quote
from app.core.config import settings
from app.services.scan_snapshot import archive_path, MAX_FILES, MAX_EXPANDED_BYTES, RepositoryResponses
from app.utils.repo_utils import parse_repository_url


async def prepare_repository(saved, project, config, options):
    from app.services.scanner import (github_api, gitlab_api, gitea_api, gitlab_repository_token,
                                     get_github_files, get_gitlab_files, get_gitea_files, fetch_file_content)
    if archive_path(saved.id).exists():
        return {}
    if not project or not project.get('repository_url'):
        raise ValueError('Repository is missing')
    url = project['repository_url']
    kind = project.get('repository_type')
    branch = saved.branch_name or project.get('default_branch') or 'main'
    other = config.get('otherConfig') or {}
    token = other.get({'github': 'githubToken', 'gitlab': 'gitlabToken', 'gitea': 'giteaToken'}.get(kind, ''))
    token = token or getattr(settings, {'github': 'GITHUB_TOKEN', 'gitlab': 'GITLAB_TOKEN', 'gitea': 'GITEA_TOKEN'}.get(kind, ''), None)
    excludes = (config.get('scan_config') or {}).get('exclude_patterns') or []
    request = RepositoryResponses(saved.id, saved.project_id, kind).request
    revision = branch
    if kind == 'github':
        info = parse_repository_url(url, 'github')
        commit = await github_api(f"https://api.github.com/repos/{info['owner']}/{info['repo']}/commits/{quote(branch, safe='')}", token, request=request)
        revision = commit['sha']
        files = await get_github_files(url, revision, token, excludes, request=request)
    elif kind == 'gitlab':
        info = parse_repository_url(url, 'gitlab')
        token = gitlab_repository_token(url, token)
        commit = await gitlab_api(f"{info['base_url']}/projects/{quote(info['project_path'], safe='')}/repository/commits/{quote(branch, safe='')}", token, request=request)
        revision = commit['id']
        files = await get_gitlab_files(url, revision, token, excludes, request=request)
    elif kind == 'gitea':
        info = parse_repository_url(url, 'gitea')
        commit = await gitea_api(f"{info['base_url']}/repos/{info['owner']}/{info['repo']}/git/commits/{quote(branch, safe='')}", token, request=request)
        revision = commit['sha']
        files = await get_gitea_files(url, revision, token, excludes, request=request)
    else:
        raise ValueError('Unsupported repository type')
    selected = set((config.get('scan_config') or {}).get('file_paths') or [])
    if selected:
        files = [row for row in files if row['path'] in selected]
    elif options['max_analyze_files']:
        files = files[:options['max_analyze_files']]
    if len(files) > MAX_FILES:
        raise ValueError('Too many source files')
    path = archive_path(saved.id)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    temporary = path.with_suffix('.part')
    temporary.touch(mode=0o600, exist_ok=True)
    temporary.chmod(0o600)
    work = asyncio.Queue(maxsize=options['llm_concurrency'] * 2)
    results = asyncio.Queue(maxsize=options['llm_concurrency'] * 2)

    async def produce():
        for row in files:
            await work.put(row)
        for _ in range(options['llm_concurrency']):
            await work.put(None)

    async def acquire():
        while True:
            row = await work.get()
            if row is None:
                await results.put(None)
                return
            source = PurePosixPath(row['path'].replace('\\', '/'))
            if source.is_absolute() or '..' in source.parts:
                raise ValueError('Unsafe repository source path')
            headers = {}
            if token:
                headers = {'Authorization': f'Bearer {token}'} if kind == 'github' else {'PRIVATE-TOKEN': token} if kind == 'gitlab' else {'Authorization': f'token {token}'}
            data = await fetch_file_content(row['url'], headers, request=request)
            if data is None:
                raise ValueError('Repository file could not be read')
            await results.put((str(source), data.encode('utf-8')))

    async def persist():
        stopped, size = 0, 0
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            while stopped < options['llm_concurrency']:
                result = await results.get()
                if result is None:
                    stopped += 1
                    continue
                name, data = result
                size += len(data)
                if size > MAX_EXPANDED_BYTES:
                    raise ValueError('Source snapshot exceeds size limit')
                archive.writestr(name, data)
    try:
        async with asyncio.TaskGroup() as group:
            group.create_task(produce())
            for _ in range(options['llm_concurrency']):
                group.create_task(acquire())
            group.create_task(persist())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return {'repository_revision': revision}
