"""Summarize an isolated image QA process-tree sample; no user data reads."""
import json
from pathlib import Path
import re
import statistics
import sys

root = Path(__file__).resolve().parents[1] / 'output/optimization/QA-notes-20261007'
name = sys.argv[1]
assert re.fullmatch(r'images-continuous-\d+\.json', name)
source = root / 'reports' / name
report = json.loads(source.read_text(encoding='utf-8'))
memory = Path(report['memoryFile']).resolve()
assert memory.is_relative_to((root / 'image-continuous').resolve())
rows = [json.loads(line) for line in memory.read_text(encoding='utf-8').splitlines()]
phases = []
for phase in dict.fromkeys(row['phase'] for row in rows):
    group = [row for row in rows if row['phase'] == phase]
    if len(group) < 2:
        continue
    first, last = group[0], group[-1]
    elapsed = (last['elapsedMs'] - first['elapsedMs']) / 1000
    start = {p['pid']: p['cpuSeconds'] for p in first['processes']}
    end = {p['pid']: p['cpuSeconds'] for p in last['processes']}
    native = report['app']['pid']
    phases.append({
        'phase': phase, 'samples': len(group), 'seconds': elapsed,
        'treePrivateP50': statistics.median(row['privateBytes'] for row in group),
        'treePrivatePeak': max(row['privateBytes'] for row in group),
        'nativePrivateP50': statistics.median(
            next(p['privateBytes'] for p in row['processes'] if p['pid'] == native)
            for row in group),
        'cpuPercentOfOneCore': 100 * sum(end[p] - start[p] for p in start.keys() & end.keys()) / elapsed,
        'nativeCpuSeconds': end.get(native, 0) - start.get(native, 0),
    })
result = {'sourceReport': name, 'scope': 'Native and WebView descendants; Node driver excluded. CPU counts only PIDs present at both phase endpoints, percent of one core. Private bytes are observations, not a hard budget or matched memory gain. Cleanup is separate.', 'phases': phases}
destination = source.with_name(name.replace('images-continuous-', 'images-continuous-memory-'))
destination.write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result))
