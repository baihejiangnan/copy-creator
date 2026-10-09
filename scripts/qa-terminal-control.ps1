param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$Metadata)
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
$directoryPath=[IO.Path]::GetFullPath($Directory)
if(-not $directoryPath.StartsWith((Join-Path $qaRoot 'terminal-fixtures')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Expected isolated terminal fixture'}
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $qaRoot 'process.json')){throw 'Expected QA metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
$qa=Get-Process -Id $info.pid
if($info.identifier -ne 'com.copycreator.qa20261007' -or $qa.Path -ne $info.exe -or (Get-FileHash -LiteralPath $qa.Path -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA process identity mismatch'}
$ready=Get-Content -LiteralPath (Join-Path $directoryPath 'ready.json') -Raw | ConvertFrom-Json
if($ready.token -ne (Split-Path $directoryPath -Leaf) -or -not(Get-Process -Id $ready.pid -ErrorAction SilentlyContinue)){throw 'Owned receiver missing'}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QaTerminalControl {
 public delegate bool Callback(IntPtr hwnd,IntPtr value);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr value);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder value,int length);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("user32.dll")] static extern bool PeekMessage(out Message msg,IntPtr hwnd,uint min,uint max,uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct Message {public IntPtr hwnd;public uint message;public UIntPtr wParam;public IntPtr lParam;public uint time;public int x,y;public uint extra;}
 [StructLayout(LayoutKind.Sequential)] public struct Gui {public uint size,flags;public IntPtr active,focus,capture,menu,move,caret;public int left,top,right,bottom;}
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref Gui info);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder value,int length);
 [StructLayout(LayoutKind.Sequential)] public struct KeyInput {public ushort key,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit,Size=32)] public struct Union {[FieldOffset(0)]public KeyInput key;}
 [StructLayout(LayoutKind.Sequential)] public struct Input {public uint type;public Union data;}
 [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] input,int size);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 static Input Key(ushort key,uint flags){return new Input{type=1,data=new Union{key=new KeyInput{key=key,flags=flags}}};}
 public static IntPtr Find(string title){IntPtr found=IntPtr.Zero;EnumWindows((hwnd,value)=>{var text=new StringBuilder(512);GetWindowText(hwnd,text,512);if(text.ToString().Contains(title)){uint pid;GetWindowThreadProcessId(hwnd,out pid);var name=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;if(name=="WindowsTerminal"){found=hwnd;return false;}}return true;},IntPtr.Zero);if(found==IntPtr.Zero)throw new Exception("Owned Terminal window not found");return found;}
 public static string Class(IntPtr hwnd){var text=new StringBuilder(256);GetClassName(hwnd,text,256);return text.ToString();}
 public static Gui Inspect(IntPtr hwnd){uint pid;var info=new Gui{size=(uint)Marshal.SizeOf<Gui>()};if(!GetGUIThreadInfo(GetWindowThreadProcessId(hwnd,out pid),ref info))throw new Exception("GUI thread info unavailable");return info;}
 public static bool Focus(IntPtr hwnd){uint pid;var target=GetWindowThreadProcessId(hwnd,out pid);var current=GetCurrentThreadId();Message message;PeekMessage(out message,IntPtr.Zero,0,0,0);bool attached=target!=current&&AttachThreadInput(current,target,true);try{ShowWindow(hwnd,9);SetForegroundWindow(hwnd);}finally{if(attached)AttachThreadInput(current,target,false);}System.Threading.Thread.Sleep(150);return GetForegroundWindow()==hwnd;}
 public static void Paste(IntPtr owned,bool shift){if(GetForegroundWindow()!=owned)throw new Exception("Owned Terminal is not foreground");foreach(int key in new[]{16,17,18,91,92})if((GetAsyncKeyState(key)&0x8000)!=0)throw new Exception("Physical modifier remains held");var input=shift?new[]{Key(17,0),Key(16,0),Key(86,0),Key(86,2),Key(16,2),Key(17,2)}:new[]{Key(17,0),Key(86,0),Key(86,2),Key(17,2)};if(SendInput((uint)input.Length,input,Marshal.SizeOf<Input>())!=input.Length)throw new Exception("Input injection failed");}
}
'@
$title='CopyCreator terminal QA '+$ready.token
@{ready=$true} | ConvertTo-Json -Compress | ForEach-Object {[Console]::WriteLine($_)}
while($line=[Console]::ReadLine()){
 try{
  $request=$line | ConvertFrom-Json
  $terminal=[QaTerminalControl]::Find($title)
  switch($request.command){
   'focusTerminal' {$focused=[QaTerminalControl]::Focus($terminal)}
   'focusQa' {$qa.Refresh();$focused=[QaTerminalControl]::Focus($qa.MainWindowHandle)}
   'controlPaste' {[QaTerminalControl]::Paste($terminal,[bool]$request.shift);$focused=$true}
   'inspect' {$focused=[QaTerminalControl]::GetForegroundWindow() -eq $terminal}
   default {throw 'Unsupported owned-terminal command'}
  }
  $gui=[QaTerminalControl]::Inspect($terminal)
  @{ok=$true;focused=$focused;window=$terminal.ToInt64();windowClass=[QaTerminalControl]::Class($terminal);focus=$gui.focus.ToInt64();focusClass=[QaTerminalControl]::Class($gui.focus);flags=$gui.flags} | ConvertTo-Json -Compress | ForEach-Object {[Console]::WriteLine($_)}
 }catch{@{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress | ForEach-Object {[Console]::WriteLine($_)}}
}
