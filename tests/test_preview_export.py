import importlib.util
import tempfile
import unittest
from pathlib import Path


class PreviewExportTest(unittest.TestCase):
    def module(self, root):
        path = Path(__file__).resolve().parents[1] / 'scripts' / 'build_preview.py'
        spec = importlib.util.spec_from_file_location('preview_export', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.ROOT = root
        module.OUT = root / '_site'
        return module

    def test_export_intercepts_api_before_app_and_omits_private_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ['1-neon/docs', 'img', 'preview', '.data']:
                (root / name).mkdir(parents=True)
            (root / '1-neon/cabinet.html').write_text('<html><head><script src="shared-booking.js"></script></head><body></body></html>')
            (root / '1-neon/docs/terms.html').write_text('<html><head></head></html>')
            (root / '1-neon/shared-booking.js').write_text('/* app */')
            (root / 'img/logo.jpg').write_bytes(b'public image')
            for name in ['index.html', 'preview-api.js', 'demo-qr.svg']:
                (root / 'preview' / name).write_text('public preview')
            for name in ['.env', 'server.py', '.data/bookings.sqlite3', '1-neon/secret.json']:
                (root / name).write_text('must not be published')
            module = self.module(root)
            module.build()
            html = (module.OUT / '1-neon/cabinet.html').read_text(encoding='utf-8')
            self.assertLess(html.index('preview-api.js'), html.index('shared-booking.js'))
            self.assertIn('../../preview-api.js', (module.OUT / '1-neon/docs/terms.html').read_text())
            self.assertEqual((module.OUT / 'img/logo.jpg').read_bytes(), b'public image')
            for name in ['.env', 'server.py', '.data/bookings.sqlite3', '1-neon/secret.json']:
                self.assertFalse((module.OUT / name).exists(), name)

    def test_export_refuses_to_replace_unowned_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            out = root / '_site'
            out.mkdir()
            (out / 'keep.txt').write_text('user file')
            with self.assertRaises(RuntimeError):
                self.module(root).build()
            self.assertEqual((out / 'keep.txt').read_text(), 'user file')
