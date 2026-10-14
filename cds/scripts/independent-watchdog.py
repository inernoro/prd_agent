#!/usr/bin/env python3
"""第三方心跳哨兵：只检查外部监控，不接管业务通知。配置与台账禁止入库。"""
import argparse
import datetime as dt
import json
import math
import os
import time
import urllib.parse
import urllib.request
import uuid


def iso(now):
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timezone required')
    return parsed.timestamp()


def assess(snapshot, now):
    try:
        updated = timestamp(snapshot['updatedAt'])
        age = now - updated
        if not math.isfinite(age) or age < -60:
            raise ValueError('invalid clock')
        return {'healthy': age <= 180, 'reason': 'fresh' if age <= 180 else 'stale', 'heartbeatAt': updated}
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return {'healthy': False, 'reason': 'unreadable'}


def observe(config, now):
    try:
        url = urllib.parse.urlsplit(config['heartbeatUrl'])
        query = urllib.parse.parse_qsl(url.query) + [('_watchdog', str(int(now)))]
        request = urllib.request.Request(urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query))),
            headers={'Cache-Control': 'no-cache', 'User-Agent': 'independent-heartbeat-watchdog'})
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(65537)
            if len(body) > 65536:
                raise ValueError('snapshot too large')
            return assess(json.loads(body), now)
    except Exception:
        return {'healthy': False, 'reason': 'unreadable'}


def advance(state, observation, now):
    previous = state.get('checkedAt', 0)
    if now - previous > 900:
        state['healthySince'] = None
        state['healthySamples'] = 0
        state['unreadableCount'] = 0
    state['checkedAt'] = now
    state['observation'] = observation
    event = state.get('incident')
    if not observation['healthy']:
        state['healthySince'] = None
        state['healthySamples'] = 0
        state['unreadableCount'] = state.get('unreadableCount', 0) + 1
        # 有明确过期时间直接确认；网络/格式异常至少跨两轮复核，不能断言进程宕机。
        if not event and (observation['reason'] == 'stale' or state['unreadableCount'] >= 2):
            state['incident'] = {'id': str(uuid.uuid4()), 'startedAt': iso(now), 'reason': observation['reason']}
            return 'down'
    else:
        state['unreadableCount'] = 0
        state['healthySamples'] = state.get('healthySamples', 0) + 1
        if state.get('healthySince') is None:
            state['healthySince'] = now
        if event and state['healthySamples'] >= 3 and now - state['healthySince'] >= 600:
            event.update(endedAt=iso(now))
            state['history'] = [event, *state.get('history', [])][:50]
            state['incident'] = None
            return 'recovered'
    return None


def notice(config, event, recovered=False, drill=False):
    finding = ('外部监控心跳已持续恢复，业务故障仍由原有检查单独判断。' if recovered else
        '超过 3 分钟未收到外部监控心跳，暂时无法依靠它确认业务状态。' if event['reason'] == 'stale' else
        '连续无法读取外部监控心跳，可能是网络、存储或监控服务异常，业务状态待确认。')
    return {'name': config.get('displayName', '外部监控'), 'environment': config.get('environment', '生产'),
        'assessment': 'monitor-heartbeat', 'finding': finding, 'detectedAt': event.get('endedAt') or event['startedAt'],
        'recovered': recovered, 'drill': drill}


def payload(config, event, recovered=False, drill=False):
    n = notice(config, event, recovered, drill)
    parts = urllib.parse.urlsplit(config['publicUrl'])
    fragment = dict(urllib.parse.parse_qsl(parts.fragment))
    fragment.update(notice=json.dumps(n, ensure_ascii=False), watchdog=config['watchdogPublicUrl'])
    url = urllib.parse.urlunsplit(parts._replace(fragment=urllib.parse.urlencode(fragment)))
    label = n['name'] + ' · ' + n['environment']
    data = {'device_key': config['bark']['key'], 'title': ('演练｜' if drill else '') + label + ('：心跳已恢复' if recovered else '：心跳中断'),
        'body': n['finding'] + (' 点击查看记录。' if recovered else ' 请检查外部监控服务，点击查看处理建议。'),
        'url': url, 'group': label + ' · 心跳', 'level': 'passive' if recovered or drill else 'active'}
    icon = config.get('iconUrl', '')
    parsed = urllib.parse.urlsplit(icon)
    if parsed.scheme == 'https' and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment:
        data['icon'] = icon
    return data


