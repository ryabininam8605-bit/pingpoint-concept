"""Export only public demo pages/assets for GitHub Pages, never database or server files."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '_site'
MARKER = '.pingpoint-preview-build'


def build():
    # Only clean this script's own fixed output, never another resolved directory.
    if OUT.is_symlink() or OUT.resolve() != ROOT / '_site':
        raise RuntimeError('Unsafe preview output path')
    if OUT.exists():
        if not (OUT / MARKER).is_file():
            raise RuntimeError('Refusing to replace an unowned _site directory')
        shutil.rmtree(OUT)
    OUT.mkdir()
    (OUT / MARKER).write_text('Generated public demo only', encoding='utf-8')
    allowed = {'.html', '.css', '.js', '.jpg', '.jpeg', '.png', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf'}
    for directory in ['1-neon', 'img']:
        for source in (ROOT / directory).rglob('*'):
            if not source.is_file() or source.suffix.lower() not in allowed or source.is_symlink():
                continue
            relative = source.relative_to(ROOT)
            if any(part.startswith('.') for part in relative.parts):
                continue
            target = OUT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix == '.html':
                prefix = '../' * len(relative.parent.parts)
                html = source.read_text(encoding='utf-8')
                html = html.replace('<head>', '<head><script src="' + prefix + 'preview-api.js" data-public-preview="1"></script>', 1)
                html = html.replace('<title>', '<title>Демо · ', 1)
                target.write_text(html, encoding='utf-8')
            else:
                shutil.copyfile(source, target)
    for name in ['index.html', 'preview-api.js', 'demo-qr.svg']:
        shutil.copyfile(ROOT / 'preview' / name, OUT / name)
    (OUT / '.nojekyll').touch()
    print('Public preview built in _site (no server, secrets or database)')


if __name__ == '__main__':
    build()
