#!/usr/bin/env python3
"""Replay actual old skill collector functions and audit frozen skill artifacts.

No model requests and no service writes. Historical prose is not a fabricated old generator.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime, date
import hashlib
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[3]
FIX=ROOT/'scripts/tests/fixtures/report_skill_generation'
sys.path.insert(0,str(ROOT/'scripts/reporting'))
import evidence


def load_module(path,name):
    sys.path.insert(0,str(Path(path).parent))
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


def read_json(path):return json.loads(Path(path).read_text())


def verify_archive():
    manifest=read_json(FIX/'archive-manifest.json')
    for entry in manifest['artifacts']:
        raw=(FIX/entry['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=entry['sha256']:
            raise ValueError('历史产物哈希不符：'+entry['path'])
    return manifest


def raw_records():
    return read_json(FIX/'daily-source-records.json')['items'],read_json(FIX/'acceptance-source-records.json')['acceptance']


def replay_collector(path, name):
    m=load_module(path,name);daily,acceptance=raw_records();sid=daily[0]['storeId'];calls=[]
    shares=[{'entryId':i['id'],'token':i['sourceShareUrl'].split('/s/lib/')[1].split('?')[0],'isRevoked':False,'expiresAt':None} for i in daily]
    # Only transport envelopes are controlled: business records and full content are frozen originals.
    def curl(args,*_args,**_kwargs):
        url=next((str(v) for v in reversed(args) if str(v).startswith('http')),None);calls.append(url)
        if url and '/entries/' in url and url.endswith('/content'):
            eid=url.split('/entries/')[1].split('/')[0];item=next(i for i in daily if i['id']==eid)
            return {'success':True,'data':{'entryId':eid,'title':item['title'],'content':item['content'],'contentType':item['contentType'],'hasContent':True}}
        if url and url.endswith('/share-links'):return {'success':True,'data':{'items':copy.deepcopy(shares)}}
        if url and '/entries?' in url:return {'success':True,'data':{'items':copy.deepcopy(daily),'total':len(daily),'hasNextPage':False}}
        raise AssertionError('冻结回放拒绝未声明网络请求：'+str(url))
    def cli(args):
        calls.append('cdscli '+' '.join(args))
        if args[:2]==['report','list']:return {'ok':True,'data':copy.deepcopy(acceptance)}
        if args[:2]==['report','deeplink']:
            item=next(i for i in acceptance if i['id']==args[2]);return {'ok':True,'data':{'url':item['deeplink']}}
        raise AssertionError('冻结回放拒绝未声明CDS调用：'+str(args))
    m._curl=curl;m._cdscli=cli;m._cds_api=lambda path: (_ for _ in ()).throw(RuntimeError('冻结回放无该原始响应：'+str(path)));m._find_store=lambda *_args:{'id':sid,'name':'日报知识库'}
    d=m.collect_daily_reports('https://main-prd-agent.miduo.org',[],'2026-09-28','2026-10-04')
    a=m.collect_acceptance('prd-agent','2026-09-28','2026-10-04')
    # Follow the actual SKILL.md --deeplinks path, not the weaker default.
    for item in a.get('items',[]):
        if not item.get('deeplink'):item['deeplink']=m.acceptance_deeplink(item['id'])
    raw_by_id={i['id']:i for i in acceptance};metrics={'missingFullRevision':0,'wrongObservationDateBucket':0,'missingDailyBody':0,'missingDailyWatermark':0,'missingDirectAcceptanceLink':0}
    failures=[]
    for item in a.get('items',[]):
        original=raw_by_id[item['id']];rev=original.get('commitSha') or ''
        if len(rev)>=40 and item.get('commitSha')!=rev:
            metrics['missingFullRevision']+=1;failures.append({'field':'commitSha','id':item['id'],'actual':item.get('commitSha'),'expected':rev})
        expected=datetime.fromisoformat(original['createdAt'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat()
        if item.get('date')!=expected:
            metrics['wrongObservationDateBucket']+=1;failures.append({'field':'observationDate','id':item['id'],'actual':item.get('date'),'expected':expected,'warning':'createdAt仅为报告创建/观测时间，不能升级为实际测试执行时间。'})
        if not (item.get('deeplink') or item.get('sourceUrl')):metrics['missingDirectAcceptanceLink']+=1
    for item in d.get('items',[]):
        if not item.get('content'):metrics['missingDailyBody']+=1
        if not (item.get('metadata') or {}).get('lastCommit'):metrics['missingDailyWatermark']+=1
    return {'dailyReports':d,'acceptance':a,'transportCalls':calls,'metrics':metrics,'retainedFailures':failures}


class VisibleText(HTMLParser):
    def __init__(self):super().__init__();self.parts=[];self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in {'style','script'}:self.skip+=1
    def handle_endtag(self,tag):
        if tag in {'style','script'}:self.skip=max(0,self.skip-1)
    def handle_data(self,data):
        if not self.skip and data.strip():self.parts.append(data.strip())


def visible(path):
    text=Path(path).read_text()
    if str(path).endswith('.html'):
        parser=VisibleText();parser.feed(text);text=' '.join(parser.parts)
    return ' '.join(text.split())


def review_history():
    policy=read_json(FIX/'historical-review.json');out=[]
    for review in policy['findings']+policy['positiveControls']:
        text=visible(FIX/review['artifact']);span=' '.join(review.get('span','').split())
        if span and span not in text:raise AssertionError('原文定位失败：'+review['id'])
        if any(alias in text for alias in review.get('absenceAliases',[])):raise AssertionError('预标注的缺失事项已出现在原文：'+review['id'])
        out.append({**review,'spanFound':bool(span),'reviewMode':'predeclared-human-readable-span-audit'})
    return {'method':policy['method'],'findings':[x for x in out if x['id'] in {r['id'] for r in policy['findings']}],
            'positiveControls':[x for x in out if x['id'] in {r['id'] for r in policy['positiveControls']}],
            'limits':policy['limits']}


def context_for(case):
    daily,acceptance=raw_records();lo=datetime.fromisoformat(case['start']+'T00:00:00+08:00');hi=datetime.fromisoformat(case['end']+'T00:00:00+08:00');selected=[]
    for record in acceptance:
        at=datetime.fromisoformat(record['createdAt'].replace('Z','+00:00')).astimezone(ZoneInfo('Asia/Shanghai'))
        if lo.date()<=at.date()<=hi.date():selected.append({**record,'date':at.date().isoformat(),'sourceUrl':record['deeplink'],'timeBasis':'observed','excerpt':record['title']})
    ds=[copy.deepcopy(d) for d in daily if case['start']<=d['metadata']['dailyDate']<=case['end']]
    for item in ds:item.update(entryId=item['id'],date=item['metadata']['dailyDate'],shareUrl=item['sourceShareUrl'])
    return {'weekStart':case['start'],'weekEnd':case['end'],'project':'prd-agent','sampleType':'frozen-historical-source-projection',
        'dailyReports':{'available':True,'items':ds,'count':len(ds)},
        'acceptance':{'available':True,'items':selected,'count':len(selected),'coverageComplete':False,'note':'仅固定样本子集，不是全项目验收率；date为观测日，实际运行时间未获确认。'},
        'releases':{'available':False,'reason':'旧W40报告记载发布3次/成功1次，但当时原始run快照未取得；不能用今天保留期外空列表否定历史。'},
        'teamInsights':{'available':False,'reason':'本固定样本没有同口径团队测量原始快照。'},
        'adoption':{'available':False,'reason':'本固定样本没有采用测量原始快照。'},
        'defects':{'available':False,'reason':'本固定样本没有完整缺陷台账，不能填零。'},
        'sourceCoverage':{'complete':False,'reason':'真实来源复核子集；不能解释为完整项目交付数量。'}}


def audit_current(report,gold):
    failures=[];items=report['items'];ids=[i['workItemId'] for i in items]
    for expected in gold['expectedItems']:
        if expected not in ids:failures.append({'type':'omission','workItemId':expected})
    for ident in set(ids):
        if ids.count(ident)>1:failures.append({'type':'duplicate','workItemId':ident,'count':ids.count(ident)})
    for item in items:
        expected=gold['expectedItems'].get(item['workItemId'])
        if not expected:failures.append({'type':'unexpectedItem','workItemId':item['workItemId']});continue
        for field,value in expected.items():
            if item['current'][field]!=value:failures.append({'type':'wrongConclusion','workItemId':item['workItemId'],'field':field,'expected':value,'actual':item['current'][field]})
        for eid in item['historyEvidence']:
            if eid not in report['evidence']:failures.append({'type':'missingSource','evidenceId':eid})
    if report['newMilestones']!=gold['newMilestones']:failures.append({'type':'wrongNewMilestones','actual':report['newMilestones']})
    if any(m['available'] for m in report['metrics'].values())!=gold['metricsAvailable']:failures.append({'type':'inventedMeasurement'})
    if gold.get('requiresFailedObservation') and not any((i['current'].get('lastValidation') or {}).get('status')=='failed' for i in items):failures.append({'type':'omittedFailedObservation'})
    if gold.get('requiresNoPeriodEvent') and any(i['periodEvidence'] for i in items):failures.append({'type':'inventedPeriodProgress'})
    return failures


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--out',required=True);p.add_argument('--work',required=True);p.add_argument('--current-collector',default=str(ROOT/'.claude/skills/weekly-update-summary/scripts/collect_week_context.py'));p.add_argument('--edition-script',default='');p.add_argument('--require-edition',action='store_true');args=p.parse_args()
    work=Path(args.work).resolve();work.mkdir(parents=True,exist_ok=True);manifest=verify_archive();old=replay_collector(FIX/'archive/old-collect-week-context.py','frozen_old_skill_collector');new=replay_collector(args.current_collector,'current_skill_collector')
    cases=read_json(FIX/'cases.json');gold={c['id']:c for c in read_json(FIX/'gold.json')['cases']};results=[]
    for case in cases['cases']:
        directory=work/case['id'];directory.mkdir(exist_ok=True);ledger_path=directory/'ledger.json';context_path=directory/'context.json';ledger_path.write_text(json.dumps(case['ledger'],ensure_ascii=False,indent=2));context_path.write_text(json.dumps(context_for(case),ensure_ascii=False,indent=2))
        report=evidence.analyze(case['ledger'],case['start'],case['end'],case['cadence']);edition=None
        script=Path(args.edition_script) if args.edition_script else ROOT/'scripts/reporting/edition.py'
        if script.exists():
            subprocess.run([sys.executable,str(script),'build','--ledger',str(ledger_path),'--context',str(context_path),'--start',case['start'],'--end',case['end'],'--cadence',case['cadence'],'--out',str(directory/'edition')],check=True,cwd=ROOT,capture_output=True,text=True)
            edition={'directory':str(directory/'edition'),'files':[str(f.name) for f in sorted((directory/'edition').iterdir())]}
        elif args.require_edition:raise SystemExit('实际技能edition入口不存在，不能以离线事实渲染冒充最终技能输出。')
        failures=audit_current(report,gold[case['id']]);results.append({'id':case['id'],'cadence':case['cadence'],'sourceInputDigest':report['inputDigest'],'historicalArtifacts':case['historicalArtifacts'],'oldEditionAvailable':case['oldEditionAvailable'],'oldArtifactRelationship':case['oldArtifactRelationship'],'strictSameInputLlmReplay':False,'report':report,'edition':edition,'failures':failures})
    result={'schemaVersion':1,'baselineRef':cases['baselineRef'],'archiveCount':len(manifest['artifacts']),
        'collectorReplay':{'method':'固定真实记录与受控传输封套，运行未改写的3035365de旧采集器及当前采集器；这不是LLM叙事回放。','old':old,'current':new},
        'historicalArtifactReview':review_history(),'currentSourceCases':results,'limits':cases['limits']}
    Path(args.out).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'collector':{'old':old['metrics'],'current':new['metrics']},'currentCaseFailures':sum(len(r['failures']) for r in results),'historicalReviewFindings':len(result['historicalArtifactReview']['findings'])},ensure_ascii=False))
    if any(r['failures'] for r in results):raise SystemExit(1)


if __name__=='__main__':main()
