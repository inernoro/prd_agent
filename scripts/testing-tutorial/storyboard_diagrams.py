"""Scene-specific teaching drawings; geometry and narration beats are authored together."""
from dataclasses import dataclass, field
import hashlib
from html import escape
import json
import re

INK = '#243a38'
GREEN = '#21745b'
RED = '#b54239'
GRAY = '#5e6662'


@dataclass
class Pen:
    scene_id: str
    elements: list = field(default_factory=list)
    beats: list = field(default_factory=list)
    strokes: list = field(default_factory=list)
    last: str | None = None

    def beat(self, cue, description):
        self.beats.append({'cue': cue, 'description': description})
        self.last=None

    def path(self, d, color=INK, width=4):
        if len(re.findall('[Mm]', d)) != 1:
            raise ValueError('One continuous stroke per pen path')
        if not self.beats:
            raise ValueError('A drawing must belong to a narration beat')
        sid = f'{self.scene_id}-pen-{len(self.strokes):02}'
        self.strokes.append({'id': sid, 'd': d, 'beat': len(self.beats)-1})
        self.elements.append(f'<path id="{sid}" class="draw" data-beat="{len(self.beats)-1}" d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')
        self.last = sid
        return sid

    def line(self, x1, y1, x2, y2, color=INK, width=4):
        return self.path(f'M{x1} {y1} L{x2} {y2}', color, width)

    def rect(self, x, y, w, h, color=INK):
        return self.path(f'M{x+10} {y} Q{x} {y} {x} {y+10} L{x} {y+h-10} Q{x} {y+h} {x+10} {y+h} L{x+w-10} {y+h} Q{x+w} {y+h} {x+w} {y+h-10} L{x+w} {y+10} Q{x+w} {y} {x+w-10} {y} Z', color)

    def ellipse(self, cx, cy, rx, ry, color=INK):
        return self.path(f'M{cx-rx} {cy} A{rx} {ry} 0 1 0 {cx+rx} {cy} A{rx} {ry} 0 1 0 {cx-rx} {cy}', color)

    def arrow(self, x1, y1, x2, y2, color=INK):
        import math
        self.line(x1,y1,x2,y2,color)
        angle=math.atan2(y2-y1,x2-x1)
        ax=x2-16*math.cos(angle-.5);ay=y2-16*math.sin(angle-.5)
        bx=x2-16*math.cos(angle+.5);by=y2-16*math.sin(angle+.5)
        return self.path(f'M{ax:.1f} {ay:.1f} L{x2} {y2} L{bx:.1f} {by:.1f}',color)

    def label(self, x, y, text, size=30, color=INK, anchor='middle', after=None):
        # SVG labels are readable text revealed after their corresponding stroke,
        # rather than a claim to animate Chinese glyph stroke order.
        after=after or self.last
        timing=f'data-after-stroke="{after}"' if after else f'data-beat="{len(self.beats)-1}"'
        self.elements.append(f'<g class="reveal" {timing}><text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" fill="{color}">{escape(text)}</text></g>')

    def note(self, x, y, text, size=26):
        self.label(x,y,text,size,GRAY)

    def doc(self, x, y, w=150, h=180, label=''):
        self.path(f'M{x} {y+h} L{x} {y} L{x+w-30} {y} L{x+w} {y+30} L{x+w} {y+h} Z')
        self.path(f'M{x+w-30} {y} L{x+w-30} {y+30} L{x+w} {y+30}')
        for dy in (65,95,125):
            if dy < h-15:self.line(x+20,y+dy,x+w-20,y+dy,GRAY,3)
        if label:self.label(x+w/2,y+h+40,label)

    def person(self, x, y, label=''):
        self.ellipse(x,y,25,25)
        self.path(f'M{x-55} {y+110} L{x-55} {y+80} Q{x-55} {y+42} {x} {y+42} Q{x+55} {y+42} {x+55} {y+80} L{x+55} {y+110}')
        if label:self.label(x,y+150,label)


