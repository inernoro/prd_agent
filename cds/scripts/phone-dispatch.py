"""手机出口的持久化摘要队列。调用者持有进程文件锁，凭据与记录仅在私有目录。"""
import hashlib
import json
from pathlib import Path

# 与 CDS 报告中心、服务端共用唯一模板文件；不在 Python 里复制通知句子。
CATALOG = json.loads((Path(__file__).resolve().parents[1] / 'src/shared/notification-templates.json').read_text())


class PhoneDispatch:
    def __init__(self, state, persist, sender):
        self.state, self.persist, self.sender = state, persist, sender

    def submit(self, channel, message, event_id, now, urgent_key=None):
        bark = channel['bark']
        destination = hashlib.sha256(json.dumps([bark.get('serverUrl', 'https://api.day.app').rstrip('/'), bark['key']], separators=(',', ':')).encode()).hexdigest()
        route = self.state.setdefault('destinations', {}).setdefault(destination, {'pending': {}, 'receipts': {}, 'attempts': []})
        if event_id in route['receipts']:
            return route['receipts'][event_id]['status'] == 'accepted'
        if event_id not in route['pending']:
            route['pending'][event_id] = {'channel': channel, 'message': message, 'at': now, 'urgentKey': urgent_key}
            self.persist()
        return None  # 已排队不等于已送达；不能提前给上游成功回执。

    def flush(self, now):
        for route in self.state.get('destinations', {}).values():
            route['attempts'] = [at for at in route['attempts'] if now - at < 300]
            route['urgentAttempts'] = [at for at in route.get('urgentAttempts', []) if now - at < 300]
            route['urgentIncidents'] = {key: at for key, at in route.get('urgentIncidents', {}).items() if now - at < 1800}
            pending = route['pending']
            if not pending or len(route['attempts']) >= 7:
                continue
            def fresh(item):
                return bool(item.get('urgentKey') and item['urgentKey'] not in route['urgentIncidents'])
            # 先按可信的结构化故障身份排序，再分页，严重新故障不受普通积压阻塞。
            ids = sorted(pending, key=lambda key: not fresh(pending[key]))[:1000]
            urgent_ready = (any(fresh(pending[key]) for key in ids) and len(route['urgentAttempts']) < 5
                and (not route['urgentAttempts'] or now - route['urgentAttempts'][-1] >= 60))
            normal_ready = (len(route['attempts']) - len(route['urgentAttempts']) < 2
                and now - min(i['at'] for i in pending.values()) >= 30
                and (not route['attempts'] or now - route['attempts'][-1] >= 60))
            if not urgent_ready and not normal_ready:
                continue
            items = [pending[i] for i in ids]
            # 新故障排在恢复消息前；不按项目或来源把真正独立的故障过滤掉。
            items.sort(key=lambda i: i['message'].get('level') == 'passive')
            message = dict(items[0]['message'])
            if len(items) > 1:
                # 收件环境与主体从服务端的结构化消息取得，不能以转发服务器替代。
                origins = [i['message'].get('notificationOrigin', {}) for i in items]
                environments = {o.get('environment', 'unknown') for o in origins}
                systems = {o.get('system', 'unknown') for o in origins}
                env = CATALOG['environments'].get(next(iter(environments)), CATALOG['environments']['unknown']) if len(environments) == 1 else CATALOG['digest']['mixedEnvironment']
                system = CATALOG['systems'].get(next(iter(systems)), CATALOG['systems']['unknown']) if len(systems) == 1 else CATALOG['digest']['mixedSystem']
                message.update(title=env + ' ' + system,
                    body=CATALOG['templates']['MSG-01']['text'].replace('{count}', str(len(items))),
                    level='active' if any(i['message'].get('level') != 'passive' for i in items) else 'passive')
                # 摘要落到列表，不能让多项故障都只指向第一项。原始深链仍在私有台账中。
                from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
                url = urlsplit(message.get('url', ''))
                query = [(k, v) for k, v in parse_qsl(url.query) if k not in ('target', 'detectedAt', 'incident', 'report')]
                fragment = dict(parse_qsl(url.fragment))
                from datetime import datetime, timezone
                notice = {'detectedAt': datetime.fromtimestamp(now, timezone.utc).isoformat(), 'name': '监控通知汇总', 'finding': message['body'], 'count': len(items), 'assessment': 'notification-digest'}
                try:
                    original = json.loads(fragment.get('notice', '{}'))
                    detail = urlsplit(original.get('detailUrl', ''))
                    if detail.scheme == 'https': notice['detailUrl'] = urlunsplit(detail._replace(query='', fragment=''))
                except (ValueError, TypeError): pass
                fragment['notice'] = json.dumps(notice, ensure_ascii=False)
                message['url'] = urlunsplit(url._replace(query=urlencode(query), fragment=urlencode(fragment)))
            route['attempts'].append(now)
            if urgent_ready: route['urgentAttempts'].append(now)
            for identifier in ids:
                key = pending[identifier].get('urgentKey')
                if key: route['urgentIncidents'].setdefault(key, now)
            for identifier in ids:
                route['receipts'][identifier] = {'status': 'unconfirmed', 'at': now, 'message': pending[identifier]['message']}
                del pending[identifier]
            self.persist()  # 先保存整批意图，发送中断或响应丢失后禁止自动重发。
            try:
                accepted = self.sender(items[0]['channel'], message) is True
            except Exception:
                accepted = False
            for identifier in ids:
                route['receipts'][identifier]['status'] = 'accepted' if accepted else 'unconfirmed'
            self.persist()
