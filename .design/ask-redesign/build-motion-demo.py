#!/usr/bin/env python3
"""从 Motion.dc.html 生成独立可打开的 motion-demo.html。

为什么要生成而不是手写第二份：两份会漂。动效参数一改，画布上那块和发给人看的
那份就对不上了，而「对不上」在动效里几乎看不出来 —— 只会觉得「怎么手感有点不一样」。
样式与舞台结构一律从 Motion.dc.html 抽，这个脚本只负责套一层控制栏。
"""
import re, sys, pathlib

here = pathlib.Path(__file__).parent
src = (here / 'Motion.dc.html').read_text(encoding='utf-8')
style = re.search(r'<style>(.*?)</style>', src, re.S).group(1)
i, j = src.index('<div class="stage">'), src.index('<div class="track">')
stage_html = src[i:j].rstrip()

shell = (here / 'motion-demo.shell.html').read_text(encoding='utf-8')
out = shell.replace('/*__STYLE__*/', style).replace('<!--__STAGE__-->', stage_html)
(here / 'motion-demo.html').write_text(out, encoding='utf-8')
print('motion-demo.html 已生成，', len(out), 'bytes')
