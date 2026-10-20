"""Assemble review metadata and extract textbook frames from verified segment videos."""
from pathlib import Path
import argparse, hashlib, json, subprocess
from datetime import datetime, timezone

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--partial',action='store_true')
p.add_argument('--version',default=None,help='交付清单版本，不改变逐段内容哈希')
a=p.parse_args();root=a.root.resolve()
spec=json.loads((root/'segments.json').read_text());entries=[];frames=[];pending=[]
for seg in spec['segments']:
 sid=seg['id'];record=root/'evidence'/(sid+'-media.json');video=root/'videos'/(sid+'.mp4')
 if not record.exists() or not video.exists():pending.append(sid);continue
 media=json.loads(record.read_text());build=json.loads((root/'projects'/sid/'build-manifest.json').read_text())
 sha=hashlib.sha256(video.read_bytes()).hexdigest()
 if media.get('status')!='passed' or sha!=media['video_sha256'] or build['content_key']!=media['content_key']:
  raise SystemExit(sid+' 的成片、检查记录与版本不匹配')
 m=media['media'];duration=float(m['video_duration'])
 entry={**build,'actual_duration_seconds':duration,'duration_seconds':duration,'version':build['content_key'][:12],
  'sha256':sha,'has_audio':bool(m['audio_codecs']),'render_status':'complete','technical_validation':'passed',
  'content_review':'awaiting_user_review','evidence_gaps':seg['evidence_gaps']}
 if build.get('visual_only'):
  entry.update({'video':f'visual-materials/{sid}-silent.mp4','audio_quality':'audio_rejected','voice_state':'official_api_pending'})
 entries.append(entry)
 timing=json.loads((root/'projects'/sid/'timing.json').read_text());out=root/'evidence/textbook';out.mkdir(parents=True,exist_ok=True)
 for scene in timing['scenes']:
  # Drawings now develop through narration beats. A fixed 10-second sample can
  # capture an unfinished diagram; take the actual final reading hold instead.
  local=scene['duration']-min(1.2,scene['duration']*.1) if scene.get('visual_kind')=='draw' else min(10,scene['duration']/2)
  sec=round(scene['start']+local,3);target=out/(scene['id']+'.jpg')
  provenance=target.with_suffix('.json')
  wanted={'scene_id':scene['id'],'segment_id':sid,'video_sha256':sha,'time_seconds':sec,'kind':'frame extracted from delivered video; no synthetic UI'}
  if not target.exists() or not provenance.exists() or json.loads(provenance.read_text())!=wanted:
   subprocess.run(['ffmpeg','-v','error','-y','-ss',str(sec),'-i',str(video),'-frames:v','1','-q:v','2',str(target)],check=True)
   provenance.write_text(json.dumps(wanted,ensure_ascii=False,indent=2)+'\n')
  frames.append(wanted)
if pending and not a.partial:raise SystemExit('仍有未交付视频：'+', '.join(pending))
manifest={'schema':1,'version':a.version or '20261020-第一二章审阅版1','goal':spec['goal'],'source_commit':spec['source_commit'],
 'updated_at':datetime.now(timezone.utc).isoformat(),'status':'complete_review_copy' if not pending else 'partial_rendering',
 'segments':entries,'pending_segments':pending,'actual_total_seconds':sum(x['actual_duration_seconds'] for x in entries),
 'chapters':[{'chapter':c,'complete':all(x['id'] in {e['id'] for e in entries} for x in spec['segments'] if x['chapter']==c),
  'actual_duration_seconds':sum(x['actual_duration_seconds'] for x in entries if x['chapter']==c)} for c in [1,2]],
 'other_chapters':'awaiting_user_review','textbook':'textbook/index.html','textbook_pdf':'textbook/前两章配套教材.pdf',
 'limits':['当前账户登录后实录待补，路径示意不证明平台授权或线上验收完成','中文机器配音听感与真人独立跟做待审阅']}
if entries and all(e.get('visual_only') for e in entries):
 manifest.update({'version':a.version or '20261020-逐幕手绘重制2','status':'audio_rejected_by_user','quality':'audio_rejected',
  'voice_state':'official_api_pending','visual_revision':'26幕独立语义图形，按讲解分阶段绘制',
  'textbook_pdf':'textbook/前两章配套教材-画面审阅版.pdf',
  'limits':['无声画面审阅，旧配音停用；正式官方配音到位后需重排图形与字幕','登录后实录与真人独立跟做未完成；本机组件与示意不代表真实平台通过']})
 if str(spec.get('audio_state','')).startswith('official_speech_ready'):
  manifest.update({'voice_state':'local_official_ready_redraw_alignment_pending',
   'audio_notice':'本地官方Coral音轨已完成；本包仅审新绘图，声画逐句同步待完成。时间点用于本包画面定位。',
   'limits':['本地已有官方Coral配音；本包为新图形无声修订，尚未与其逐句同步','登录后实录与真人独立跟做未完成；本机组件与示意不代表真实平台通过']})
  for entry in entries:entry['voice_state']='local_official_ready_redraw_alignment_pending'
(root/'delivery-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
(root/'delivery-manifest.js').write_text('window.__DELIVERY_MANIFEST='+json.dumps(manifest,ensure_ascii=False)+';\n')
(root/'evidence/textbook-frame-manifest.json').write_text(json.dumps({'frames':frames,'count':len(frames),'pending_segments':pending,
 'verified_video_segments':len(entries),'verified_video_sources':[{'id':e['id'],'video':e['video'],'sha256':e['sha256'],
 'current_visual_source_duration_seconds':e['actual_duration_seconds']} for e in entries]},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'complete_segments':len(entries),'pending':pending,'frames':len(frames),'actual_seconds':manifest['actual_total_seconds']},ensure_ascii=False))
