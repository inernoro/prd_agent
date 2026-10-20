"""Guard the repeated-template regression and narration/drawing contracts."""
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/testing-tutorial'))
from storyboard_diagrams import make_diagram, normalized


class TutorialStoryboards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec=json.loads((ROOT/'scripts/testing-tutorial/production.json').read_text())
        cls.scenes=[s for seg in spec['segments'] for s in seg['scenes']
                    if not s.get('asset_candidates') and s['kind']!='prompt']

    def drawing(self,scene):
        captions=[{'text':scene['voice'],'start':.7,'end':27}] if scene['voice'] else []
        return make_diagram(scene,captions,32 if scene['voice'] else 12)

    def test_different_lessons_do_not_share_the_same_geometry(self):
        # This fails for the previous generator, which changed labels only.
        hashes={}
        for scene in self.scenes:
            h=self.drawing(scene)['geometry_sha256']
            self.assertNotIn(h,hashes,f"Repeated geometry: {scene['id']} / {hashes.get(h)}")
            hashes[h]=scene['id']

    def test_each_narration_beat_has_a_literal_cue_and_monotonic_time(self):
        for scene in self.scenes:
            drawing=self.drawing(scene)
            times=[b['at'] for b in drawing['beats']]
            self.assertEqual(times,sorted(times),scene['id'])
            self.assertGreaterEqual(len(times),2)
            for b in drawing['beats']:
                if scene['voice']:
                    self.assertTrue(b['cue'],scene['id'])
                    self.assertIn(normalized(b['cue']),normalized(scene['voice']))
                    self.assertEqual(b['alignment'],'caption_cue',scene['id'])

    def test_every_label_anchor_exists_and_each_stroke_has_one_pen_down(self):
        for scene in self.scenes:
            drawing=self.drawing(scene)
            svg=ET.fromstring('<svg>'+drawing['markup']+'</svg>')
            paths=svg.findall('path');ids={p.attrib['id'] for p in paths}
            self.assertEqual(len(ids),len(paths))
            for p in paths:
                self.assertEqual(sum(c in 'Mm' for c in p.attrib['d']),1)
                self.assertLess(int(p.attrib['data-beat']),len(drawing['beats']))
            for g in svg.findall('g'):
                if 'data-after-stroke' in g.attrib:
                    self.assertIn(g.attrib['data-after-stroke'],ids)
                else:
                    self.assertIn('data-beat',g.attrib)

    def test_unknown_scene_is_rejected_instead_of_using_a_generic_template(self):
        with self.assertRaisesRegex(ValueError,'No authored storyboard'):
            make_diagram({'id':'unknown','voice':'new lesson'},[],30)


if __name__=='__main__':
    unittest.main()
