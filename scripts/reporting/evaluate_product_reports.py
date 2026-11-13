#!/usr/bin/env python3
"""Audit real old-source replays against fixed independent factual labels, retaining failures."""
import argparse
from collections import Counter
import json
from pathlib import Path

UNSUPPORTED = {
    '本周未发现明显阻塞风险': '没有风险证据不能据此断言无阻塞',
    '本周工作按计划推进': '没有任务与计划对照证据不能断言按计划推进',
    '执行节奏整体稳定': '打点天数不能证明执行稳定或效率',
    '协作沟通较充分': '对话次数不能证明沟通质量',
}


def audit_old(sample, output, gold):
    sections = output.get('sections') or []
    events = sample['ledger']['events']
    by_revision = {e.get('revision'):e.get('workItemId') for e in events if e.get('revision')}
    by_content = {}
    for commit in sample['activity'].get('commits',[]):
        wid=by_revision.get(commit['commitHash'])
        if wid:by_content[commit['message']]=wid
    # Compare delivery rows only: an issue appearing again in a risk/next-action section is not a duplicate outcome.
    progress = sections[0].get('items',[]) if sections else []
    mentioned = [by_content.get(i['content'].removeprefix('代码提交：')) for i in progress]
    counts = Counter(wid for wid in mentioned if wid)
    failures = {'omissions':[], 'duplicates':[], 'unsupportedConclusions':[], 'missingDirectCitations':[]}
    for wid in gold['expectedItemIds']:
        if not counts[wid]:failures['omissions'].append({'workItemId':wid,'reason':'交付章节未连续跟踪该已知事项'})
    for wid,n in counts.items():
        if n>1:failures['duplicates'].append({'workItemId':wid,'extraRows':n-1})
    for si,section in enumerate(sections):
        for ii,item in enumerate(section.get('items',[])):
            text=item.get('content','')
            for phrase,reason in UNSUPPORTED.items():
                if phrase in text:
                    failures['unsupportedConclusions'].append({'section':si,'item':ii,'span':text,'reason':reason})
            if text and not item.get('sourceRef'):
                failures['missingDirectCitations'].append({'section':si,'item':ii,'span':text,'reason':'只有泛化source标签，没有可直接核查的引用'})
    return failures


def audit_current(output,gold):
    snapshot=output['snapshot'];sections=output['sections']
    items=snapshot['items'];ids=[i['id'] for i in items];lookup={i['id']:i for i in items}
    failures={'omissions':[], 'duplicates':[], 'unsupportedConclusions':[], 'missingDirectCitations':[]}
    for wid in gold['expectedItemIds']:
        if wid not in ids:failures['omissions'].append({'workItemId':wid})
    for wid,n in Counter(ids).items():
        if n>1:failures['duplicates'].append({'workItemId':wid,'extraRows':n-1})
    for wid,states in gold.get('expectedStages',{}).items():
        if wid not in lookup:continue
        for field,value in states.items():
            actual=lookup[wid][field+'Status']
            if actual!=value:failures['unsupportedConclusions'].append({'workItemId':wid,'field':field,'actual':actual,'expected':value})
    for wid in gold.get('blockedItemIds',[]):
        if wid in lookup and not lookup[wid].get('blockReason'):
            failures['unsupportedConclusions'].append({'workItemId':wid,'reason':'真实外部阻塞被丢弃'})
    for metric in snapshot['metrics']:
        if metric['key'] in gold.get('metricsUnavailable',[]) and metric['available']:
            failures['unsupportedConclusions'].append({'metric':metric['key'],'reason':'没有相应测量却报告可用'})
    if gold.get('mustNotCountOldMilestonesAsNew'):
        for stage,value in snapshot['newMilestones'].items():
            if value not in (0,None):failures['unsupportedConclusions'].append({'stage':stage,'actual':value,'reason':'旧成果被算为新增'})
    if gold.get('mustDeclareInsufficientEvidence') and '证据不足' not in snapshot['headline']:
        failures['unsupportedConclusions'].append({'reason':'缺少工作事项输入时未明确证据不足'})
    for si,section in enumerate(sections):
        for ii,item in enumerate(section.get('items',[])):
            text=item.get('content','')
            for phrase,reason in UNSUPPORTED.items():
                if phrase in text:failures['unsupportedConclusions'].append({'section':si,'item':ii,'span':text,'reason':reason})
            if text and item.get('source')!='evidence-gap' and not item.get('sourceRef'):
                failures['missingDirectCitations'].append({'section':si,'item':ii,'span':text})
    return failures


def counts(failures):
    return {key:sum(x.get('extraRows',1) for x in rows) for key,rows in failures.items()}


def evaluate(inputs,result,gold):
    samples={i['id']:i for i in inputs['cases']};annotations={i['id']:i for i in gold['cases']}
    rows=[]
    for output in result['outputs']:
        id=output['id'];sample=samples[id];g=annotations[id]
        old=audit_old(sample,output['old'],g);current=audit_current(output['current'],g)
        rows.append({'id':id,'upstreamMode':output['upstreamMode'],'inputDigest':output['inputDigest'],'old':counts(old),'current':counts(current),'retainedFailures':{'old':old,'current':current}})
    totals={side:{key:sum(r[side][key] for r in rows) for key in rows[0][side]} for side in ('old','current')}
    return {'baseline':result['baseline'],'sampleInputDigest':result['sampleInputDigest'],'definition':{
        'omissions':'已标注真实事项未出现在交付跟踪中；仅比较本固定样本，不推断采集全集完整率。',
        'duplicates':'交付章节同一已知事项的多行提交记录，风险和计划章节的必要引用不算重复成果。',
        'unsupportedConclusions':'与独立来源标签不符的阶段/新增计数，或没有任务证据却断言无风险、按计划、效率稳定。',
        'missingDirectCitations':'肯定正文条目缺少直接来源引用；证据不足声明不当成无来源肯定结论。'},
        'limits':['模型档使用真实历史捕获响应回放，不是本次重新调用模型，不宣称模型本身的线上质量改善率。',
                  '故障注入档直接执行真实旧规则方法；真实W46旧四章原文单独保留，不用今天重查的变化输入冒充当时输入。',
                  '旧正文的自由语义仍需人工核查，自动评分仅覆盖预先声明的标签和原文模式，不宣称自动判断任意正文。',
                  '各指标会重叠，不可相加为单一质量分。'], 'totals':totals,'cases':rows}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',default='scripts/tests/fixtures/report_product_generation/frozen-inputs.json')
    p.add_argument('--gold',default='scripts/tests/fixtures/report_product_generation/gold.json')
    p.add_argument('--replay',required=True)
    p.add_argument('--out',required=True)
    a=p.parse_args()
    report=evaluate(json.loads(Path(a.input).read_text()),json.loads(Path(a.replay).read_text()),json.loads(Path(a.gold).read_text()))
    Path(a.out).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report['totals'],ensure_ascii=False))
    if any(report['totals']['current'].values()):raise SystemExit(1)


if __name__=='__main__':main()
