#!/usr/bin/env python3
"""Build and verify the actual project report skill editions; never writes employee reports."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent))
from evidence import analyze, merge_ledgers, normalize

KINDS = {'daily':'daily-report','weekly':'weekly-report','monthly':'project-monthly-report'}

def load_module(name, path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def publisher():
    return load_module('project_skill_publisher',ROOT/'.claude/skills/daily-report-summary/reference/publish.py')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def json_bytes(value):
    return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()

def canonical_html(value):
    return publisher().strip_html_comments(value).lstrip()

def collection_window(ledger, context, baseline):
    raw={**ledger.get('collection',{}),**(context.get('coverageWindow') or {})}
    if raw.get('base'):raw.setdefault('baseSha',raw['base'])
    if raw.get('head'):raw.setdefault('headSha',raw['head'])
    if baseline and raw.get('headSha') and baseline != raw['headSha']:raise ValueError('刊物SHA基线与采集水位线冲突')
    result={k:raw[k] for k in ('baseSha','headSha','coverFrom','coverTo','mode') if raw.get(k)}
    if baseline:result.setdefault('headSha',baseline)
    if not result.get('coverTo') and baseline:
        resolved=subprocess.run(['git','-C',str(ROOT),'show','-s','--format=%cI',baseline],capture_output=True,text=True)
        if resolved.returncode==0 and resolved.stdout.strip():result['coverTo']=resolved.stdout.strip()
    return result

def build_bundle(ledger, context, start, end, cadence, out, title=None, baseline_sha='', timezone='Asia/Shanghai'):
    from edition_layout import render_edition
    ledger=normalize(ledger);context=context or {}
    baseline_sha=baseline_sha or ledger.get('collection',{}).get('head','')
    coverage=collection_window(ledger,context,baseline_sha)
    note=('Git采集右端：'+coverage['coverTo']+'；仅说明固定提交水位线，不代表已采满报告最后一天或其他来源。' if coverage.get('coverTo') else '未保存精确采集右端时间；不能宣称已采满报告最后一天。')
    ledger['limitations']=list(dict.fromkeys(ledger.get('limitations',[])+[note]))
    report=analyze(ledger,start,end,cadence,timezone)
    title=title or {'daily':'项目日报','weekly':'项目周刊','monthly':'项目管理月度汇总'}[cadence]+' · '+start+' ~ '+end
    rendered=render_edition(report,context,title)
    body=canonical_html(rendered['html']);errors=publisher().validate_html_report(body)
    if errors:raise ValueError('技能刊物HTML未通过原发布器校验：'+'；'.join(errors))
    publisher().assert_no_placeholder(body)
    md=rendered['markdown'].lstrip();directory=Path(out);directory.mkdir(parents=True,exist_ok=True)
    contents={'ledger.json':json_bytes(ledger),'context.json':json_bytes(context),'report.json':json_bytes(report),
              'report.md':md.encode(),'report.html':body.encode()}
    for name,data in contents.items():(directory/name).write_bytes(data)
    manifest={'schemaVersion':1,'cadence':cadence,'kind':KINDS[cadence],'start':start,'end':end,'timezone':timezone,'title':title,
              'baselineSha':baseline_sha,'coverageWindow':coverage,'inputDigest':report['inputDigest'],
              'templatePath':rendered.get('templatePath'),'templateDigest':rendered.get('templateDigest'),
              'files':{name:digest(data) for name,data in contents.items()}}
    (directory/'bundle.json').write_bytes(json_bytes(manifest))
    return manifest

def verify_bundle(path):
    from edition_layout import render_edition
    path=Path(path);manifest=json.loads(path.read_text());directory=path.parent
    expected={'ledger.json','context.json','report.json','report.md','report.html'}
    if manifest.get('schemaVersion')!=1 or set(manifest.get('files',{}))!=expected:raise ValueError('技能报告bundle结构无效')
    if KINDS.get(manifest.get('cadence'))!=manifest.get('kind'):raise ValueError('技能刊系与周期不一致')
    for name,sha in manifest['files'].items():
        if digest((directory/name).read_bytes())!=sha:raise ValueError('技能报告文件已改动：'+name)
    ledger=normalize(json.loads((directory/'ledger.json').read_text()));context=json.loads((directory/'context.json').read_text())
    report=analyze(ledger,manifest['start'],manifest['end'],manifest['cadence'],manifest['timezone'])
    if report!=json.loads((directory/'report.json').read_text()) or report['inputDigest']!=manifest['inputDigest']:
        raise ValueError('技能报告事实与台账不一致')
    rendered=render_edition(report,context,manifest['title'])
    if canonical_html(rendered['html'])!=(directory/'report.html').read_text() or rendered['markdown'].lstrip()!=(directory/'report.md').read_text():
        raise ValueError('技能报告正文与原模板和事实不一致，请重建')
    if rendered.get('templateDigest')!=manifest.get('templateDigest'):raise ValueError('技能模板已变动，请重建')
    if manifest.get('coverageWindow')!=collection_window(ledger,context,manifest.get('baselineSha','')):raise ValueError('采集时间水位线与冻结来源不一致')
    return manifest,ledger

def evidence_metadata(path):
    manifest,ledger=verify_bundle(path)
    return {'deliveryEvidenceSchema':'1','deliveryEvidenceStatus':'verified','deliveryEvidenceDigest':manifest['inputDigest'],
            'deliveryEvidenceLedger':json.dumps(ledger,ensure_ascii=False,separators=(',',':')),
            'deliveryEvidenceStart':manifest['start'],'deliveryEvidenceEnd':manifest['end'],'deliveryEvidenceCadence':manifest['cadence']}

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('build');b.add_argument('--ledger');b.add_argument('--context');b.add_argument('--start',required=True);b.add_argument('--end',required=True)
    b.add_argument('--cadence',choices=KINDS,required=True);b.add_argument('--out',required=True);b.add_argument('--title');b.add_argument('--baseline-sha',default='');b.add_argument('--timezone',default='Asia/Shanghai')
    v=sub.add_parser('verify');v.add_argument('--bundle',required=True)
    pub=sub.add_parser('publish');pub.add_argument('--bundle',required=True);pub.add_argument('--base',default='');pub.add_argument('--store',default='');pub.add_argument('--impersonate',default='inernoro');pub.add_argument('--local',action='store_true');pub.add_argument('--out',default='')
    c=sub.add_parser('collect');c.add_argument('--start',required=True);c.add_argument('--end',required=True);c.add_argument('--cadence',choices=KINDS,required=True);c.add_argument('--out',required=True)
    c.add_argument('--repo',default='.');c.add_argument('--mainline',default='');c.add_argument('--git-head',default='');c.add_argument('--coverage-window',default='');c.add_argument('--evidence-ledger',default='');c.add_argument('--ledger-out',default='');c.add_argument('--evidence-input',default='');c.add_argument('--pull-requests',default='');c.add_argument('--base',default='');c.add_argument('--impersonate',default='inernoro');c.add_argument('--project',default='prd-agent')
    a=p.parse_args()
    if a.command=='build':
        context=json.loads(Path(a.context).read_text()) if a.context else {}
        provided=context.get('deliveryEvidence',{}).get('ledger')
        ledgers=[provided] if provided else []
        if a.ledger:ledgers.append(json.loads(Path(a.ledger).read_text()))
        if not ledgers:raise ValueError('缺少采集器输出的deliveryEvidence.ledger或显式台账，拒绝生成无依据刊物')
        result=build_bundle(merge_ledgers(ledgers),context,a.start,a.end,a.cadence,a.out,a.title,a.baseline_sha,a.timezone)
        print(json.dumps({'bundle':str(Path(a.out)/'bundle.json'),'cadence':result['cadence'],'inputDigest':result['inputDigest']},ensure_ascii=False))
    elif a.command=='verify':
        manifest,_=verify_bundle(a.bundle);print(json.dumps({'verified':True,'inputDigest':manifest['inputDigest']},ensure_ascii=False))
    elif a.command=='collect':
        command=[sys.executable,str(ROOT/'.claude/skills/weekly-update-summary/scripts/collect_week_context.py'),'--week-start',a.start,'--week-end',a.end,'--cadence',a.cadence,'--out',a.out,'--repo',a.repo,'--project',a.project,'--impersonate',a.impersonate]
        prior=[];window={}
        if a.coverage_window:
            window=json.loads(Path(a.coverage_window).read_text())
            if window.get('deliveryEvidenceLedger'):prior.append(window['deliveryEvidenceLedger'])
            if window.get('baseSha'):command+=['--git-base',window['baseSha']]
            if window.get('headSha') and a.git_head and window['headSha']!=a.git_head:raise ValueError('水位线与显式git-head冲突')
        if a.evidence_input:prior.append(json.loads(Path(a.evidence_input).read_text()))
        if prior:
            path=Path(a.out).with_suffix('.input-ledger.json');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(json_bytes(merge_ledgers(prior)));command+=['--evidence-input',str(path)]
        for name,value in [('base',a.base),('mainline',a.mainline),('git-head',a.git_head or window.get('headSha')),('evidence-ledger',a.evidence_ledger),('ledger-out',a.ledger_out),('pull-requests',a.pull_requests)]:
            if value:command+=['--'+name,value]
        subprocess.run(command,check=True,cwd=ROOT,stdout=subprocess.DEVNULL)
        if window:
            path=Path(a.out);collected=json.loads(path.read_text());collected['coverageWindow']=window;path.write_bytes(json_bytes(collected))
    else:
        manifest,_=verify_bundle(a.bundle);directory=Path(a.bundle).resolve().parent
        cmd=[sys.executable,str(ROOT/'.claude/skills/daily-report-summary/reference/publish.py'),'--title',manifest['title'],
             '--report-html',str(directory/'report.html'),'--evidence-bundle',str(Path(a.bundle).resolve()),'--kind',manifest['kind'],
             '--daily-date',manifest['end'],'--replace-same-date','--impersonate',a.impersonate,'--tags',{'daily':'日报,证据日报','weekly':'周报,项目周刊','monthly':'月报,项目管理汇总'}[manifest['cadence']]]
        if manifest.get('baselineSha'):cmd+=['--last-commit',manifest['baselineSha']]
        coverage=manifest.get('coverageWindow',{})
        for name in ('coverFrom','coverTo'):
            if coverage.get(name):cmd+=['--cover-from' if name=='coverFrom' else '--cover-to',coverage[name]]
        if a.base:cmd+=['--base',a.base]
        if a.store:cmd+=['--store',a.store]
        else:cmd+=['--store',{'daily':'日报知识库','weekly':'周报知识库','monthly':'项目月度汇总知识库'}[manifest['cadence']]]
        if a.local:cmd+=['--local','--out',a.out or str(directory/'published.html')]
        subprocess.run(cmd,check=True)

if __name__=='__main__':main()
