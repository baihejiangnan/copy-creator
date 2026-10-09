param([Parameter(Mandatory=$true)][string]$Metadata)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $root 'process.json')){throw 'Expected exact QA metadata'}
$info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
if($info.identifier -ne 'com.copycreator.qa20261007'){throw 'Expected isolated QA identifier'}
$qaProcess=Get-Process -Id $info.pid
if($qaProcess.Path -ne $info.exe -or (Get-FileHash -LiteralPath $qaProcess.Path -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA identity mismatch'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class QaDesktopInput {
 public static System.Threading.Tasks.Task<string> ReadCommand(){return System.Threading.Tasks.Task.Run(()=>Console.ReadLine());}
 public delegate bool Callback(IntPtr hwnd,IntPtr value);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr value);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
 [StructLayout(LayoutKind.Sequential)] public struct GuiInfo {public uint size,flags;public IntPtr active,focus,capture,menu,move,caret;public int left,top,right,bottom;}
 [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiInfo info);
 public static uint GuiFlags(IntPtr window){uint pid;var info=new GuiInfo{size=(uint)Marshal.SizeOf<GuiInfo>()};return GetGUIThreadInfo(GetWindowThreadProcessId(window,out pid),ref info)?info.flags:uint.MaxValue;}
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll")] static extern bool EmptyClipboard();
 [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format,IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags,UIntPtr bytes);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr handle);
 static void OpenSynthetic(IntPtr owner){for(int i=0;i<80;i++){if(OpenClipboard(owner))return;System.Threading.Thread.Sleep(25);}throw new Exception("Synthetic clipboard busy");}
 public static bool ClipboardMatches(IntPtr owner,string expected){OpenSynthetic(owner);try{var handle=GetClipboardData(13);if(handle==IntPtr.Zero)return false;var data=GlobalLock(handle);if(data==IntPtr.Zero)return false;try{return Marshal.PtrToStringUni(data)==expected;}finally{GlobalUnlock(handle);}}finally{CloseClipboard();}}
 [DllImport("user32.dll")] static extern IntPtr GetOpenClipboardWindow();
 // Observe only: opening the clipboard here could itself disturb Ctrl+V.
 // Zero means no opener window observed, not a guarantee of availability.
 static uint lastExternalOpenerPid=0;
 public static void ResetOpener(){lastExternalOpenerPid=0;}
 public static int ClipboardOpener(uint qaPid){var owner=GetOpenClipboardWindow();if(owner==IntPtr.Zero)return 0;uint pid;GetWindowThreadProcessId(owner,out pid);if(pid==qaPid)return 1;if(pid==(uint)System.Diagnostics.Process.GetCurrentProcess().Id)return 2;lastExternalOpenerPid=pid;return 3;}
 // Resolve metadata after input handling, without opening the clipboard or
 // exporting arbitrary process names, paths, command lines or window titles.
 public static string ExternalOpenerKind(){if(lastExternalOpenerPid==0)return "none-observed";try{var name=System.Diagnostics.Process.GetProcessById((int)lastExternalOpenerPid).ProcessName.ToLowerInvariant();if(name=="copy-creator-0.2.24-portable")return "existing-copy-creator";if(name=="explorer"||name=="textinputhost"||name=="ctfmon"||name=="runtimebroker"||name=="rdpclip")return "windows-shell-input-clipboard";if(name=="powershell"||name=="pwsh")return "external-powershell";if(name=="ditto"||name=="clibor"||name=="powertoys.advancedpaste")return "other-clipboard-utility";if(name=="codex")return "codex-app";return "other-process";}catch{return "process-unavailable";}}
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormatW(string name);
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern uint DragQueryFileW(IntPtr drop,uint index,StringBuilder filename,uint length);
 public static bool SyntheticImageMatches(IntPtr owner,string expectedDirectory){OpenSynthetic(owner);try{var dib=GetClipboardData(8);if(dib==IntPtr.Zero||GetClipboardData(RegisterClipboardFormatW("PNG"))==IntPtr.Zero||GetClipboardData(RegisterClipboardFormatW("HTML Format"))==IntPtr.Zero||GetClipboardData(15)==IntPtr.Zero)return false;var data=GlobalLock(dib);if(data==IntPtr.Zero)return false;try{var file=new StringBuilder(32768);DragQueryFileW(GetClipboardData(15),0,file,(uint)file.Capacity);if(!file.ToString().StartsWith(expectedDirectory+System.IO.Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||!System.IO.File.Exists(file.ToString()))return false;return Marshal.ReadInt32(data,4)==1&&Marshal.ReadInt32(data,8)==-1&&Marshal.ReadByte(data,40)==31&&Marshal.ReadByte(data,41)==47&&Marshal.ReadByte(data,42)==223&&Marshal.ReadByte(data,43)==255;}finally{GlobalUnlock(dib);}}finally{CloseClipboard();}}
 public static bool FileMatches(IntPtr owner,string expected){OpenSynthetic(owner);try{var drop=GetClipboardData(15);if(drop==IntPtr.Zero||DragQueryFileW(drop,0xffffffff,null,0)!=1)return false;var value=new StringBuilder(32768);DragQueryFileW(drop,0,value,(uint)value.Capacity);return value.ToString()==expected;}finally{CloseClipboard();}}
 public static void WriteSynthetic(IntPtr owner,string value){if(!value.StartsWith("QA controlled clipboard ")||value.Length>262144)throw new Exception("Only synthetic text allowed");var bytes=Encoding.Unicode.GetBytes(value+"\0");var handle=GlobalAlloc(2,(UIntPtr)bytes.Length);if(handle==IntPtr.Zero)throw new Exception("Allocation failed");var pointer=GlobalLock(handle);if(pointer==IntPtr.Zero){GlobalFree(handle);throw new Exception("Lock failed");}try{Marshal.Copy(bytes,0,pointer,bytes.Length);}finally{GlobalUnlock(handle);}bool transferred=false;try{OpenSynthetic(owner);try{if(!EmptyClipboard()||SetClipboardData(13,handle)==IntPtr.Zero)throw new Exception("Synthetic write failed");transferred=true;}finally{CloseClipboard();}}finally{if(!transferred)GlobalFree(handle);}}
 public static void FocusOwned(IntPtr expected,int settleMilliseconds=100){
  if(settleMilliseconds!=0&&settleMilliseconds!=100)throw new Exception("Expected bounded focus control");
  uint owner;uint target=GetWindowThreadProcessId(expected,out owner),current=GetCurrentThreadId(),foreground=GetWindowThreadProcessId(GetForegroundWindow(),out owner);
  bool attachedForeground=false,attachedTarget=false;
  try {if(foreground!=0&&foreground!=current)attachedForeground=AttachThreadInput(current,foreground,true);if(target!=current&&target!=foreground)attachedTarget=AttachThreadInput(current,target,true);ShowWindow(expected,9);BringWindowToTop(expected);SetForegroundWindow(expected);}
  finally{if(attachedTarget)AttachThreadInput(current,target,false);if(attachedForeground)AttachThreadInput(current,foreground,false);}
  System.Threading.Thread.Sleep(settleMilliseconds);RequireForeground(expected);
 }
 [StructLayout(LayoutKind.Sequential)] public struct Keyboard {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct Mouse {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] public struct Data {[FieldOffset(0)] public Keyboard key;[FieldOffset(0)] public Mouse mouse;}
 [StructLayout(LayoutKind.Sequential)] public struct Input {public uint type;public Data data;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] input,int size);
 public static IntPtr Main(uint pid){
  IntPtr found=IntPtr.Zero;int count=0;EnumWindows((hwnd,value)=>{uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner==pid){var title=new StringBuilder(256);GetWindowText(hwnd,title,256);if(title.ToString()=="Copy Creator"){found=hwnd;count++;}}return true;},IntPtr.Zero);
  if(count!=1)throw new Exception("Expected one owned QA main window");return found;
 }
 public static void RequireForeground(IntPtr expected){if(GetForegroundWindow()!=expected)throw new Exception("Refusing input outside the exact synthetic target");}
 static void Send(Input value){if(SendInput(1,new[]{value},Marshal.SizeOf<Input>())!=1)throw new Exception("Native input dispatch failed");}
 public static void Key(ushort vk,bool up){Send(new Input{type=1,data=new Data{key=new Keyboard{vk=vk,flags=up?2u:0u}}});}
 public static void ClickKey(ushort vk){Key(vk,false);Key(vk,true);}
 public static void TypeLatin(IntPtr expected,string text){if(text!="zhongwen"&&text!="ceshi"&&text!="zhong")throw new Exception("Only predefined IME fixture keystrokes allowed");foreach(char letter in text){RequireForeground(expected);ClickKey((ushort)char.ToUpperInvariant(letter));System.Threading.Thread.Sleep(35);}}
 static readonly object ControlGate=new object();
 static bool ownedControl=false;
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")] static extern short GetKeyState(int key);
 public static int ModifierMask(bool asynchronous){int result=0;int[] keys={0x11,0x10,0x12};for(int i=0;i<keys.Length;i++){if(((asynchronous?GetAsyncKeyState(keys[i]):GetKeyState(keys[i]))&0x8000)!=0)result|=1<<i;}return result;}
 public static void HoldControl(IntPtr expected,int milliseconds){RequireForeground(expected);if(milliseconds<300||milliseconds>450)throw new Exception("Bounded synthetic modifier only");lock(ControlGate){if(ownedControl||(GetAsyncKeyState(0x11)&0x8000)!=0)throw new Exception("Refusing to replace an existing Ctrl press");Key(0x11,false);ownedControl=true;}System.Threading.Tasks.Task.Run(()=>{System.Threading.Thread.Sleep(milliseconds);ReleaseControl();});}
 public static void ReleaseControl(){lock(ControlGate){if(ownedControl){Key(0x11,true);ownedControl=false;}}}
 public static void ToggleMainFromFixture(IntPtr expected){RequireForeground(expected);try{Key(0x11,false);Key(0x10,false);Send(new Input{type=0,data=new Data{mouse=new Mouse{flags=8}}});Send(new Input{type=0,data=new Data{mouse=new Mouse{flags=16}}});}finally{Key(0x10,true);Key(0x11,true);}}
 public static void SelfPaste(IntPtr expected){RequireForeground(expected);try{Key(0x11,false);System.Threading.Thread.Sleep(30);RequireForeground(expected);ClickKey(0x56);System.Threading.Thread.Sleep(10);}finally{Key(0x11,true);}}
 public static bool BackgroundPasteFailed=false;
 public static void BackgroundPaste(IntPtr expected){RequireForeground(expected);lock(ControlGate){if(ownedControl||(GetAsyncKeyState(0x11)&0x8000)!=0)throw new Exception("Refusing to replace an existing Ctrl press");BackgroundPasteFailed=false;Key(0x11,false);ownedControl=true;}System.Threading.Tasks.Task.Run(()=>{try{System.Threading.Thread.Sleep(30);RequireForeground(expected);ClickKey(0x56);System.Threading.Thread.Sleep(10);}catch{BackgroundPasteFailed=true;}finally{ReleaseControl();}});}
 [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
 static System.Threading.Tasks.Task<bool> clipboardHold;
 public static void ArmSyntheticClipboardHold(IntPtr owner,string expected,int milliseconds){if(!expected.StartsWith("QA controlled clipboard repeat ")||expected.Length>262144||(milliseconds!=250&&milliseconds!=1000))throw new Exception("Expected bounded synthetic clipboard hold");if(clipboardHold!=null&&!clipboardHold.IsCompleted)throw new Exception("Clipboard hold already armed");var initial=GetClipboardSequenceNumber();clipboardHold=System.Threading.Tasks.Task.Run(()=>{var deadline=DateTime.UtcNow.AddSeconds(4);while(DateTime.UtcNow<deadline){if(GetClipboardSequenceNumber()!=initial&&OpenClipboard(owner)){try{var handle=GetClipboardData(13);if(handle!=IntPtr.Zero){var data=GlobalLock(handle);if(data!=IntPtr.Zero){bool matches;try{matches=Marshal.PtrToStringUni(data)==expected;}finally{GlobalUnlock(handle);}if(matches){System.Threading.Thread.Sleep(milliseconds);return true;}}}}finally{CloseClipboard();}}System.Threading.Thread.Sleep(5);}return false;});}
 public static bool FinishSyntheticClipboardHold(){return clipboardHold!=null&&clipboardHold.GetAwaiter().GetResult();}
}
'@
$identifierBytes=[Text.Encoding]::UTF8.GetBytes($info.identifier)
$identifierHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($identifierBytes)).ToLowerInvariant()
$pasteDirectory=Join-Path ([IO.Path]::GetTempPath()) (Join-Path 'copy_creator_paste_instances' $identifierHash)
$main=[QaDesktopInput]::Main([uint32]$info.pid)
$form=[System.Windows.Forms.Form]::new()
$form.Text='Copy Creator QA Paste Target '+[guid]::NewGuid().ToString()
$form.Width=540;$form.Height=180;$form.StartPosition='CenterScreen';$form.TopMost=$false
$text=[System.Windows.Forms.TextBox]::new();$text.Multiline=$true;$text.Dock='Fill';$text.Text='';$form.Controls.Add($text)
$script:qaKeyTrace=[Collections.Generic.List[object]]::new()
$text.add_KeyDown({param($sender,$event) if($event.KeyValue -in @(16,17,86)){if($script:qaKeyTrace.Count -ge 24){$script:qaKeyTrace.RemoveAt(0)};$script:qaKeyTrace.Add(@{up=$false;key=$event.KeyValue;ctrl=$event.Control;shift=$event.Shift;alt=$event.Alt})}})
$text.add_KeyUp({param($sender,$event) if($event.KeyValue -in @(16,17,86)){if($script:qaKeyTrace.Count -ge 24){$script:qaKeyTrace.RemoveAt(0)};$script:qaKeyTrace.Add(@{up=$true;key=$event.KeyValue;ctrl=$event.Control;shift=$event.Shift;alt=$event.Alt})}})
$text.add_KeyPress({param($sender,$event) if([int]$event.KeyChar -in @(22,86,118)){if($script:qaKeyTrace.Count -ge 24){$script:qaKeyTrace.RemoveAt(0)};$script:qaKeyTrace.Add(@{character=[int]$event.KeyChar;clipboardOpener=[QaDesktopInput]::ClipboardOpener([uint32]$info.pid);handled=$event.Handled;readOnly=$sender.ReadOnly;enabled=$sender.Enabled;modifiers=[QaDesktopInput]::ModifierMask($false);physicalModifiers=[QaDesktopInput]::ModifierMask($true)})}})
$text.add_TextChanged({param($sender,$event) if($script:qaKeyTrace.Count -ge 24){$script:qaKeyTrace.RemoveAt(0)};$script:qaKeyTrace.Add(@{textChangedLength=$sender.TextLength})})
$ownerPid=[Diagnostics.Process]::GetCurrentProcess().Id
$reader=[Console]::In
$form.Show()
@{ready=$true;pid=$ownerPid;targetHwnd=$form.Handle.ToInt64();qaHwnd=$main.ToInt64();scope='Synthetic owned window only; no arbitrary target handles or original clipboard content returned'} | ConvertTo-Json -Compress
$script:qaDesktopRead=[QaDesktopInput]::ReadCommand()
$script:qaDesktopFailure=$null
$commandTimer=[System.Windows.Forms.Timer]::new();$commandTimer.Interval=10
$commandTimer.add_Tick({
 if(-not $script:qaDesktopRead.IsCompleted){return}
 $commandTimer.Stop()
 try {
  $line=$script:qaDesktopRead.GetAwaiter().GetResult();if($null -eq $line){$form.Close();return}
  $request=$line | ConvertFrom-Json
  switch($request.command){
   'focusTarget' {$form.Show();$form.Activate();[QaDesktopInput]::FocusOwned($form.Handle);$text.Focus()|Out-Null;[System.Windows.Forms.Application]::DoEvents();@{focusedTarget=$true;textboxFocused=$text.Focused}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'focusTargetFast' {$form.Show();$form.Activate();[QaDesktopInput]::FocusOwned($form.Handle,0);$text.Focus()|Out-Null;[System.Windows.Forms.Application]::DoEvents();@{focusedTarget=$true;textboxFocused=$text.Focused}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'focusQa' {[QaDesktopInput]::FocusOwned($main);$windowOwner=[uint32]0;$thread=[QaDesktopInput]::GetWindowThreadProcessId($main,[ref]$windowOwner);@{focusedQa=$true;keyboardLayout=[QaDesktopInput]::GetKeyboardLayout($thread).ToInt64()}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'typeLatin' {[QaDesktopInput]::TypeLatin($main,[string]$request.text);@{sentNativeKeys=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'key' {if($request.name -notin @('shift','space','escape')){throw 'Unsupported synthetic key'};[QaDesktopInput]::RequireForeground($main);$key=@{shift=0x10;space=0x20;escape=0x1B}[$request.name];[QaDesktopInput]::ClickKey([uint16]$key);@{sentNativeKey=$request.name}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'holdControl' {[QaDesktopInput]::HoldControl($form.Handle,400);@{ownedControlHeldMs=400}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'globalToggle' {[QaDesktopInput]::ToggleMainFromFixture($form.Handle);@{sentPhysicalChord=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'selfPaste' {[QaDesktopInput]::SelfPaste($form.Handle);@{sentOwnedPasteKeys=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'backgroundPaste' {[QaDesktopInput]::BackgroundPaste($form.Handle);@{startedOwnedPasteKeys=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'armClipboardHold' {[QaDesktopInput]::RequireForeground($main);[QaDesktopInput]::ArmSyntheticClipboardHold($form.Handle,[string]$request.expected,[int]$request.milliseconds);@{armedSyntheticClipboardHold=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'finishClipboardHold' {@{heldSyntheticClipboard=[QaDesktopInput]::FinishSyntheticClipboardHold()}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'diagnoseEmptyPaste' {$expected=[string]$request.expected;if(-not $expected.StartsWith('QA controlled clipboard ') -or $text.TextLength -ne 0){throw 'Diagnostic requires empty synthetic target'};[QaDesktopInput]::RequireForeground($form.Handle);if(-not [QaDesktopInput]::ClipboardMatches($form.Handle,$expected)){throw 'Diagnostic clipboard changed'};$text.Paste();@{diagnosticDirectPaste=($text.Text -ceq $expected);length=$text.TextLength}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'assertTarget' {if(-not ([string]$request.expected).StartsWith('QA controlled clipboard ')){throw 'Only synthetic paste expected'};@{targetMatches=($text.Text -ceq $request.expected);length=$text.Text.Length;textboxFocused=$text.Focused;targetForeground=([QaDesktopInput]::GetForegroundWindow() -eq $form.Handle);logicalModifiers=[QaDesktopInput]::ModifierMask($false);physicalModifiers=[QaDesktopInput]::ModifierMask($true)}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'assertQaForeground' {@{qaForeground=([QaDesktopInput]::GetForegroundWindow() -eq $main);qaGuiFlags=[QaDesktopInput]::GuiFlags($main);targetGuiFlags=[QaDesktopInput]::GuiFlags($form.Handle)}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'keyTrace' {@{keys=@($script:qaKeyTrace.ToArray());externalOpenerKind=[QaDesktopInput]::ExternalOpenerKind()}|ConvertTo-Json -Compress -Depth 4|ForEach-Object {[Console]::WriteLine($_)}}
   'assertClipboard' {$expected=[string]$request.expected;if(-not($expected.StartsWith('QA controlled clipboard ') -or [IO.Path]::GetFullPath($expected).StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase))){throw 'Only synthetic clipboard expected'};@{clipboardMatches=[QaDesktopInput]::ClipboardMatches($form.Handle,$expected)}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'assertImageClipboard' {@{imageFormatsAndPixelMatch=[QaDesktopInput]::SyntheticImageMatches($form.Handle,$pasteDirectory)}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'assertFileClipboard' {$expected=[IO.Path]::GetFullPath([string]$request.expected);if(-not $expected.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Only bounded QA file expected'};@{fileClipboardMatches=[QaDesktopInput]::FileMatches($form.Handle,$expected)}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'clearTarget' {$text.Clear();$script:qaKeyTrace.Clear();[QaDesktopInput]::ResetOpener();@{cleared=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'writeSynthetic' {[QaDesktopInput]::WriteSynthetic($form.Handle,[string]$request.text);@{writtenSynthetic=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)}}
   'close' {@{closed=$true}|ConvertTo-Json -Compress|ForEach-Object {[Console]::WriteLine($_)};break}
   default {throw 'Unsupported synthetic desktop command'}
  }
  if($request.command -eq 'close'){$form.Close();return}
  $script:qaDesktopRead=[QaDesktopInput]::ReadCommand()
  $commandTimer.Start()
 }catch{$script:qaDesktopFailure=$_;$form.Close()}
})
try {
 $commandTimer.Start()
 [System.Windows.Forms.Application]::Run($form)
 if($script:qaDesktopFailure){throw $script:qaDesktopFailure}
} finally {$commandTimer.Stop();$commandTimer.Dispose();[QaDesktopInput]::FinishSyntheticClipboardHold()|Out-Null;[QaDesktopInput]::ReleaseControl();$form.Close();$form.Dispose()}