def send(config, body):
    try:
        request = urllib.request.Request(config['bark'].get('serverUrl', 'https://api.day.app').rstrip('/') + '/push',
            data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read(4096))
            return 'accepted' if response.status == 200 and result.get('code') == 200 else 'rejected'
    except Exception:
        # 超时/连接断开不能证明上游未受理，保持未确认，禁止盲目重发。
        return 'unconfirmed'


def deliver(config, state, transition, save, sender=send, drill=False):
    event = state.get('incident') if transition == 'down' else state.get('history', [{}])[0]
    if not event or not event.get('id'):
        return
    receipts = state.setdefault('receipts', {})
    key = event['id'] + ':' + transition
    if key in receipts:
        return
    if transition == 'recovered' and receipts.get(event['id'] + ':down', {}).get('status') != 'accepted':
        return
    receipts[key] = {'status': 'unconfirmed', 'attemptedAt': iso(time.time())}
    save(state)  # 先持久化发送意图；进程中断后不会产生第二次发送。
    receipts[key]['status'] = sender(config, payload(config, event, transition == 'recovered', drill))
    save(state)


def tick(config, state, observation, now, save, sender=send, drill=False):
    transition = advance(state, observation, now)
    save(state)
    # 已存事件但尚未存发送意图的崩溃窗口可继续；已尝试的事件永不重发。
    if transition == 'recovered':
        deliver(config, state, 'recovered', save, sender, drill)
    elif state.get('incident'):
        deliver(config, state, 'down', save, sender, drill)
    elif state.get('history'):
        deliver(config, state, 'recovered', save, sender, drill)
    return transition


class Store:
    def __init__(self, config):
        from qcloud_cos import CosConfig, CosS3Client
        self.storage = config['storage']
        s = self.storage
        self.client = CosS3Client(CosConfig(Region=s['region'], SecretId=s['secretId'], SecretKey=s['secretKey'], Scheme='https', Timeout=15))

    def read(self):
        response = self.client.get_object(Bucket=self.storage['bucket'], Key=self.storage['stateKey'])
        state = json.loads(response['Body'].get_raw_stream().read(1_000_000))
        if state.get('version') != 1:
            raise ValueError('state not initialized')
        return state

    def save(self, state):
        self.client.put_object(Bucket=self.storage['bucket'], Key=self.storage['stateKey'], Body=json.dumps(state).encode(),
            ACL='private', ContentType='application/json', CacheControl='no-store')

    def publish(self, state):
        # 与私有台账隔离，只公开本项检查的状态；绝不复制凭据、地址、投递载荷。
        public = {k: state.get(k) for k in ['checkedAt', 'incident', 'history', 'healthySince']}
        public.update(updatedAt=iso(state['checkedAt']), staleAfterSeconds=900,
            healthy=state['observation']['healthy'], checking=not state['observation']['healthy'] and not state.get('incident'))
        self.client.put_object(Bucket=self.storage['bucket'], Key=self.storage['publicKey'], Body=json.dumps(public).encode(),
            ACL='public-read', ContentType='application/json', CacheControl='no-store')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--drill', action='store_true')
    args = parser.parse_args()
    config = json.loads(os.environ['WATCHDOG_CONFIG'])
    store = Store(config)
    if args.drill:
        # 独立台账与模拟过期心跳，业务监控继续运行。跨重复执行只发一次演练通知。
        store.storage = {**store.storage, 'stateKey': store.storage['stateKey'] + '.drill'}
        state = store.read()
        now = time.time()
        tick(config, state, assess({'updatedAt': iso(now - 240)}, now), now, store.save, drill=True)
    else:
        state = store.read()  # 缺失/损坏时拒绝从空白重建，避免丢失去重事实。
        now = time.time()
        tick(config, state, observe(config, now), now, store.save)
        store.publish(state)
    receipts = state.get('receipts', {})
    print(json.dumps({'healthy': state.get('observation', {}).get('healthy'), 'incidentOpen': bool(state.get('incident')),
        'attempts': len(receipts), 'accepted': sum(r['status'] == 'accepted' for r in receipts.values()), 'drill': args.drill}))
    if any(r['status'] != 'accepted' for r in receipts.values()):
        raise SystemExit('通知存在未确认或被拒绝记录，请核查私有台账；未自动重复发送。')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # SDK 异常可能包含签名与请求地址；公开 Actions 日志仅记录异常类型。
        raise SystemExit('心跳检查执行失败：' + type(error).__name__) from None
