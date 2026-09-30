#!/usr/bin/env python3
"""独立 CDS 探测与状态快照。配置只从权限 0600 的文件读取，日志不输出凭据。"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import time
import subprocess
import urllib.request
import uuid


def iso(now):
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()


def read_url(url, headers=None, limit=2_000_000):
    request = urllib.request.Request(url, headers={'User-Agent': 'cds-independent-monitor', **(headers or {})})
    with urllib.request.urlopen(request, timeout=8) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError('response too large')
        return body


def inspect(config, now):
    root_ok = False
    try:
        html = read_url(config['cdsBase'] + '/status').decode('utf-8')
        root_ok = '<html' in html.lower() and '<script' in html.lower()
    except Exception:
        pass
    try:
        summary = json.loads(read_url(config['cdsBase'] + '/api/uptime/summary?segments=12', config['headers']))
        generated = float(summary['generatedAt']) / 1000
        targets = [t for t in summary['targets'] if t.get('projectId') == 'cds-self-monitor']
        fresh = -60 <= now - generated <= 180
        unknown = [t for t in targets if (t.get('lastSample') or {}).get('noData') or now * 1000 - (t.get('lastSample') or {}).get('t', 0) > 660_000]
        collection_down = any(t['id'].startswith('monitor@self-collection-') and t['status'] == 'down' for t in targets)
        # 公开快照只发布结论；内部指标值、地址、异常和其他项目一律不外发。
        metrics = [{'id': t['id'], 'name': t['name'], 'startedAt': iso(t['openIncidentSince']/1000) if t.get('openIncidentSince') else None, 'state': 'unknown' if t in unknown else t['status']}
                   for t in targets if not t['id'].startswith('monitor@self-collection-')]
        data_ok = fresh and bool(targets) and not collection_down and not any(t.get('observeMode') != 'passive' or t.get('sampleCount') != 0 for t in unknown)
        return {'reachable': root_ok, 'dataOk': data_ok, 'metrics': metrics, 'observedAt': iso(now),
                'summaryAt': iso(generated), 'reason': 'unreachable' if not root_ok else 'collection' if not data_ok else None}
    except Exception:
        return {'reachable': root_ok, 'dataOk': False, 'metrics': [], 'observedAt': iso(now),
                'reason': 'collection' if root_ok else 'unreachable'}


def advance(state, observation, now):
    previous = state.get('checkedAt', 0)
    if now - previous > 150:
        state['failures'] = 0
        state['healthySince'] = None
    state['checkedAt'] = now
    state['observation'] = observation
    event = state.get('incident')
    transition = None
    if observation['reason']:
        state['healthySince'] = None
        state['failures'] = state.get('failures', 0) + 1
        if not event and state['failures'] >= 3:
            event = {'id': str(uuid.uuid4()), 'startedAt': iso(now), 'state': 'open', 'reason': observation['reason']}
            state['incident'] = event
            transition = 'down'
        elif event:
            if event['reason'] != 'unreachable' and observation['reason'] == 'unreachable' and not event.get('escalated'):
                event['escalated'] = True
                transition = 'escalated'
            event['reason'] = observation['reason']
        if event:
            event['updatedAt'] = iso(now)
    else:
        state['failures'] = 0
        if state.get('healthySince') is None:
            state['healthySince'] = now
        if event and now - state['healthySince'] >= 600:
            event.update(state='resolved', endedAt=iso(now), updatedAt=iso(now))
            state['history'] = [event, *state.get('history', [])][:50]
            state['incident'] = None
            transition = 'recovered'
    return transition


def public_snapshot(state, config, now):
    obs = state.get('observation', {})
    return {'updatedAt': iso(now), 'staleAfterSeconds': 180, 'incident': state.get('incident'),
            'history': state.get('history', []), 'reachable': obs.get('reachable'), 'dataOk': obs.get('dataOk'),
            'metrics': obs.get('metrics', []), 'summaryAt': obs.get('summaryAt'),
            'checking': bool(state.get('failures')) and not state.get('incident'),
            'notificationReady': bool(config.get('bark')), 'consoleUrl': config['cdsBase'] + '/status'}


def notify(config, state, transition, now):
    bark = config.get('bark')
    if not bark or not transition:
        return
    event = state.get('incident') or state.get('history', [{}])[0]
    if transition == 'recovered' and not any(d.get('accepted') and d.get('incidentId') == event.get('id') and d.get('transition') != 'recovered' for d in state.get('deliveries', [])):
        return True
    title = 'CDS 已稳定恢复' if transition == 'recovered' else 'CDS 外部访问异常' if event.get('reason') == 'unreachable' else 'CDS 自检数据获取异常'
    payload = {'device_key': bark['key'], 'title': title,
               'body': '同一故障已合并。点击查看业务影响、最近检查时间和下一步处理。',
               'url': config['publicUrl'] + '?incident=' + event.get('id', ''),
               'group': 'CDS 监控', 'level': 'passive' if transition == 'recovered' else 'active'}
    ok = False
    try:
        request = urllib.request.Request(bark.get('serverUrl', 'https://api.day.app').rstrip('/') + '/push',
                                         data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=8) as response:
            result = json.loads(response.read(4096))
            ok = response.status == 200 and result.get('code') == 200
    except Exception:
        pass
    state['deliveries'] = [{'at': iso(now), 'incidentId': event.get('id'), 'transition': transition, 'accepted': ok}, *state.get('deliveries', [])][:200]
    return ok


def publish(config, snapshot):
    repo = Path(config['publishRepo'])
    def git(*args):
        return subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True, timeout=30)
    git('pull', '--rebase', 'origin', 'main')
    (repo / 'status.json').write_text(json.dumps(snapshot, ensure_ascii=False), encoding='utf-8')
    git('add', 'status.json')
    git('commit', '-m', 'ops: 更新独立故障检查快照')
    git('push', 'origin', 'HEAD:main')


def tick(config, state, now):
    observation = inspect(config, now)
    transition = advance(state, observation, now)
    if transition:
        state['pending'] = {'transition': transition, 'attempts': 0, 'nextAt': now}
    # 页面先留证，再发通知；手机链接不会指向尚未发布的事件。
    publish(config, public_snapshot(state, config, now))
    pending = state.get('pending')
    if pending and config.get('bark') and now >= pending['nextAt']:
        accepted = notify(config, state, pending['transition'], now)
        pending['attempts'] += 1
        pending['nextAt'] = now + 300
        if accepted or pending['attempts'] >= 3:
            state.pop('pending', None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    config_path = Path(args.config)
    if config_path.stat().st_mode & 0o077:
        raise SystemExit('配置文件必须仅服务账号可读（0600）')
    config = json.loads(config_path.read_text())
    path = config_path.with_name('state.json')
    state = json.loads(path.read_text()) if path.exists() else {}
    while True:
        started = time.time()
        try:
            tick(config, state, started)
            print(json.dumps({'at': iso(started), 'result': 'published', 'incident': bool(state.get('incident'))}), flush=True)
        except Exception as error:
            print(json.dumps({'at': iso(started), 'result': 'failed', 'errorType': type(error).__name__}), flush=True)
        finally:
            tmp = path.with_suffix('.tmp')
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as stream:
                json.dump(state, stream)
            os.replace(tmp, path)
        if args.once:
            break
        time.sleep(max(1, 60 - (time.time() - started)))


if __name__ == '__main__':
    main()
