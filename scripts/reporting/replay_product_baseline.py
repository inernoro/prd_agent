#!/usr/bin/env python3
"""Compile the actual immutable old product source and replay frozen report inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input',default='scripts/tests/fixtures/report_product_generation/frozen-inputs.json')
    p.add_argument('--out',required=True,help='完整 JSON 结果，失败原文与章节均保留')
    p.add_argument('--work',required=True,help='仓库外的中间编译目录')
    p.add_argument('--dotnet',default='dotnet')
    p.add_argument('--product-repo',default='',help='可选：含当前待测API实现的仓库，用于隔离worktree')
    p.add_argument('--skip-product-build',action='store_true',help='当前API已由主校验构建完成时，避免重复编译项目引用')
    args=p.parse_args()
    repo=Path(__file__).resolve().parents[2]
    fixture=Path(args.input).resolve()
    data=json.loads(fixture.read_text())
    baseline=data['baseline']
    source=subprocess.run(['git','-C',str(repo),'show',baseline['gitRef']+':'+baseline['sourcePath']],check=True,capture_output=True).stdout
    digest=hashlib.sha256(source).hexdigest()
    if digest!=baseline['sha256']:
        raise SystemExit('旧源哈希不符，拒绝用变动过的算法冒充基线')
    work=Path(args.work).resolve();work.mkdir(parents=True,exist_ok=True)
    frozen=work/'FrozenReportGenerationService.cs'
    # Only the C# type identifier changes, preserving every method body verbatim.
    frozen.write_text(re.sub(r'\bReportGenerationService\b','FrozenReportGenerationService',source.decode()))
    (work/'baseline-source-proof.json').write_text(json.dumps({'gitRef':baseline['gitRef'],'sourcePath':baseline['sourcePath'],'sha256':digest,'compiledClassRename':'ReportGenerationService -> FrozenReportGenerationService','methodBodiesChanged':False},ensure_ascii=False,indent=2)+'\n')
    out=Path(args.out).resolve();out.parent.mkdir(parents=True,exist_ok=True)
    api_repo=Path(args.product_repo).resolve() if args.product_repo else repo
    project=repo/'scripts/reporting/product-baseline/ReportProductBaseline.csproj'
    env=dict(os.environ)
    env.setdefault('DOTNET_CLI_HOME',str(work/'dotnet-home'))
    env.setdefault('NUGET_PACKAGES',str(work/'nuget-packages'))
    cmd=[args.dotnet,'run','--project',str(project),'-p:FrozenBaselineSource='+str(frozen),'-p:ProductApiProject='+str(api_repo/'prd-api/src/PrdAgent.Api/PrdAgent.Api.csproj'),'--',str(fixture),str(out)]
    if args.skip_product_build:
        cmd.insert(cmd.index('--'), '-p:BuildProjectReferences=false')
    subprocess.run(cmd,env=env,check=True,cwd=repo)
    print('结果：'+str(out))


if __name__=='__main__':main()
