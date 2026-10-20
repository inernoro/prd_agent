"""Create an audition with OpenAI's official Speech API; never persist credentials.

Use an injected OPENAI_API_KEY, or --prompt-key for an agent-controlled no-echo
terminal. Do not pass keys in command arguments or source files. A prepared
request and a playable file are not pronunciation approval.
"""
from pathlib import Path
import argparse, getpass, hashlib, json, os, subprocess, urllib.request, urllib.error

ENDPOINT='https://api.openai.com/v1/audio/speech'
SAMPLE='我们先连接自己的仓库。你只需要完成登录和授权，让智能体检查项目。修复问题以后，运行相关测试，再对最新版本重新评审。确认没有未解决的严重问题，再继续下一步。'
STYLE='使用标准普通话，以中国大陆教师的自然口吻讲解。咬字清晰，语速适中，按中文意群自然停顿，使用自然中文语调，不使用外语口音，不夸张播音。英文产品名自然读出；P0读作P零级，P1读作P一级。'

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--input-file',type=Path)
 p.add_argument('--out',type=Path,required=True)
 p.add_argument('--model',default='gpt-4o-mini-tts')
 p.add_argument('--voice',default='coral')
 p.add_argument('--prepare-only',action='store_true')
 p.add_argument('--prompt-key',action='store_true')
 a=p.parse_args();text=a.input_file.read_text().strip() if a.input_file else SAMPLE
 if not text or len(text)>4096:p.error('试听文本必须为1至4096字符')
 payload={'model':a.model,'voice':a.voice,'input':text,'instructions':STYLE,'response_format':'wav','speed':1.0}
 a.out.parent.mkdir(parents=True,exist_ok=True)
 request_file=a.out.with_suffix('.request.json');request_file.write_text(json.dumps({'endpoint':ENDPOINT,'request':payload,'approval':'audition_pending'},ensure_ascii=False,indent=2)+'\n')
 if a.prepare_only:
  print(json.dumps({'state':'prepared_not_called','request':str(request_file),'endpoint':ENDPOINT},ensure_ascii=False));return 0
 key=os.environ.get('OPENAI_API_KEY')
 if not key and a.prompt_key:key=getpass.getpass('Official API credential (hidden): ')
 if not key:raise SystemExit('缺少官方API凭据；请通过安全环境配置或Agent无回显输入提供，不要写入代码。')
 req=urllib.request.Request(ENDPOINT,data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=120) as response:body=response.read();content_type=response.headers.get('Content-Type','')
 except urllib.error.HTTPError as e:
  # Authentication error messages can echo a partial key. Never log the body.
  raise SystemExit('官方Speech API返回HTTP '+str(e.code)+'；未记录响应正文或凭据。') from None
 except urllib.error.URLError as e:
  raise SystemExit('官方Speech API网络连接失败：'+str(e.reason)) from None
 finally:
  del key
 if not body or 'json' in content_type:raise SystemExit('未收到有效音频，不保存为试听成片。')
 temporary=a.out.with_suffix('.pending.wav');temporary.write_bytes(body)
 try:
  probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(temporary)]))
  if not any(s.get('codec_type')=='audio' for s in probe['streams']):raise ValueError('missing audio')
  decoded=subprocess.run(['ffmpeg','-v','error','-i',str(temporary),'-f','null','-'],capture_output=True,text=True)
  if decoded.returncode or decoded.stderr:raise ValueError('audio decode failed')
 except Exception:
  temporary.unlink(missing_ok=True);raise
 temporary.replace(a.out)
 meta={'provider':'OpenAI official Speech API','endpoint':ENDPOINT,'model':a.model,'voice':a.voice,
  'duration_seconds':float(probe['format']['duration']),'sha256':hashlib.sha256(body).hexdigest(),
  'text_sha256':hashlib.sha256(text.encode()).hexdigest(),'decode_passed':True,
  'pronunciation_review':'awaiting_user_audition','production_approved':False}
 a.out.with_suffix('.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'state':'audition_ready_not_approved','audio':str(a.out),'seconds':meta['duration_seconds']},ensure_ascii=False));return 0

if __name__=='__main__':raise SystemExit(main())