def chapter_one(p, sid):
    if sid == 'c1-s01-a':
        p.beat('账户开始','先建立身份与工作区关系')
        p.person(160,90,'当前账户')
        p.beat('当前Codex项目','工作区内定位项目，不能串账户')
        p.rect(390,55,490,290);p.label(635,105,'当前工作区',36)
        p.doc(455,135,125,150,'目标项目');p.arrow(230,170,385,170)
        p.beat('普通插件','文件读取权限与评审权限分层')
        p.arrow(890,170,1030,170);p.doc(1060,95,150,170,'文件可读')
        p.path('M1340 135 L1340 100 Q1340 50 1380 50 Q1420 50 1420 100 L1420 135',GREEN)
        p.rect(1315,135,130,105,GREEN);p.label(1380,290,'评审权限另核对',30)
        p.note(830,435,'先确认身份，再确认目标仓库与评审权限',32)
    elif sid == 'c1-s01-b':
        p.beat('发布者','先核验应用身份')
        p.doc(60,95,150,180,'Connector');p.label(135,55,'发布者 openai',30)
        p.beat('个人账户','个人与组织是不同安装归属')
        p.arrow(225,185,425,185);p.path('M440 185 L530 185 L530 95 L650 95');p.person(730,65,'个人')
        p.path('M530 185 L530 300 L650 300');p.rect(680,255,170,90);p.label(765,310,'组织',34)
        p.beat('选择这次','最小仓库范围与审批条件')
        p.arrow(875,185,1035,185);p.rect(1060,50,480,280)
        for yy,txt in [(110,'目标仓库'),(195,'其他仓库')]:
            p.rect(1100,yy-25,30,30);p.label(1160,yy,txt,32,anchor='start')
        p.line(1145,135,1445,135,GREEN)
        p.label(1300,290,'组织批准：按实际状态',27)
        p.note(850,440,'提交申请 ≠ 权限已经生效',34)
    elif sid == 'c1-s02-a':
        p.beat('账户与工作区','沿身份到仓库的路径定位')
        for x,txt in [(90,'账户'),(420,'工作区'),(800,'目标仓库')]:
            p.line(x,105,x+230,105);p.label(x+115,75,txt,35)
        p.arrow(330,105,400,105);p.arrow(670,105,775,105)
        p.beat('对应仓库','用仓库全名定位，突出目标')
        p.rect(810,155,710,195);p.label(865,215,'所属人 / 仓库全名',32,anchor='start')
        p.line(865,248,1460,248,GRAY,3);p.label(865,305,'进入该仓库的评审设置',31,anchor='start')
        p.ellipse(650,245,58,58,GREEN);p.line(690,290,735,335,GREEN,7)
        p.beat('仓库找不到','缺失时回查三项授权前置')
        p.label(325,240,'找不到仓库？',36)
        for yy,txt in [(295,'账户连接'),(350,'仓库勾选'),(405,'组织批准')]:p.label(325,yy,txt,31)
        p.note(1150,435,'路径示意；以登录后的真实页面为准',27)
    elif sid == 'c1-s02-b':
        p.beat('自动评审策略','先看仓库策略')
        p.rect(80,100,370,235);p.label(265,160,'仓库策略',38);p.label(265,220,'是否启用自动评审',28)
        p.beat('个人偏好','继承个人偏好时要继续核对')
        p.line(500,210,530,210);p.line(515,195,515,225)
        p.rect(580,100,420,235);p.label(790,160,'个人偏好',38);p.label(790,220,'仓库跟随时继续检查',28)
        p.beat('触发事件','把触发条件接到实际事件')
        p.line(1050,210,1080,210);p.line(1065,195,1065,225)
        p.path('M1140 100 L1580 100 L1530 335 L1190 335 Z',GREEN)
        p.label(1360,160,'实际触发条件',36);p.label(1360,220,'谁的 PR · 什么事件',28)
        p.label(830,425,'三个问题：哪个仓库？谁的请求？什么事件？',34,GREEN)
    elif sid == 'c1-s03-a':
        p.beat('什么情况','从触发条件开始追问')
        p.path('M80 125 L175 40 L270 125 L175 210 Z');p.label(175,135,'触发',32)
        p.beat('用户会受到','把代码发现落到用户影响')
        p.arrow(290,125,500,125);p.person(600,75,'用户影响')
        p.beat('实际证据','证据必须指向真实调用路径')
        p.arrow(690,170,900,240);p.doc(940,170,170,165,'调用证据')
        p.beat('怎样复现','把问题写成可重复验证的场景')
        p.arrow(1130,260,1290,260);p.rect(1330,205,230,140,GREEN)
        p.label(1445,260,'复现动作',32);p.label(1445,310,'可验证预期',27)
        p.note(810,440,'能沿证据复现，再决定是否属于本轮直接缺陷',31)
    elif sid == 'c1-s03-a2':
        p.beat('授权页能打开','入口可达只证明第一步')
        p.path('M55 305 L55 75 L235 75 L235 305');p.ellipse(195,190,7,7);p.label(145,355,'授权入口',30)
        p.beat('凭据生成','沿凭据生成到保存继续追踪')
        p.arrow(255,190,370,190);p.ellipse(440,145,33,33);p.line(440,178,440,255);p.line(440,225,472,225);p.line(440,245,462,245);p.label(440,355,'生成凭据',30)
        p.arrow(495,190,630,190);p.ellipse(745,95,75,25);p.path('M670 95 L670 270 Q745 320 820 270 L820 95');p.label(745,355,'保存 / 读回',30)
        p.beat('消费端不接受','在真实失败的消费环节定位断点')
        p.arrow(850,190,980,190);p.path('M1030 80 L1180 80 L1180 290 L1030 290 Z');p.label(1105,355,'消费端',30)
        p.line(1215,170,1260,210,RED,6);p.line(1215,210,1260,170,RED,6)
        p.beat('用户仍会失败','探测结果也要核实，不能用入口代替整链')
        p.line(1290,190,1380,190,GRAY);p.ellipse(1460,180,68,68);p.path('M1410 180 L1440 180 L1455 145 L1475 215 L1490 180 L1520 180',GREEN)
        p.label(1460,355,'探测请求',30);p.note(840,445,'历史链路示意；红色断点不代表当前版本已复现',28)
    elif sid == 'c1-s03-b':
        p.beat('分成三类','三类建议先分流')
        p.doc(65,135,130,160,'评审意见');p.line(220,210,330,210)
        p.path('M330 210 L330 60 L440 60');p.path('M330 210 L440 210');p.path('M330 210 L330 370 L440 370')
        p.beat('直接违反','A类进入本轮修复')
        p.path('M470 25 L730 25 L730 95 L470 95 Z',GREEN);p.label(600,72,'A 直接缺陷',31);p.arrow(755,60,1010,60,GREEN);p.label(1260,72,'本轮修复与复测',34,GREEN)
        p.beat('扩大范围','B类记后续债务，不扩当前需求')
        p.path('M470 175 L730 175 L730 245 L470 245 Z');p.label(600,222,'B 扩大范围',31);p.arrow(755,210,1010,210);p.label(1260,222,'登记后续事项',34)
        p.beat('推测','C类保留判断依据')
        p.path('M470 335 L730 335 L730 405 L470 405 Z',GRAY);p.label(600,382,'C 推测变体',31);p.arrow(755,370,1010,370,GRAY);p.label(1260,382,'证据不足，说明理由',34)
    elif sid == 'c1-s03-c':
        p.beat('修复','把发现转成修复动作')
        p.label(430,115,'发现',40);p.label(1130,115,'修复',40)
        p.path('M530 100 C690 15 920 15 1030 100',GREEN);p.path('M1000 80 L1030 100 L1000 110',GREEN)
        p.beat('测试','修复后先跑相关测试')
        p.label(1130,370,'相关测试',40);p.path('M1220 140 C1360 210 1340 300 1220 345',GREEN);p.path('M1230 315 L1220 345 L1250 342',GREEN)
        p.beat('最新提交','对最新提交重新评审')
        p.label(430,370,'最新提交复审',40);p.path('M1040 390 C900 465 650 465 520 390',GREEN);p.path('M540 415 L520 390 L550 388',GREEN)
        p.beat('继续这个闭环','仍有直接缺陷就回到循环')
        p.path('M330 315 C195 265 205 195 330 140');p.path('M305 143 L330 140 L322 166')
        p.rect(625,185,360,110);p.label(805,250,'同一目标 · 新版本',34)
    elif sid == 'c1-s03-d':
        p.beat('最新','完成条件先核对被审版本')
        p.line(140,55,140,405,GRAY);p.line(1540,55,1540,405,GRAY)
        p.rect(160,75,40,40);p.label(250,108,'最新提交的评审实际完成',38,anchor='start');p.line(940,95,1520,95)
        p.beat('P0','开放严重问题必须归零')
        p.rect(160,195,40,40);p.label(250,228,'开放 P0 / P1 = 0',38,anchor='start');p.line(940,215,1520,215,GREEN)
        p.beat('复测','保留修复后的测试证据')
        p.rect(160,315,40,40);p.label(250,348,'原问题与受影响路径有复测证据',36,anchor='start');p.line(1080,335,1520,335)
        p.note(840,455,'完成条件清单；空框不表示本轮已经通过',30)
    elif sid == 'c1-s04-a':
        p.beat('分析','趋势与具体问题分开查')
        p.path('M100 340 L100 80');p.path('M100 340 L670 340')
        p.path('M140 265 L245 215 L345 255 L460 145 L580 170 L650 105',GREEN)
        p.label(400,410,'分析页：数量与趋势',34);p.note(400,60,'形状示意，非实际账户数据',24)
        p.beat('某个问题','PR里查具体版本与发现')
        p.doc(940,65,470,265)
        p.label(1175,115,'PR · 版本 · 发现',34)
        p.ellipse(1430,280,65,65,GREEN);p.line(1478,328,1545,395,GREEN,7)
        p.label(1220,435,'具体问题回到 PR 核对',34)
    elif sid == 'c1-s04-c':
        p.beat('评论','先看原始发现，不直接相加当缺陷')
        for x,y in [(80,80),(125,115),(170,150)]:p.doc(x,y,120,135)
        p.label(190,355,'每轮评论',32)
        p.beat('去重','把同一问题归并')
        p.arrow(335,205,460,205)
        p.path('M500 65 L770 65 L690 205 L690 280 L580 320 L580 205 Z',GREEN)
        p.label(635,385,'去重 + 确认有效',32)
        p.beat('开放','按处理和复测状态查当前开放')
        p.arrow(795,205,945,205);p.rect(985,65,550,290)
        p.label(1095,125,'有效问题',31);p.line(1195,95,1195,325,GRAY)
        p.label(1365,125,'当前状态',31);p.label(1365,205,'开放 / 待验收',29);p.label(1365,285,'已复测关闭',29)
        p.note(850,455,'评论数量 ≠ 有效缺陷数量 ≠ 当前开放数量',31)
    elif sid == 'c1-s04-pause':
        p.beat('','在自己的PR上复述闭环')
        p.rect(115,35,980,405);p.line(200,35,200,440,GREEN)
        for yy,txt in [(110,'选择自己的 PR 与目标版本'),(195,'说明怎样触发评审'),(280,'找到发现、修复和复测'),(365,'用最新评审说明完成条件')]:
            p.rect(240,yy-25,27,27);p.label(300,yy,txt,34,anchor='start')
        p.beat('','停下来练习，不自动判为通过')
        p.line(1280,120,1280,250,GREEN,18);p.line(1340,120,1340,250,GREEN,18)
        p.label(1310,330,'暂停，交给 Agent 做',31)
    else:
        return False
    return True


