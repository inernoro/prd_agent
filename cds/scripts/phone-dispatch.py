"""手机出口的持久化摘要队列。调用者持有进程文件锁，凭据与记录仅在私有目录。"""
import hashlib
import json


class PhoneDispatch:
    def __init__(self, state, persist, sender):
        self.state, self.persist, self.sender = state, persist, sender

    def submit(self, channel, message, event_id, now):
        bark = channel['bark']
        destination = hashlib.sha256(json.dumps([bark.get('serverUrl', 'https://api.day.app').rstrip('/'), bark['key']], separators=(',', ':')).encode()).hexdigest()
        route = self.state.setdefault('destinations', {}).setdefault(destination, {'pending': {}, 'receipts': {}, 'attempts': []})
        if event_id in route['receipts']:
            return route['receipts'][event_id]['status'] == 'accepted'
        if event_id not in route['pending']:
            route['pending'][event_id] = {'channel': channel, 'message': message, 'at': now}
            self.persist()
        return None  # 已排队不等于已送达；不能提前给上游成功回执。

    def flush(self, now):
        for route in self.state.get('destinations', {}).values():
            route['attempts'] = [at for at in route['attempts'] if now - at < 300]
            pending = route['pending']
            if not pending or len(route['attempts']) >= 2:
                continue
            # 第一批等 30 秒归并；第二批至少隔 60 秒。后续新故障保留，最迟预算释放时汇总。
            if now - min(i['at'] for i in pending.values()) < 30:
                continue
            if route['attempts'] and now - route['attempts'][-1] < 60:
                continue
            ids = list(pending)[:1000]
            items = [pending[i] for i in ids]
            # 新故障排在恢复消息前；不按项目或来源把真正独立的故障过滤掉。
            items.sort(key=lambda i: i['message'].get('level') == 'passive')
            message = dict(items[0]['message'])
            if len(items) > 1:
                titles = list(dict.fromkeys(i['message']['title'] for i in items))
                message.update(title=f'有 {len(items)} 项监控变化，请查看',
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
