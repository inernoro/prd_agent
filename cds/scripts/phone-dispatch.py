"""手机出口的持久化摘要队列。调用者持有进程文件锁，凭据与记录仅在私有目录。"""
import hashlib
import json


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
                titles = list(dict.fromkeys(i['message']['title'] for i in items))
                message.update(title=f'新增严重故障，共 {len(items)} 项变化' if urgent_ready else f'有 {len(items)} 项监控变化，请查看',
                    body='；'.join(titles[:3]) + (f'；另有 {len(titles)-3} 项' if len(titles) > 3 else '') + '。各项故障分别保留，点击查看详情。',
                    level='active' if any(i['message'].get('level') != 'passive' for i in items) else 'passive')
                # 摘要落到列表，不能让多项故障都只指向第一项。原始深链仍在私有台账中。
                from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
                url = urlsplit(message.get('url', ''))
                query = [(k, v) for k, v in parse_qsl(url.query) if k not in ('target', 'detectedAt', 'incident')]
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