def normalized(value):
    return re.sub(r'[^\w\u3400-\u9fff]', '', value).lower()


def make_diagram(scene, captions, duration):
    p=Pen(scene['id'])
    if not chapter_one(p,scene['id']):
        from storyboard_chapter2 import draw as chapter_two
        if not chapter_two(p,scene['id']):
            raise ValueError('No authored storyboard for '+scene['id'])
    # Captions are local to this scene and retain the measured original timing.
    joined='';spans=[]
    for c in captions:
        text=normalized(c['text']);spans.append((len(joined),len(joined)+len(text),c));joined+=text
    last=0
    for i,beat in enumerate(p.beats):
        cue=normalized(beat['cue']);index=joined.find(cue) if cue else -1
        at=None
        if index>=0:
            for lo,hi,c in spans:
                if lo<=index<hi:
                    at=float(c['start'])+(float(c['end'])-float(c['start']))*(index-lo)/max(1,hi-lo)
                    break
        if at is None:
            at=.65+i*max(1,duration-7)/max(1,len(p.beats))
        if i==0:at=min(at,1.0)
        at=max(last, min(at, max(.65,duration-6)))
        beat.update({'at':round(at,3),'alignment':'caption_cue' if index>=0 else 'visual_pacing'})
        last=at
    geometry=[s['d'] for s in p.strokes]
    return {'markup':''.join(p.elements),'beats':p.beats,'geometry_sha256':hashlib.sha256(json.dumps(geometry).encode()).hexdigest(),'stroke_count':len(p.strokes),'scene_id':scene['id']}
