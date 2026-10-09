"""Sample only the verified isolated QA process and its descendants."""
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
from pathlib import Path
import sys
import time

metadata, output, phase_path, stop_path = map(Path, sys.argv[1:5])
duration_limit = int(sys.argv[5]) if len(sys.argv) > 5 else 180
assert 30 <= duration_limit <= 600
scope = Path(__file__).resolve().parents[1] / 'output' / 'optimization' / 'QA-notes-20261007'
baseline = Path(__file__).resolve().parents[1] / 'output' / 'optimization' / 'baseline-runtime-20261008'
expected_identifier = 'com.copycreator.qa20261007'
if metadata.resolve() == (baseline / 'process.json').resolve():
    scope, expected_identifier = baseline, 'com.copycreator.qabaseline20261008v2'
for file in (metadata, output, phase_path, stop_path):
    assert file.resolve().is_relative_to(scope.resolve())
info = json.loads(metadata.read_text(encoding='utf-8-sig'))
assert info['identifier'] == expected_identifier
assert hashlib.sha256(Path(info['exe']).read_bytes()).hexdigest().upper() == info['sha256']
k = c.WinDLL('kernel32', use_last_error=True)
ps = c.WinDLL('psapi', use_last_error=True)
class Entry(c.Structure):
    _fields_ = [('size',w.DWORD),('usage',w.DWORD),('pid',w.DWORD),('heap',c.c_size_t),('module',w.DWORD),('threads',w.DWORD),('parent',w.DWORD),('priority',w.LONG),('flags',w.DWORD),('exe',w.WCHAR*260)]
class Memory(c.Structure):
    _fields_ = [('size',w.DWORD),('faults',w.DWORD)] + [(name,c.c_size_t) for name in ('peakWS','ws','peakPaged','paged','peakNonpaged','nonpaged','pagefile','peakPagefile','private')]
k.CreateToolhelp32Snapshot.restype=w.HANDLE
k.Process32FirstW.argtypes=[w.HANDLE,c.POINTER(Entry)]
k.Process32NextW.argtypes=[w.HANDLE,c.POINTER(Entry)]
k.OpenProcess.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenProcess.restype=w.HANDLE
k.QueryFullProcessImageNameW.argtypes=[w.HANDLE,w.DWORD,w.LPWSTR,c.POINTER(w.DWORD)]
k.CloseHandle.argtypes=[w.HANDLE]
ps.GetProcessMemoryInfo.argtypes=[w.HANDLE,c.POINTER(Memory),w.DWORD]
k.GetProcessTimes.argtypes=[w.HANDLE,c.POINTER(w.FILETIME),c.POINTER(w.FILETIME),c.POINTER(w.FILETIME),c.POINTER(w.FILETIME)]
def ancestry():
    handle=k.CreateToolhelp32Snapshot(2,0)
    assert handle != c.c_void_p(-1).value
    entry=Entry();entry.size=c.sizeof(entry); rows={}
    try:
        ok=k.Process32FirstW(handle,c.byref(entry))
        while ok:
            rows[entry.pid]=(entry.parent,entry.exe)
            ok=k.Process32NextW(handle,c.byref(entry))
    finally:k.CloseHandle(handle)
    owned={info['pid']}
    while True:
        added={pid for pid,(parent,_) in rows.items() if parent in owned}-owned
        if not added:break
        owned|=added
    return {pid:rows[pid][1] for pid in owned if pid in rows}
started=time.perf_counter()
with output.open('x',encoding='utf-8') as report:
    print(json.dumps({'ready':True}),flush=True)
    while not stop_path.exists() and time.perf_counter()-started < duration_limit:
        rows=[]
        for pid,name in ancestry().items():
            handle=k.OpenProcess(0x410,False,pid)
            if not handle:continue
            try:
                if pid==info['pid']:
                    text=c.create_unicode_buffer(32768);size=w.DWORD(len(text))
                    assert k.QueryFullProcessImageNameW(handle,0,text,c.byref(size))
                    assert Path(text.value).resolve()==Path(info['exe']).resolve()
                memory=Memory();memory.size=c.sizeof(memory)
                if not ps.GetProcessMemoryInfo(handle,c.byref(memory),c.sizeof(memory)):continue
                times=[w.FILETIME() for _ in range(4)]
                assert k.GetProcessTimes(handle,*[c.byref(value) for value in times])
                cpu=sum((value.dwHighDateTime<<32)+value.dwLowDateTime for value in times[2:])/1e7
                rows.append({'pid':pid,'name':name,'privateBytes':memory.private,'workingSet':memory.ws,'cpuSeconds':cpu})
            finally:k.CloseHandle(handle)
        phase=phase_path.read_text(encoding='utf-8') if phase_path.exists() else 'startup'
        report.write(json.dumps({'elapsedMs':round((time.perf_counter()-started)*1000,3),'phase':phase,'processes':rows,'privateBytes':sum(row['privateBytes'] for row in rows),'workingSet':sum(row['workingSet'] for row in rows)})+'\n');report.flush()
        time.sleep(.1)
