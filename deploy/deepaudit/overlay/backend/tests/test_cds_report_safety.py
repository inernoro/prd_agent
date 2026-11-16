"""Real Jinja rendering and a controlled Weasy boundary; no network or PDF renderer."""
import base64
import importlib.util
import os
import pathlib
import sys
import unittest
from html.parser import HTMLParser
from types import ModuleType
from unittest.mock import Mock, patch

ROOT = pathlib.Path(__file__).resolve().parents[2]


class RenderedHTML(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.resources, self.text = [], []
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        self.resources.extend(value for key, value in attrs if key in ('src', 'href'))

    def handle_data(self, text):
        self.text.append(text)


class ReportSafety(unittest.TestCase):
    def setUp(self):
        self.invocations = []
        owner = self
        class ControlledDocument:
            def write_pdf(self, output, **kwargs):
                output.write(b'controlled-renderer-output')
        def controlled_html(**kwargs):
            owner.invocations.append(kwargs)
            return ControlledDocument()
        modules = {name: ModuleType(name) for name in ('weasyprint', 'weasyprint.urls', 'weasyprint.text', 'weasyprint.text.fonts')}
        self.default_fetch = Mock(return_value={'string': b'fixture-resource', 'mime_type': 'image/png'})
        self.modern_fetch = Mock(return_value=object())
        self.modern_factory = Mock(return_value=type('Fetcher', (), {'fetch': self.modern_fetch})())
        modules['weasyprint'].HTML = controlled_html
        modules['weasyprint'].CSS = object
        modules['weasyprint'].default_url_fetcher = self.default_fetch
        modules['weasyprint.urls'].URLFetcher = self.modern_factory
        modules['weasyprint.text.fonts'].FontConfiguration = object
        self.modules = patch.dict(sys.modules, modules); self.modules.start()
        path = ROOT / 'backend/app/services/report_generator.py'
        spec = importlib.util.spec_from_file_location('cds_report_safety_subject', path)
        subject = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ):
            spec.loader.exec_module(subject)
        self.generator = subject.ReportGenerator
        self.logo = patch.object(self.generator, '_get_logo_base64', return_value=base64.b64encode(b'logo-fixture').decode())
        self.logo.start()

    def tearDown(self):
        self.logo.stop(); self.modules.stop()

    def latest(self):
        return RenderedHTML(self.invocations[-1]['string'])

    def test_instant_and_task_metadata_remain_text_without_external_resource_elements(self):
        payload = '<img src="https://metadata.invalid/probe.png">'
        self.generator.generate_instant_report({'quality_score': 80, 'issues': []}, payload, 1.0)
        parsed = self.latest()
        self.assertTrue(all(value.startswith('data:') for value in parsed.resources))
        self.assertIn(payload, ''.join(parsed.text))
        task = {'id': 'task-id', 'quality_score': 80, 'branch_name': payload}
        self.generator.generate_task_report(task, [], project=payload)
        parsed = self.latest()
        self.assertTrue(all(value.startswith('data:') for value in parsed.resources))
        self.assertIn(payload, ''.join(parsed.text))
        self.default_fetch.assert_not_called()
        self.modern_factory.assert_not_called()

    def test_existing_issue_code_and_paths_escape_once_in_real_template(self):
        code = 'if (a < b && c > 0) print("<&>")'
        issue = {'title': 'literal <title> & value', 'file_path': 'src/<literal>.py',
                 'description': 'a < b & c', 'code_snippet': code, 'line': 1, 'severity': 'high'}
        self.generator.generate_instant_report({'quality_score': 80, 'issues': [issue]}, 'python', 1.0)
        text = ''.join(self.latest().text)
        self.assertIn(code, text)
        self.assertIn(issue['title'], text)
        self.assertIn(issue['file_path'], text)

    def test_pdf_boundary_only_delegates_inline_data_resources(self):
        self.generator.generate_instant_report({'quality_score': 80, 'issues': []}, 'python', 1.0)
        fetch = self.invocations[-1].get('url_fetcher')
        self.assertTrue(callable(fetch), 'PDF renderer must receive an explicit restricted fetcher')
        for url in ('http://127.0.0.1:9/blocked', 'https://metadata.invalid/blocked',
                    'file:///not-a-real-test-file', 'ftp://metadata.invalid/blocked'):
            for operation in (fetch, fetch.fetch):
                with self.subTest(url=url, operation=operation):
                    with self.assertRaises(ValueError): operation(url)
        self.default_fetch.assert_not_called()
        self.modern_factory.assert_not_called()
        inline = 'data:image/png;base64,' + base64.b64encode(b'inline-fixture').decode()
        self.assertEqual(fetch(inline), self.default_fetch.return_value)
        self.default_fetch.assert_called_once_with(inline)
        self.assertIs(fetch.fetch(inline), self.modern_fetch.return_value)
        self.modern_factory.assert_called_once_with(allowed_protocols={'data'}, allow_redirects=False)
        self.modern_fetch.assert_called_once_with(inline, headers=None)


if __name__ == '__main__':
    unittest.main()
