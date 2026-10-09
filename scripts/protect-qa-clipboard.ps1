param([Parameter(Mandatory=$true)][string]$Metadata,[ValidateSet('default','baseline')][string]$Scope='default')
$ErrorActionPreference='Stop'
$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/QA-notes-20261007'))
$expectedIdentifier='com.copycreator.qa20261007'
if($Scope -eq 'baseline'){$qaRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../output/optimization/baseline-runtime-20261008'));$expectedIdentifier='com.copycreator.qabaseline20261008v2'}
if([IO.Path]::GetFullPath($Metadata) -ne (Join-Path $qaRoot 'process.json')){throw 'Expected exact default QA metadata'}
function Assert-QaStopped {
 $info=Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
 if($info.identifier -ne $expectedIdentifier -or [IO.Path]::GetFullPath($info.exe) -ne (Join-Path $qaRoot 'copy-creator-qa.exe')){throw 'Expected isolated QA process'}
 if($Scope -eq 'baseline' -and ($info.generation -ne 2 -or $info.pasteIsolation -ne 'identifier' -or $info.autostartIsolation -ne 'identifier')){throw 'Expected rebuilt isolated baseline'}
 if((Get-FileHash -LiteralPath $info.exe -Algorithm SHA256).Hash -ne $info.sha256){throw 'QA hash mismatch'}
 $running=Get-Process -Id $info.pid -ErrorAction SilentlyContinue
 if($running -and $running.Path -eq $info.exe){throw 'Stop QA listener before preserving/restoring original clipboard'}
}
Assert-QaStopped
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
public sealed class QaClipboardSnapshot {
 public static System.Threading.Tasks.Task<string> ReadCommand(){return System.Threading.Tasks.Task.Run(()=>Console.ReadLine());}
 [DllImport("user32.dll",SetLastError=true)] static extern bool OpenClipboard(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint previous);
 [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetClipboardData(uint format,IntPtr data);
 [DllImport("user32.dll")] static extern bool EmptyClipboard();
 [DllImport("ole32.dll")] static extern IntPtr OleDuplicateData(IntPtr data,ushort format,uint flags);
 [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr data);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr data);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr data);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr data);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr data);
 [DllImport("gdi32.dll")] static extern bool DeleteEnhMetaFile(IntPtr data);
 [DllImport("gdi32.dll")] static extern bool DeleteMetaFile(IntPtr data);
 [StructLayout(LayoutKind.Sequential)] struct MetaPicture {public int mode,x,y;public IntPtr metafile;}
 readonly IntPtr owner;
 readonly List<Tuple<uint,IntPtr,byte[]>> saved=new List<Tuple<uint,IntPtr,byte[]>>();
 public int Count {get;private set;}
 public bool Restored {get;private set;}
 static bool Gdi(uint f){return f==2||f==3||f==9||f==14;}
 void Open(){for(int i=0;i<40;i++){if(OpenClipboard(owner))return;Thread.Sleep(25);}throw new Exception("Clipboard busy");}
 static byte[] Digest(IntPtr handle){
  ulong size=GlobalSize(handle).ToUInt64();
  if(size>268435456)throw new Exception("Clipboard snapshot exceeds private memory budget");
  IntPtr data=GlobalLock(handle);if(data==IntPtr.Zero)throw new Exception("Clipboard memory unavailable");
  try {byte[] bytes=new byte[(int)size];Marshal.Copy(data,bytes,0,bytes.Length);using(var sha=SHA256.Create()){return sha.ComputeHash(bytes);}}
  finally{GlobalUnlock(handle);}
 }
 public QaClipboardSnapshot(IntPtr hwnd){
  owner=hwnd;Open();
  try{
   ulong total=0;uint format=0;
   while((format=EnumClipboardFormats(format))!=0){
    if(saved.Count>=64||format==0x80||(format>=0x200&&format<=0x3ff))throw new Exception("Unsupported clipboard format; original left unchanged");
    IntPtr source=GetClipboardData(format);if(source==IntPtr.Zero)throw new Exception("Clipboard format "+format+" not renderable; original left unchanged");
    if(!Gdi(format)){total+=GlobalSize(source).ToUInt64();if(total>268435456)throw new Exception("Clipboard snapshot exceeds private memory budget");}
    IntPtr copy=OleDuplicateData(source,(ushort)format,2);if(copy==IntPtr.Zero)throw new Exception("Clipboard duplication failed; original left unchanged");
    saved.Add(Tuple.Create(format,copy,Gdi(format)?null:Digest(copy)));
   }
   Count=saved.Count;
  }catch{FreeCopies();throw;}finally{CloseClipboard();}
 }
 void FreeCopies(){foreach(var item in saved){if(item.Item2==IntPtr.Zero)continue;if(item.Item1==14)DeleteEnhMetaFile(item.Item2);else if(item.Item1==2||item.Item1==9)DeleteObject(item.Item2);else {if(item.Item1==3){IntPtr p=GlobalLock(item.Item2);if(p!=IntPtr.Zero){DeleteMetaFile(Marshal.PtrToStructure<MetaPicture>(p).metafile);GlobalUnlock(item.Item2);}}GlobalFree(item.Item2);}}saved.Clear();}
 public void WriteSynthetic(string text){
  if(text==null||!text.StartsWith("QA controlled clipboard ")||text.Length>262144)throw new Exception("Only bounded synthetic clipboard text is allowed");
  byte[] bytes=System.Text.Encoding.Unicode.GetBytes(text+"\0");IntPtr handle=GlobalAlloc(2,(UIntPtr)bytes.Length);
  if(handle==IntPtr.Zero)throw new Exception("Clipboard allocation failed");
  IntPtr data=GlobalLock(handle);try{Marshal.Copy(bytes,0,data,bytes.Length);}finally{GlobalUnlock(handle);}
  bool transferred=false;Open();try{if(!EmptyClipboard()||SetClipboardData(13,handle)==IntPtr.Zero)throw new Exception("Synthetic clipboard write failed");transferred=true;}finally{CloseClipboard();if(!transferred)GlobalFree(handle);}
 }
 public bool MatchesSynthetic(string expected){
  if(expected==null||!expected.StartsWith("QA controlled clipboard "))throw new Exception("Expected synthetic text required");
  Open();try{IntPtr handle=GetClipboardData(13);if(handle==IntPtr.Zero)return false;IntPtr data=GlobalLock(handle);try{return Marshal.PtrToStringUni(data)==expected;}finally{GlobalUnlock(handle);}}finally{CloseClipboard();}
 }
 public bool Restore(){
  if(Restored)return true;
  Open();try{
   if(!EmptyClipboard())throw new Exception("Clipboard restore could not empty temporary data");
   // Retain private originals until all formats restore and verify, so a
   // partial SetClipboardData failure can retry without losing the snapshot.
   foreach(var item in saved){IntPtr copy=OleDuplicateData(item.Item2,(ushort)item.Item1,2);if(copy==IntPtr.Zero||SetClipboardData(item.Item1,copy)==IntPtr.Zero)throw new Exception("Clipboard format restoration failed");}
   bool equal=true;foreach(var item in saved){IntPtr data=GetClipboardData(item.Item1);if(data==IntPtr.Zero){equal=false;continue;}if(item.Item3!=null){byte[] digest=Digest(data);for(int i=0;i<digest.Length;i++)if(digest[i]!=item.Item3[i])equal=false;}}
   Restored=true;FreeCopies();return equal;
  }finally{CloseClipboard();}
 }
}
'@
$owner=[System.Windows.Forms.Control]::new()
$snapshot=[QaClipboardSnapshot]::new($owner.Handle)
$recoveryRequest=Join-Path $qaRoot "reports/clipboard-recovery-$PID.request"
$recoveryReceipt=Join-Path $qaRoot "reports/clipboard-recovery-$PID.json"
function Restore-WithReceipt([bool]$Automatic) {
 Assert-QaStopped
 $verified=$snapshot.Restore()
 $receipt=@{restored=$snapshot.Restored;byteFormatsVerified=$verified;formats=$snapshot.Count;automaticRecovery=$Automatic}
 $receipt | ConvertTo-Json | Set-Content -LiteralPath $recoveryReceipt -Encoding utf8
 $receipt | ConvertTo-Json -Compress
}
@{ready=$true;formatsPreserved=$snapshot.Count;recoveryRequest=$recoveryRequest;recoveryReceipt=$recoveryReceipt;scope='Original clipboard held only in private process memory; no original values, bytes or hashes output'} | ConvertTo-Json -Compress
try {
 while($true){
  $read=[QaClipboardSnapshot]::ReadCommand()
  # A clipboard owner must process WM_DESTROYCLIPBOARD while another app
  # replaces our synthetic text. Blocking ReadLine would stall that app.
  while(-not $read.IsCompleted){
   [System.Windows.Forms.Application]::DoEvents()
   if(Test-Path -LiteralPath $recoveryRequest){Restore-WithReceipt $true;return}
   Start-Sleep -Milliseconds 10
  }
  $line=$read.GetAwaiter().GetResult();if($null -eq $line){break}
  $request=$line | ConvertFrom-Json
  switch($request.command){
   'writeText' {$snapshot.WriteSynthetic([string]$request.text);@{writtenSynthetic=$true}|ConvertTo-Json -Compress}
   'checkText' {@{syntheticMatches=$snapshot.MatchesSynthetic([string]$request.expected)}|ConvertTo-Json -Compress}
   'restore' {Restore-WithReceipt $false;exit}
   default {throw 'Unsupported controlled clipboard command'}
  }
 }
} finally {
 if(-not $snapshot.Restored){Restore-WithReceipt $true}
 $owner.Dispose()
}
