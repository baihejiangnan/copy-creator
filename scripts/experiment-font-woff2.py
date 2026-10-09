"""Full repertoire, lossless table experiment; never changes app/public resources."""
from pathlib import Path
import hashlib
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'output/optimization/font-tools-runtime-20261008'
sys.path.insert(0, str(RUNTIME))
from fontTools.ttLib import TTFont, woff2
import fontTools
import brotli

DEST = ROOT / 'output/optimization/font-woff2-standard-20261008'
if DEST.exists():
    raise ValueError('Refusing to overwrite a preserved font experiment')
DEST.mkdir()
names = ['PingFang Light.ttf', 'PingFang Regular.ttf', 'PingFang Medium.ttf', 'PingFang Semibold.ttf', 'SF-Pro-Display-Black.otf']
report = {'scope': 'All five exact published fonts, full repertoire, no subsetting or outline/metric/layout transformations. WOFF2-required DSIG removal and head bit 11/checksum changes validated separately. App resources unchanged.',
          'fonttools': fontTools.__version__, 'brotli': brotli.__version__, 'fonts': []}
def digest(data):
    return hashlib.sha256(data).hexdigest()

for name in names:
    original = ROOT / 'copy-creator/public/字体' / name
    compressed = DEST / (original.stem + '.woff2')
    restored = DEST / ('roundtrip-' + name)
    start = time.perf_counter()
    woff2.compress(str(original), str(compressed), transform_tables=set())
    compressed_seconds = time.perf_counter() - start
    start = time.perf_counter()
    woff2.decompress(str(compressed), str(restored))
    decompressed_seconds = time.perf_counter() - start
    left, right = TTFont(original, lazy=True), TTFont(restored, lazy=True)
    removed = set(left.reader.keys()) - set(right.reader.keys())
    assert removed <= {'DSIG'} and not (set(right.reader.keys()) - set(left.reader.keys())), 'Unexpected table set change'
    comparisons = {}
    for tag in left.reader.keys():
        if tag == 'DSIG':
            # W3C WOFF2 requires removal because sfnt repacking invalidates signatures.
            comparisons[tag] = {'removedPerWoff2Standard': True, 'bytes': len(left.reader[tag]), 'sourceSha256': digest(left.reader[tag])}
            continue
        old, new = left.reader[tag], right.reader[tag]
        if tag == 'head':
            # Repacking changes only the sfnt whole-file checksum adjustment.
            old, new = old[:8] + bytes(4) + old[12:], new[:8] + bytes(4) + new[12:]
            assert int.from_bytes(new[16:18], 'big') == int.from_bytes(old[16:18], 'big') | (1 << 11)
            old, new = old[:16] + (int.from_bytes(old[16:18], 'big') | (1 << 11)).to_bytes(2, 'big') + old[18:], new
        comparisons[tag] = {'equal': old == new, 'sha256': digest(old), 'bytes': len(old)}
        assert old == new, 'Font table changed: ' + tag
    assert left.getBestCmap() == right.getBestCmap()
    assert left.getGlyphOrder() == right.getGlyphOrder()
    item = {'name': name, 'sourceSha256': digest(original.read_bytes()), 'woff2Sha256': digest(compressed.read_bytes()),
            'originalBytes': original.stat().st_size, 'woff2Bytes': compressed.stat().st_size,
            'compressSeconds': compressed_seconds, 'decompressSeconds': decompressed_seconds,
            'mappedCharacters': len(left.getBestCmap()), 'glyphs': len(left.getGlyphOrder()), 'tables': comparisons}
    left.close(); right.close()
    report['fonts'].append(item)
    (DEST / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({key: value for key, value in item.items() if key != 'tables'}), flush=True)
report['originalBytes'] = sum(f['originalBytes'] for f in report['fonts'])
report['woff2Bytes'] = sum(f['woff2Bytes'] for f in report['fonts'])
report['passed'] = True
(DEST / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'originalBytes': report['originalBytes'], 'woff2Bytes': report['woff2Bytes'], 'report': str(DEST / 'report.json')}), flush=True)
