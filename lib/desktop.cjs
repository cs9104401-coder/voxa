'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, shell } = require('electron');
const logger = require('./logger.cjs');
const permissions = require('./permissions.cjs');
const apps = require('./apps.cjs');

const MAX_READ_FILE_BYTES = 256 * 1024;
const MAX_READ_FILE_CHARS = 12000;
const FOCUS_HELPER_TIMEOUT_MS = 3000;
const CLOSE_WAIT_MS = 3000;
const CLOSE_FORCE_WAIT_MS = 700;
const CLOSE_STILL_OPEN_MESSAGE = 'App is still open, it may be waiting on a save prompt. Say force close to kill it.';

const PROTECTED_PROCESS_NAMES = Object.freeze([
  'explorer', 'csrss', 'winlogon', 'dwm', 'lsass', 'services', 'system', 'svchost',
  'electron', 'voxa', 'myvoiceapp', 'applicationframehost'
]);
const PROTECTED_PROCESS_SET = new Set(PROTECTED_PROCESS_NAMES);
const FRAME_HOST_BLOCKLIST = new Set([
  'applicationframehost', 'inputapp', 'textinputhost', 'shellexperiencehost',
  'startmenuexperiencehost', 'searchhost', 'runtimebroker', 'dwm', 'explorer'
]);

const PROCESS_ALIASES = new Map([
  ['notepad', ['notepad', 'notepadapp']],
  ['calculator', ['calculatorapp', 'calculator', 'calc']],
  ['calc', ['calculatorapp', 'calculator', 'calc']],
  ['paint', ['mspaint', 'paint']],
  ['mspaint', ['mspaint', 'paint']],
  ['snipping tool', ['snippingtool', 'snippingtoolapp']],
  ['file explorer', ['explorer']],
  ['explorer', ['explorer']],
  ['command prompt', ['cmd']],
  ['cmd', ['cmd']],
  ['windows powershell', ['powershell', 'pwsh']],
  ['powershell', ['powershell', 'pwsh']],
  ['task manager', ['taskmgr']],
  ['taskmgr', ['taskmgr']],
  ['wordpad', ['write']],
  ['control panel', ['control']],
  ['settings', ['systemsettings']],
  ['microsoft edge', ['msedge']],
  ['edge', ['msedge']],
  ['google chrome', ['chrome']],
  ['chrome', ['chrome']],
  ['mozilla firefox', ['firefox']],
  ['firefox', ['firefox']],
  ['visual studio code', ['code']],
  ['vs code', ['code']],
  ['code', ['code']],
  ['spotify', ['spotify']],
  ['discord', ['discord']],
  ['microsoft word', ['winword']],
  ['word', ['winword']],
  ['microsoft excel', ['excel']],
  ['excel', ['excel']],
  ['microsoft powerpoint', ['powerpnt']],
  ['powerpoint', ['powerpnt']]
]);

let focusHelper = null;
let focusHelperBuffer = '';
let focusHelperStderr = '';
let focusHelperPending = null;
let focusHelperDisposed = false;
let focusQueue = Promise.resolve();

const NATIVE_USINGS = `
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;`;

const NATIVE_WINDOW_MEMBERS = `
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public static IntPtr[] ChildWindows(IntPtr parent) {
    List<IntPtr> found = new List<IntPtr>();
    EnumChildWindows(parent, delegate(IntPtr hWnd, IntPtr lParam) { found.Add(hWnd); return true; }, IntPtr.Zero);
    return found.ToArray();
  }`;

const NATIVE_INPUT_MEMBERS = `
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  static INPUT KeyInput(ushort virtualKey, ushort scanCode, uint flags) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki.wVk = virtualKey;
    input.U.ki.wScan = scanCode;
    input.U.ki.dwFlags = flags;
    input.U.ki.time = 0;
    input.U.ki.dwExtraInfo = IntPtr.Zero;
    return input;
  }
  public static uint SendCtrlV(out int error) {
    INPUT[] inputs = new INPUT[] {
      KeyInput(0x11, 0, 0),
      KeyInput(0x56, 0, 0),
      KeyInput(0x56, 0, KEYEVENTF_KEYUP),
      KeyInput(0x11, 0, KEYEVENTF_KEYUP)
    };
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    error = sent == (uint)inputs.Length ? 0 : Marshal.GetLastWin32Error();
    return sent;
  }
  public static uint SendUnicode(string text, out int error) {
    error = 0;
    uint total = 0;
    int index = 0;
    while (index < text.Length) {
      int count = Math.Min(200, text.Length - index);
      INPUT[] inputs = new INPUT[count * 2];
      for (int i = 0; i < count; i++) {
        ushort scan = (ushort)text[index + i];
        inputs[i * 2] = KeyInput(0, scan, KEYEVENTF_UNICODE);
        inputs[i * 2 + 1] = KeyInput(0, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
      }
      uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
      total += sent;
      if (sent != (uint)inputs.Length) {
        error = Marshal.GetLastWin32Error();
        break;
      }
      index += count;
    }
    return total;
  }`;

const NATIVE_ELEVATION_MEMBERS = `
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr tokenHandle, int informationClass, out int information, int informationLength, out int returnLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  public static bool IsProcessElevated(uint processId) {
    IntPtr process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) return false;
    IntPtr token = IntPtr.Zero;
    try {
      if (!OpenProcessToken(process, 0x0008, out token)) return false;
      int elevated = 0;
      int returned = 0;
      if (!GetTokenInformation(token, 20, out elevated, 4, out returned)) return false;
      return elevated != 0;
    } finally {
      if (token != IntPtr.Zero) CloseHandle(token);
      CloseHandle(process);
    }
  }`;

function nativeClass(members) {
  return `${NATIVE_USINGS}
public class VoxaWin {
${members}
}`;
}

const WINDOW_HELPERS = `
function Get-VoxaWindowInfo {
  param([IntPtr]$WindowHandle)
  if ($WindowHandle -eq [IntPtr]::Zero) { return $null }
  $title = New-Object Text.StringBuilder 1024
  $className = New-Object Text.StringBuilder 512
  [void][VoxaWin]::GetWindowText($WindowHandle, $title, $title.Capacity)
  [void][VoxaWin]::GetClassName($WindowHandle, $className, $className.Capacity)
  $windowPid = [uint32]0
  [void][VoxaWin]::GetWindowThreadProcessId($WindowHandle, [ref]$windowPid)
  $processName = ''
  $processPath = ''
  try {
    $process = Get-Process -Id ([int]$windowPid) -ErrorAction Stop
    $processName = $process.ProcessName
    try { $processPath = $process.Path } catch {}
  } catch {}
  [pscustomobject]@{
    handle = ('0x{0:X}' -f $WindowHandle.ToInt64())
    handleValue = $WindowHandle.ToInt64()
    id = "$($windowPid):$($className.ToString())"
    title = $title.ToString()
    className = $className.ToString()
    processId = [int]$windowPid
    processName = $processName
    processPath = $processPath
    visible = [bool][VoxaWin]::IsWindowVisible($WindowHandle)
  }
}
function Get-VoxaForegroundInfo {
  $handle = [VoxaWin]::GetForegroundWindow()
  $info = Get-VoxaWindowInfo $handle
  if ($null -eq $info) { return $null }
  if ($info.className -match '^ApplicationFrame' -or $info.processName -match '^ApplicationFrameHost') {
    $frameInfo = $info
    $candidates = @()
    foreach ($childHandle in [VoxaWin]::ChildWindows($handle)) {
      $child = Get-VoxaWindowInfo $childHandle
      if ($null -eq $child) { continue }
      if ($child.processId -eq $frameInfo.processId) { continue }
      if ($child.processName -match '^ApplicationFrameHost') { continue }
      $score = 0
      if ($child.className -eq 'Windows.UI.Core.CoreWindow') { $score += 100 }
      if ($child.className -notmatch 'InputSink|Shadow|Tooltip|IME') { $score += 10 }
      if ($child.title) { $score += 20 }
      if ($child.visible) { $score += 5 }
      $candidates += [pscustomobject]@{ score = $score; info = $child }
    }
    $best = $candidates | Sort-Object score -Descending | Select-Object -First 1
    if ($null -ne $best) {
      $resolved = $best.info
      if (-not $resolved.title) { $resolved.title = $frameInfo.title }
      $resolved | Add-Member -NotePropertyName resolved -NotePropertyValue $true
      $resolved | Add-Member -NotePropertyName frameHandle -NotePropertyValue $frameInfo.handle
      $resolved | Add-Member -NotePropertyName frameClass -NotePropertyValue $frameInfo.className
      $resolved | Add-Member -NotePropertyName frameProcessName -NotePropertyValue $frameInfo.processName
      return $resolved
    }
  }
  $info | Add-Member -NotePropertyName resolved -NotePropertyValue $false
  return $info
}
`;

const FOCUS_SCRIPT = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
${nativeClass(NATIVE_WINDOW_MEMBERS)}
'@
${WINDOW_HELPERS}
$info = Get-VoxaForegroundInfo
if ($null -eq $info) { '{}' } else { $info | ConvertTo-Json -Compress }
`;

const LIST_WINDOWS_SCRIPT = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
${nativeClass(NATIVE_WINDOW_MEMBERS)}
'@
${WINDOW_HELPERS}
$items = @()
foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
  try {
    $handle = $process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { continue }
    $info = Get-VoxaWindowInfo $handle
    if ($null -ne $info -and $info.visible -and $info.title) { $items += $info }
  } catch {}
}
$items | ConvertTo-Json -Compress -Depth 4
`;

const FOCUS_WINDOW_SCRIPT = (handleValue) => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
${nativeClass(NATIVE_WINDOW_MEMBERS)}
'@
${WINDOW_HELPERS}
$handle = [IntPtr]::new([Int64]${handleValue})
$ok = $false
$message = ''
if (-not [VoxaWin]::IsWindow($handle)) {
  $message = 'The target window no longer exists.'
} else {
  try {
    if ([VoxaWin]::IsIconic($handle)) { [void][VoxaWin]::ShowWindowAsync($handle, 9) }
    $foreground = [VoxaWin]::GetForegroundWindow()
    $targetPid = [uint32]0
    $foregroundPid = [uint32]0
    $targetThread = [VoxaWin]::GetWindowThreadProcessId($handle, [ref]$targetPid)
    $foregroundThread = [VoxaWin]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    $attached = $false
    if ($foregroundThread -ne 0 -and $targetThread -ne 0 -and $foregroundThread -ne $targetThread) {
      $attached = [VoxaWin]::AttachThreadInput($foregroundThread, $targetThread, $true)
    }
    try {
      [void][VoxaWin]::BringWindowToTop($handle)
      [void][VoxaWin]::SetForegroundWindow($handle)
      [void][VoxaWin]::SetFocus($handle)
    } finally {
      if ($attached) { [void][VoxaWin]::AttachThreadInput($foregroundThread, $targetThread, $false) }
    }
    Start-Sleep -Milliseconds 150
    $current = [VoxaWin]::GetForegroundWindow()
    $ok = ($current -eq $handle)
    if (-not $ok) {
      $info = Get-VoxaForegroundInfo
      if ($null -ne $info -and $info.handleValue -eq $handle.ToInt64()) { $ok = $true }
    }
    if (-not $ok) { $message = 'Windows did not switch to the target window.' }
  } catch {
    $message = $_.Exception.Message
  }
}
$info = Get-VoxaForegroundInfo
[pscustomobject]@{
  ok = $ok
  error = $message
  foreground = $info
} | ConvertTo-Json -Compress -Depth 6
`;

const FOCUS_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
${nativeClass(NATIVE_WINDOW_MEMBERS)}
'@
${WINDOW_HELPERS}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq 'quit') { break }
  try {
    $info = Get-VoxaForegroundInfo
    if ($null -eq $info) { '{}' } else { $info | ConvertTo-Json -Compress }
  } catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  [Console]::Out.Flush()
}
`;

const TYPE_SCRIPT = (file, expectedId = '') => `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
${nativeClass(NATIVE_WINDOW_MEMBERS + NATIVE_INPUT_MEMBERS + NATIVE_ELEVATION_MEMBERS)}
'@
${WINDOW_HELPERS}
function Get-VoxaClipboardBackup {
  try {
    $source = [Windows.Forms.Clipboard]::GetDataObject()
    if ($null -eq $source) { return $null }
    $backup = New-Object Windows.Forms.DataObject
    $copied = $false
    foreach ($format in $source.GetFormats($false)) {
      try {
        $value = $source.GetData($format, $false)
        if ($null -ne $value) {
          $backup.SetData($format, $value)
          $copied = $true
        }
      } catch {}
    }
    if ($copied) { return ,$backup }
  } catch {}
  return $null
}
function Set-VoxaClipboardText {
  param([string]$Text)
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      [Windows.Forms.Clipboard]::SetText($Text)
      return $true
    } catch {
      Start-Sleep -Milliseconds 80
    }
  }
  return $false
}
function Restore-VoxaClipboard {
  param($Backup, [bool]$HadText, [string]$PreviousText)
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try {
      if ($null -ne $Backup) {
        [Windows.Forms.Clipboard]::SetDataObject($Backup, $true)
      } elseif ($HadText) {
        [Windows.Forms.Clipboard]::SetText($PreviousText)
      } else {
        [Windows.Forms.Clipboard]::Clear()
      }
      return $true
    } catch {
      Start-Sleep -Milliseconds 80
    }
  }
  return $false
}
$info = Get-VoxaForegroundInfo
$expectedId = '${escapePath(expectedId)}'
$targetElevated = $false
if ($null -ne $info -and $info.processId) {
  try { $targetElevated = [VoxaWin]::IsProcessElevated([uint32]$info.processId) } catch {}
}
$text = [IO.File]::ReadAllText('${escapePath(file)}', [Text.Encoding]::UTF8)
$previousText = ''
$hadText = $false
try {
  if ([Windows.Forms.Clipboard]::ContainsText()) {
    $previousText = [Windows.Forms.Clipboard]::GetText()
    $hadText = $true
  }
} catch {}
$backup = Get-VoxaClipboardBackup
$clipboardSet = $false
$clipboardRestored = $false
$keystrokeSent = $false
$method = ''
$result = 'failed'
$failureMessage = ''
$errorCode = 0
$sentEvents = 0
try {
  if ($null -eq $info) {
    $failureMessage = 'No window has focus.'
    $result = 'no-focus'
  } elseif ($expectedId -and $info.id -ne $expectedId) {
    $failureMessage = 'The focused app changed before the text could be inserted.'
    $result = 'target-changed'
  } else {
    $clipboardSet = Set-VoxaClipboardText $text
    if ($clipboardSet) {
      Start-Sleep -Milliseconds 80
      $pasteError = 0
      $pasteSent = [VoxaWin]::SendCtrlV([ref]$pasteError)
      $sentEvents = [int]$pasteSent
      if ($pasteSent -eq 4) {
        $keystrokeSent = $true
        $method = 'paste'
        Start-Sleep -Milliseconds 350
        $result = 'pasted'
      } else {
        $errorCode = [int]$pasteError
        $failureMessage = "Paste keystroke failed (Windows error $pasteError)."
      }
    } else {
      $failureMessage = 'The clipboard could not be updated.'
    }
  }
} catch {
  $failureMessage = $_.Exception.Message
} finally {
  $clipboardRestored = Restore-VoxaClipboard $backup $hadText $previousText
}
if ($result -ne 'pasted' -and $result -ne 'target-changed' -and $null -ne $info) {
  try {
    $typingText = [regex]::Replace($text, "\\r\\n|\\r|\\n", [string][char]13)
    $typeError = 0
    $typed = [VoxaWin]::SendUnicode($typingText, [ref]$typeError)
    $sentEvents = [int]$typed
    if ($typed -eq ([uint32]($typingText.Length * 2))) {
      $keystrokeSent = $true
      $method = 'unicode'
      $result = 'typed'
      $failureMessage = ''
      $errorCode = 0
    } else {
      $errorCode = [int]$typeError
      $failureMessage = "Keyboard typing failed (Windows error $typeError)."
    }
  } catch {
    $failureMessage = $_.Exception.Message
  }
}
[pscustomobject]@{
  foreground = $info
  targetElevated = $targetElevated
  clipboardSet = $clipboardSet
  clipboardRestored = $clipboardRestored
  keystrokeSent = $keystrokeSent
  sentEvents = $sentEvents
  method = $method
  result = $result
  errorCode = $errorCode
  error = $failureMessage
} | ConvertTo-Json -Compress -Depth 6
`;

const PRESS_SCRIPT = (sequence) => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.SendKeys]::SendWait('${escapePath(sequence)}')
`;

const NATIVE_CLOSE_MEMBERS = `
  public class VoxaCloseWindow {
    public long Handle;
    public int ProcessId;
    public string ProcessName = "";
    public string Title = "";
    public string ClassName = "";
    public bool Visible;
    public bool Frame;
    public int[] ChildProcessIds = new int[0];
    public string[] ChildProcessNames = new string[0];
  }
  static string CloseProcessName(int processId) {
    try {
      System.Diagnostics.Process process = System.Diagnostics.Process.GetProcessById(processId);
      return process.ProcessName ?? "";
    } catch {
      return "";
    }
  }
  static VoxaCloseWindow CloseWindowInfo(IntPtr handle) {
    VoxaCloseWindow info = new VoxaCloseWindow();
    info.Handle = handle.ToInt64();
    uint processId = 0;
    GetWindowThreadProcessId(handle, out processId);
    info.ProcessId = (int)processId;
    info.ProcessName = CloseProcessName(info.ProcessId).ToLowerInvariant();
    StringBuilder title = new StringBuilder(1024);
    GetWindowText(handle, title, title.Capacity);
    info.Title = title.ToString();
    StringBuilder className = new StringBuilder(512);
    GetClassName(handle, className, className.Capacity);
    info.ClassName = className.ToString();
    info.Visible = IsWindowVisible(handle);
    info.Frame = info.ProcessName == "applicationframehost"
      || info.ClassName.StartsWith("ApplicationFrame", StringComparison.OrdinalIgnoreCase);
    List<int> childIds = new List<int>();
    List<string> childNames = new List<string>();
    EnumChildWindows(handle, delegate(IntPtr child, IntPtr lParam) {
      uint childProcessId = 0;
      GetWindowThreadProcessId(child, out childProcessId);
      int childId = (int)childProcessId;
      if (childId != 0 && childId != info.ProcessId && !childIds.Contains(childId)) {
        childIds.Add(childId);
        childNames.Add(CloseProcessName(childId).ToLowerInvariant());
      }
      return true;
    }, IntPtr.Zero);
    info.ChildProcessIds = childIds.ToArray();
    info.ChildProcessNames = childNames.ToArray();
    return info;
  }
  public static VoxaCloseWindow[] CloseWindows() {
    List<VoxaCloseWindow> found = new List<VoxaCloseWindow>();
    EnumWindows(delegate(IntPtr handle, IntPtr lParam) {
      found.Add(CloseWindowInfo(handle));
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  public static bool CloseWindowAlive(long handle) {
    return IsWindow(new IntPtr(handle));
  }
  public static bool PostClose(long handle) {
    return PostMessage(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
`;

function powerShellArray(values) {
  return `@(${values.map((value) => `'${escapePath(value)}'`).join(', ')})`;
}

function closeScript(plan) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
${nativeClass(NATIVE_WINDOW_MEMBERS + NATIVE_CLOSE_MEMBERS)}
'@
$selfPid = ${Number(plan.selfPid) || 0}
$targetNames = ${powerShellArray(plan.processNames)}
$titleNeedles = ${powerShellArray(plan.titleNeedles)}
$focusHandles = ${powerShellArray(plan.focusHandles.map((value) => String(value)))}
$focusPids = ${powerShellArray(plan.focusPids.map((value) => String(value)))}
$focusProcessName = '${escapePath(plan.focusProcessName)}'
$force = ${plan.force ? '$true' : '$false'}
$label = '${escapePath(plan.label)}'
$waitMs = ${CLOSE_WAIT_MS}
$forceWaitMs = ${CLOSE_FORCE_WAIT_MS}
$protectedNames = ${powerShellArray(PROTECTED_PROCESS_NAMES)}
$frameBlocklist = ${powerShellArray([...FRAME_HOST_BLOCKLIST])}
$helperClasses = @('gdi+ hook window class','msctfime ui','ime','default ime','applicationframeinputsinkwindow','applicationframeshadow','applicationframetooltip','tasklistthumbnailwnd','tasklistoverlaywnd','sysshadow','tooltip','microsoft.ui.content.popupwindowsitebridge','microsoft.ui.content.desktopchildsitebridge','microsoft.ui.xaml.controls.primitives.popup')

function Test-NameIn {
  param([string]$Value, [string[]]$Names)
  $lower = ([string]$Value).ToLowerInvariant()
  foreach ($name in $Names) {
    if ($lower -eq $name) { return $true }
  }
  return $false
}
function Test-TargetName {
  param([string]$Value)
  return (Test-NameIn $Value $targetNames)
}
function Test-ProtectedName {
  param([string]$Value)
  return (Test-NameIn $Value $protectedNames)
}
function Test-TargetTitle {
  param([string]$Value)
  $clean = ([string]$Value -replace '\\s+', ' ').Trim().ToLowerInvariant()
  if (-not $clean) { return $false }
  foreach ($needle in $titleNeedles) {
    if (-not $needle) { continue }
    if ($clean -eq $needle -or $clean.StartsWith($needle + ' ') -or $clean.StartsWith($needle + ':') -or $clean.StartsWith($needle + ' -')) {
      return $true
    }
  }
  return $false
}
function Get-TargetWindows {
  $found = @()
  foreach ($window in @([VoxaWin]::CloseWindows())) {
    $classKey = ([string]$window.ClassName).ToLowerInvariant()
    if ($helperClasses -contains $classKey) { continue }
    $isFrameHost = ($window.Frame -and $window.ProcessName -eq 'applicationframehost')
    $direct = $false
    $frame = $false
    if ($focusHandles.Count -gt 0) {
      if ($focusHandles -contains [string]$window.Handle) {
        if ($isFrameHost) { $frame = $true } else { $direct = $true }
      }
    } elseif ($window.Visible -or $window.Title) {
      if ((Test-TargetName $window.ProcessName) -and -not $isFrameHost) { $direct = $true }
      if ($isFrameHost) {
        $childHit = $false
        foreach ($childName in @($window.ChildProcessNames)) {
          if (Test-TargetName $childName) { $childHit = $true; break }
        }
        if ($childHit -or (Test-TargetTitle $window.Title)) { $frame = $true }
      }
    }
    if ($direct -or $frame) {
      $found += [pscustomobject]@{ window = $window; direct = $direct; frame = $frame }
    }
  }
  return @($found)
}
function Get-RunningTargetProcesses {
  $found = @()
  foreach ($name in $targetNames) {
    foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
      if (Test-ProtectedName $process.ProcessName) { continue }
      $found += $process
    }
  }
  return @($found | Sort-Object Id -Unique)
}
function Get-KillPids {
  param($Targets)
  $ids = @()
  foreach ($entry in @($Targets)) {
    $window = $entry.window
    $frameIds = @()
    if ($window.ProcessName -eq 'applicationframehost') {
      $childCount = @($window.ChildProcessIds).Count
      for ($i = 0; $i -lt $childCount; $i++) {
        $childId = [int]$window.ChildProcessIds[$i]
        $childName = [string]$window.ChildProcessNames[$i]
        if ($childId -eq $window.ProcessId -or $childId -eq $selfPid) { continue }
        if (Test-ProtectedName $childName) { continue }
        if (($focusPids -contains [string]$childId) -or (Test-TargetName $childName)) {
          $frameIds += $childId
        }
      }
      if (@($frameIds).Count -eq 0) {
        for ($i = 0; $i -lt $childCount; $i++) {
          $childId = [int]$window.ChildProcessIds[$i]
          $childName = [string]$window.ChildProcessNames[$i]
          if ($childId -eq $selfPid -or $childId -eq $window.ProcessId) { continue }
          if (Test-ProtectedName $childName) { continue }
          if (Test-NameIn $childName $frameBlocklist) { continue }
          $frameIds += $childId
        }
      }
      $ids += $frameIds
    } elseif ($window.ProcessId -ne $selfPid -and -not (Test-ProtectedName $window.ProcessName)) {
      $ids += [int]$window.ProcessId
    }
  }
  foreach ($focusPid in $focusPids) {
    if ([int]$focusPid -ne $selfPid) { $ids += [int]$focusPid }
  }
  return @($ids | Sort-Object -Unique)
}
function Test-ProcessAlive {
  param([int]$ProcessId)
  try {
    $null = Get-Process -Id $ProcessId -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

$matches = @()
$refusal = ''
foreach ($entry in @(Get-TargetWindows)) {
  $window = $entry.window
  $namesToCheck = @()
  if ($entry.direct) { $namesToCheck += $window.ProcessName }
  if ($entry.frame) { $namesToCheck += @($window.ChildProcessNames) }
  $protectedHit = $false
  foreach ($name in $namesToCheck) {
    if (Test-ProtectedName $name) { $protectedHit = $true; break }
  }
  if ($protectedHit -or $window.ProcessId -eq $selfPid) {
    if (-not $refusal) { $refusal = "I cannot close $($window.ProcessName). It is a protected app." }
    continue
  }
  $display = [string]$window.ProcessName
  $targetPids = @()
  if ($entry.direct) {
    if ($focusHandles.Count -gt 0 -and $focusPids.Count -gt 0) {
      $targetPids += @($focusPids | ForEach-Object { [int]$_ })
      if ($focusProcessName) { $display = $focusProcessName }
    } else {
      $targetPids += [int]$window.ProcessId
    }
  }
  if ($entry.frame) {
    $childCount = @($window.ChildProcessIds).Count
    for ($i = 0; $i -lt $childCount; $i++) {
      $childId = [int]$window.ChildProcessIds[$i]
      $childName = [string]$window.ChildProcessNames[$i]
      if (Test-ProtectedName $childName) { continue }
      if ((Test-TargetName $childName) -or ($focusPids -contains [string]$childId)) {
        $targetPids += $childId
        if ($display -eq 'applicationframehost' -or -not $display) { $display = $childName }
      }
    }
  }
  $matches += [pscustomobject]@{
    handle = [long]$window.Handle
    processId = [int]$window.ProcessId
    processName = [string]$window.ProcessName
    title = [string]$window.Title
    direct = [bool]$entry.direct
    frame = [bool]$entry.frame
    targetPids = @($targetPids | Sort-Object -Unique)
    displayName = $display
  }
}

if ($matches.Count -eq 0) {
  $running = @(Get-RunningTargetProcesses)
  $killed = 0
  if ($force) {
    foreach ($process in $running) {
      try {
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        $killed += 1
      } catch {}
    }
    if ($killed -gt 0) { Start-Sleep -Milliseconds $forceWaitMs }
  }
  $stillRunning = @($running | Where-Object { Test-ProcessAlive ([int]$_.Id) }).Count -gt 0
  $reason = 'not-running'
  if ($refusal) { $reason = 'refused' }
  elseif ($running.Count -gt 0) { $reason = 'no-windows' }
  [pscustomobject]@{
    refused = $refusal
    matched = 0
    windowsClosed = 0
    remaining = 0
    processName = ''
    processRunning = $stillRunning
    forced = $force
    killed = $killed
    posted = 0
    reason = $reason
  } | ConvertTo-Json -Compress
} else {
  $posted = 0
  foreach ($match in $matches) {
    try {
      if ([VoxaWin]::PostClose([long]$match.handle)) { $posted += 1 }
    } catch {}
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
  $originalAlive = @($matches | Where-Object { [VoxaWin]::CloseWindowAlive([long]$_.handle) })
  while ($originalAlive.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 150
    $originalAlive = @($matches | Where-Object { [VoxaWin]::CloseWindowAlive([long]$_.handle) })
  }
  $remainingTargets = @(Get-TargetWindows)
  $forced = $false
  $killed = 0
  if ($remainingTargets.Count -gt 0 -and $force) {
    $forced = $true
    $killPids = @(Get-KillPids $remainingTargets)
    foreach ($match in $matches) {
      foreach ($targetPid in @($match.targetPids)) { $killPids += [int]$targetPid }
    }
    foreach ($process in @(Get-RunningTargetProcesses)) { $killPids += [int]$process.Id }
    $killPids = @($killPids | Where-Object { $_ -ne $selfPid -and $_ -ne 0 } | Sort-Object -Unique)
    foreach ($killPid in $killPids) {
      try {
        Stop-Process -Id $killPid -Force -ErrorAction Stop
        $killed += 1
      } catch {}
    }
    if ($killed -gt 0) {
      $exitDeadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max($forceWaitMs, 1500))
      do {
        Start-Sleep -Milliseconds 150
        $stillAlive = @(Get-RunningTargetProcesses)
      } while ($stillAlive.Count -gt 0 -and [DateTime]::UtcNow -lt $exitDeadline)
    }
    $remainingTargets = @(Get-TargetWindows)
  }
  if ($remainingTargets.Count -gt 0 -and -not $force) {
    [pscustomobject]@{ message = '${escapePath(CLOSE_STILL_OPEN_MESSAGE)}' } | ConvertTo-Json -Compress
  } else {
    $running = @(Get-RunningTargetProcesses)
    $windowsClosed = [Math]::Max(0, $matches.Count - $remainingTargets.Count)
    [pscustomobject]@{
      refused = ''
      matched = $matches.Count
      windowsClosed = $windowsClosed
      remaining = $remainingTargets.Count
      processName = [string]$matches[0].displayName
      processRunning = ($running.Count -gt 0)
      forced = $forced
      killed = $killed
      posted = $posted
      reason = if ($remainingTargets.Count -gt 0) { 'still-open' } else { 'closed' }
    } | ConvertTo-Json -Compress
  }
}
`;
}


const KEY_ALIASES = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  space: ' ',
  backspace: '{BACKSPACE}',
  del: '{DELETE}',
  delete: '{DELETE}',
  insert: '{INSERT}',
  ins: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}'
};

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function escapePath(value) {
  return String(value).replace(/'/g, "''");
}

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script, timeout = 12000, signal) {
  return spawnPowerShell([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-OutputFormat', 'Text', '-EncodedCommand', encodedCommand(script)
  ], timeout, signal);
}

function runPowerShellFile(script, timeout = 12000, signal) {
  const file = path.join(os.tmpdir(), `voxa-close-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  fs.writeFileSync(file, `\uFEFF${script}`, 'utf8');
  return spawnPowerShell([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', file
  ], timeout, signal).finally(() => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // The OS cleans stale temporary scripts on its next pass.
    }
  });
}

function spawnPowerShell(args, timeout, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const cancelled = new Error('Cancelled.');
      cancelled.cancelled = true;
      reject(cancelled);
      return;
    }
    const child = spawn(powershellPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const abort = () => {
      child.kill();
      const cancelled = new Error('Cancelled.');
      cancelled.cancelled = true;
      finish(reject, cancelled);
    };
    let timer = null;
    timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('PowerShell helper timed out.'));
    }, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 131072) stdout = stdout.slice(-131072);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 16384) stderr = stderr.slice(-16384);
    });
    child.on('error', (error) => finish(reject, new Error(`Could not start PowerShell: ${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
        return;
      }
      finish(resolve, stdout.trim());
    });
  });
}

function rejectFocusPending(error) {
  if (!focusHelperPending) return;
  const pending = focusHelperPending;
  focusHelperPending = null;
  clearTimeout(pending.timer);
  pending.reject(error);
}

function handleFocusOutput(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('{') || !focusHelperPending) return;
  const pending = focusHelperPending;
  focusHelperPending = null;
  clearTimeout(pending.timer);
  try {
    const data = JSON.parse(trimmed);
    if (data?.error) pending.reject(new Error(String(data.error)));
    else pending.resolve(data);
  } catch (error) {
    pending.reject(new Error(`The foreground capture returned invalid data: ${error.message}`));
  }
}

function startFocusHelper() {
  if (focusHelper && focusHelper.exitCode === null) return focusHelper;
  focusHelperDisposed = false;
  focusHelperBuffer = '';
  focusHelperStderr = '';
  const child = spawn(powershellPath(), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-OutputFormat', 'Text', '-EncodedCommand', encodedCommand(FOCUS_HELPER_SCRIPT)
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  focusHelper = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (focusHelper !== child) return;
    focusHelperBuffer += chunk;
    const lines = focusHelperBuffer.split(/\r?\n/);
    focusHelperBuffer = lines.pop() || '';
    for (const line of lines) handleFocusOutput(line);
    if (focusHelperBuffer.length > 131072) focusHelperBuffer = focusHelperBuffer.slice(-131072);
  });
  child.stderr.on('data', (chunk) => {
    if (focusHelper !== child) return;
    focusHelperStderr += chunk;
    if (focusHelperStderr.length > 4096) focusHelperStderr = focusHelperStderr.slice(-4096);
  });
  child.on('error', (error) => {
    if (focusHelper === child) focusHelper = null;
    rejectFocusPending(new Error(`The foreground helper could not start: ${error.message}`));
  });
  child.on('close', (code) => {
    if (focusHelper === child) focusHelper = null;
    const detail = focusHelperStderr.trim();
    rejectFocusPending(new Error(detail || `The foreground helper exited with code ${code}.`));
    if (!focusHelperDisposed && code !== 0) {
      logger.warn('focus', `Foreground helper exited with code ${code}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
  });
  child.stdin.on('error', (error) => {
    if (focusHelper === child) focusHelper = null;
    rejectFocusPending(new Error(`The foreground helper input closed: ${error.message}`));
  });
  return child;
}

function captureWithFocusHelper() {
  return new Promise((resolve, reject) => {
    const child = startFocusHelper();
    if (!child || !child.stdin.writable) {
      reject(new Error('The foreground helper is not available.'));
      return;
    }
    const timer = setTimeout(() => {
      if (!focusHelperPending) return;
      const pending = focusHelperPending;
      focusHelperPending = null;
      try {
        child.kill();
      } catch {
        // The timeout error below is the useful result.
      }
      pending.reject(new Error('The foreground window capture timed out.'));
    }, FOCUS_HELPER_TIMEOUT_MS);
    timer.unref?.();
    focusHelperPending = { resolve, reject, timer };
    try {
      child.stdin.write('capture\n');
    } catch (error) {
      clearTimeout(timer);
      focusHelperPending = null;
      reject(new Error(`The foreground helper is not available: ${error.message}`));
    }
  });
}

function enqueueFocusCapture() {
  const run = focusQueue.then(captureWithFocusHelper, captureWithFocusHelper);
  focusQueue = run.catch(() => {});
  return run;
}

function warmFocusHelper() {
  try {
    startFocusHelper();
  } catch (error) {
    logger.warn('focus', `Could not warm the foreground helper: ${error.message}`);
  }
}

function disposeFocusHelper() {
  focusHelperDisposed = true;
  rejectFocusPending(new Error('The foreground helper was closed.'));
  const child = focusHelper;
  focusHelper = null;
  if (!child) return;
  try {
    if (child.stdin.writable) child.stdin.write('quit\n');
    child.kill();
  } catch {
    // The helper is already gone.
  }
}

function parseHelperResult(output, label) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = [...lines].reverse().find((candidate) => candidate.startsWith('{'));
  if (!line) throw new Error(`${label} returned no result.`);
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`${label} returned invalid data: ${error.message}`);
  }
}

function describeWindow(info) {
  if (!info) return 'no foreground window';
  const title = String(info.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const process = info.processName || 'unknown process';
  const pid = info.processId ? ` pid=${info.processId}` : '';
  return `handle=${info.handle || 'unknown'} class=${info.className || 'unknown'} title="${title || '(none)'}" processName=${process}${pid}${info.resolved ? ' (resolved packaged app window)' : ''}`;
}

async function getFocusedTarget(options = {}) {
  let target;
  try {
    target = await enqueueFocusCapture();
  } catch (error) {
    logger.warn('focus', `Warm foreground helper unavailable (${error.message}); falling back to a one-shot capture.`);
    const output = await runPowerShell(FOCUS_SCRIPT, 5000);
    target = parseHelperResult(output, 'The foreground window capture');
  }
  if (!target || typeof target.id !== 'string' || !target.id) throw new Error('No foreground window is available.');
  const ignoreProcessId = Number(options?.ignoreProcessId);
  if (Number.isFinite(ignoreProcessId) && Number(target.processId) === ignoreProcessId) return null;
  return target;
}

function appProcessAliases(name) {
  const key = String(name || '').toLowerCase().replace(/\.exe$/i, '').replace(/\s+/g, ' ').trim();
  const aliases = PROCESS_ALIASES.get(key) || [];
  return new Set([key.replace(/\s+/g, ''), ...aliases].filter(Boolean));
}

function parseWindowRows(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// Find a visible top-level window for an app by process name or title. The
// agent uses this after open_app so a follow-up type_text has a concrete
// window to bring forward instead of relying on whatever happens to be
// focused at that moment.
async function findAppWindow(name, options = {}) {
  const aliases = appProcessAliases(name);
  const wanted = String(name || '').toLowerCase().replace(/\.exe$/i, '').trim();
  if (!aliases.size && !wanted) return null;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let rows = [];
    try {
      rows = parseWindowRows(await runPowerShell(LIST_WINDOWS_SCRIPT, 8000, options.signal));
    } catch (error) {
      if (error.cancelled) throw error;
      logger.warn('focus', `Could not list windows: ${error.message}`);
    }
    const candidates = rows.filter((row) => {
      const processName = String(row?.processName || '').toLowerCase().replace(/\.exe$/i, '');
      const title = String(row?.title || '').toLowerCase();
      if (!row?.visible || !row?.title) return false;
      if (Number(row.processId) === process.pid) return false;
      if (PROTECTED_PROCESS_SET.has(processName)) return false;
      if (FRAME_HOST_BLOCKLIST.has(processName)) return false;
      return aliases.has(processName) || (wanted && title.includes(wanted));
    });
    if (candidates.length) {
      candidates.sort((left, right) => {
        const leftExact = aliases.has(String(left.processName || '').toLowerCase()) ? 1 : 0;
        const rightExact = aliases.has(String(right.processName || '').toLowerCase()) ? 1 : 0;
        return rightExact - leftExact;
      });
      return candidates[0];
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

// Bring a captured window back to the foreground before typing. The window may
// have lost focus while the agent was thinking, or it may have been opened by
// an earlier open_app call.
async function focusTarget(target, signal) {
  if (!target?.handle && !target?.id) throw new Error('Voxa could not identify the window to focus.');
  const rawHandle = target.resolved && target.frameHandle ? target.frameHandle : target.handle;
  const handle = parseWindowHandle(rawHandle);
  if (!handle) throw new Error('Voxa could not identify the window to focus.');
  const output = await runPowerShell(FOCUS_WINDOW_SCRIPT(handle), 8000, signal);
  const result = parseHelperResult(output, 'The window focus helper');
  if (!result?.ok) throw new Error(result?.error || 'Windows did not switch to the target window.');
  return result.foreground || null;
}

function parseShortcut(shortcut) {
  const clean = String(shortcut || '').trim();
  if (!clean || clean.length > 80) throw new Error('Shortcut is empty.');
  const parts = clean.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new Error('Shortcut is empty.');
  const modifiers = [];
  let key = null;
  for (const part of parts) {
    if (['ctrl', 'control'].includes(part)) {
      if (!modifiers.includes('^')) modifiers.push('^');
    } else if (part === 'alt') {
      if (!modifiers.includes('%')) modifiers.push('%');
    } else if (part === 'shift') {
      if (!modifiers.includes('+')) modifiers.push('+');
    } else if (['win', 'meta', 'super', 'cmd'].includes(part)) {
      throw new Error('The Windows key is not supported in shortcuts.');
    } else {
      if (key) throw new Error('Only one non-modifier key is allowed.');
      key = part;
    }
  }
  if (!key) throw new Error('Shortcut needs a key.');
  if (/^[a-z0-9]$/.test(key)) return [...modifiers, key].join('');
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return `${modifiers.join('')}{${key.toUpperCase()}}`;
  const alias = KEY_ALIASES[key];
  if (!alias) throw new Error(`Unsupported shortcut key: ${key}`);
  return `${modifiers.join('')}${alias}`;
}

function validateShortcut(shortcut) {
  parseShortcut(shortcut);
  return true;
}

async function assertTarget(expected) {
  if (!expected?.id) return;
  const current = await getFocusedTarget().catch(() => null);
  if (!current || current.id !== expected.id) throw new Error('The focused app changed, so nothing was typed. Try again.');
}

function insertionFailure(result) {
  const errorCode = Number(result?.errorCode) || 0;
  if (result?.result === 'target-changed') {
    return 'The focused app changed before Voxa could type, so nothing was inserted. Try again and keep the target app focused.';
  }
  if (result?.targetElevated || errorCode === 5) {
    return 'The focused app is running as administrator, so Voxa cannot type into it. Restart that app without administrator rights, or run Voxa as administrator and try again.';
  }
  const foreground = result?.foreground;
  if (!foreground || foreground.handle === '0x0' || !foreground.processId) {
    return 'No window has focus, so Voxa could not insert the text. Click into the app you want to use and try again.';
  }
  const detail = String(result?.error || '').trim();
  if (detail) return `Text insertion failed: ${detail}`;
  return 'Text insertion failed: Windows did not accept the keyboard input for the focused app.';
}

async function typeText(text, expectedTarget, signal) {
  const value = String(text || '');
  if (!value.trim()) throw new Error('There is no text to type.');
  if (!expectedTarget?.id) throw new Error('Voxa could not confirm which app to type into. Click into the target app and try again.');
  if (signal?.aborted) {
    const cancelled = new Error('Cancelled.');
    cancelled.cancelled = true;
    throw cancelled;
  }
  await focusTarget(expectedTarget, signal);
  await assertTarget(expectedTarget);
  const file = path.join(os.tmpdir(), `voxa-typing-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, value, 'utf8');
  let result;
  try {
    // The typing script embeds the native helper classes and is too large for
    // PowerShell's -EncodedCommand argument limit on Windows. Run it from a
    // temporary .ps1 file so long text and future helper additions stay safe.
    const output = await runPowerShellFile(TYPE_SCRIPT(file, expectedTarget.id), 30000, signal);
    result = parseHelperResult(output, 'The text insertion helper');
  } catch (error) {
    if (error.cancelled) throw error;
    logger.error('typing', `Text insertion helper failed: ${error.message}`);
    throw new Error(`Text insertion failed: ${error.message}`);
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Temporary text is cleaned up on the next OS pass if this fails.
    }
  }
  const windowInfo = describeWindow(result.foreground);
  logger.info('typing', `Foreground target: ${windowInfo}${result.targetElevated ? ' [elevated]' : ''}`);
  logger.info('typing', `Clipboard set: ${Boolean(result.clipboardSet)}; previous clipboard restored: ${Boolean(result.clipboardRestored)}; ${windowInfo}`);
  logger.info('typing', `Keystroke sent: ${Boolean(result.keystrokeSent)}${result.method ? ` via ${result.method}` : ''}; ${windowInfo}`);
  if (!['pasted', 'typed'].includes(result.result)) {
    const message = insertionFailure(result);
    logger.error('typing', `Result: failed - ${message}; ${windowInfo}`);
    throw new Error(message);
  }
  logger.info('typing', `Result: ${result.result}; clipboardSet=${Boolean(result.clipboardSet)}; keystrokeSent=${Boolean(result.keystrokeSent)}; ${windowInfo}`);
  return result;
}

async function pressKeys(shortcut, target, signal) {
  if (!target?.id) throw new Error('Voxa could not confirm which app should receive the shortcut. Try again.');
  await focusTarget(target, signal);
  await assertTarget(target);
  const sequence = parseShortcut(shortcut);
  await runPowerShell(PRESS_SCRIPT(sequence), 10000, signal);
}

function normalizeCloseName(value) {
  return String(value || '').trim().toLowerCase().replace(/\.exe$/i, '').replace(/\s+/g, '');
}

function normalizeAppQuery(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^(?:open|launch|start|close)\s+/, '')
    .replace(/\b(?:the|app)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function addProcessName(names, value) {
  const text = String(value || '').trim().toLowerCase().replace(/\.exe$/i, '').replace(/\s+/g, ' ');
  if (!text) return;
  const compact = text.replace(/\s+/g, '');
  if (compact && /^[a-z0-9._+-]+$/.test(compact)) names.add(compact);
  if (/^[a-z0-9._+-]+$/.test(text)) names.add(text);
}

function processNamesFor(entry, query) {
  const names = new Set();
  const sources = [entry?.name, normalizeAppQuery(query)].filter(Boolean);
  for (const source of sources) {
    addProcessName(names, source);
    addProcessName(names, source.replace(/^(microsoft|google|mozilla|windows|adobe)\s+/i, ''));
    const key = String(source).toLowerCase().replace(/\s+/g, ' ').trim();
    const compact = key.replace(/\s+/g, '');
    for (const [aliasKey, aliasNames] of PROCESS_ALIASES) {
      if (aliasKey === key || aliasKey.replace(/\s+/g, '') === compact) {
        for (const aliasName of aliasNames) addProcessName(names, aliasName);
      }
    }
  }
  if (entry?.launch) {
    const launch = String(entry.launch).trim();
    const base = launch.split(/[\\/]/).pop() || launch;
    addProcessName(names, base.replace(/[:]+$/, ''));
  }
  return [...names].filter((name) => name.length <= 100);
}

function closeTitleNeedles(entry, query) {
  const needles = new Set();
  const add = (value) => {
    const clean = String(value || '').toLowerCase().replace(/[^a-z0-9.+ -]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    needles.add(clean);
    const stripped = clean.replace(/^(microsoft|google|mozilla|windows|adobe)\s+/, '').trim();
    if (stripped) needles.add(stripped);
  };
  add(entry?.name);
  add(normalizeAppQuery(query));
  return [...needles].slice(0, 8);
}

function closeAppRefusal(value) {
  const key = normalizeCloseName(value);
  if (!key) return '';
  if (key === 'explorer' || key === 'fileexplorer' || key === 'windowsexplorer') {
    return 'I cannot close File Explorer because it is the Windows shell.';
  }
  if (key === 'voxa' || key === 'electron' || key === 'myvoiceapp') {
    return 'I cannot close Voxa itself.';
  }
  if (PROTECTED_PROCESS_SET.has(key)) {
    return `I cannot close ${key}. It is a protected Windows process.`;
  }
  return '';
}

function parseWindowHandle(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value || '').trim();
  if (!text) return 0;
  const parsed = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number(text);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

async function runCloseHelper(plan) {
  let output;
  try {
    output = await runPowerShellFile(closeScript(plan), 25000);
  } catch (error) {
    logger.warn('close', `The close helper failed for ${plan.label}: ${error.message}`);
    throw new Error(`I could not close ${plan.label}: ${error.message}`);
  }
  return parseHelperResult(output, 'The close helper');
}

function formatCloseResult(result, label, force) {
  if (!result || typeof result !== 'object') throw new Error('The close helper returned no result.');
  if (result.refused) throw new Error(String(result.refused));
  if (result.message) return String(result.message);
  const windowsClosed = Math.max(0, Number(result.windowsClosed) || 0);
  const windowWord = windowsClosed === 1 ? 'window' : 'windows';
  const remaining = Math.max(0, Number(result.remaining) || 0);
  const killed = Math.max(0, Number(result.killed) || 0);
  const matched = Math.max(0, Number(result.matched) || 0);
  const rawProcess = String(result.processName || '').toLowerCase();
  const processLabel = rawProcess && rawProcess !== 'applicationframehost'
    ? (rawProcess.endsWith('.exe') ? rawProcess : `${rawProcess}.exe`)
    : label;
  if (matched === 0) {
    if (killed > 0 && !result.processRunning) {
      return `Closed 0 windows for ${label} (${processLabel}). Force-closed ${killed} background process${killed === 1 ? '' : 'es'}; it is no longer running.`;
    }
    if (result.processRunning) return `${label} is running but has no windows to close.`;
    return `${label} is not running.`;
  }
  if (result.forced) {
    if (remaining > 0) {
      return `Closed ${windowsClosed} ${windowWord} for ${label} (${processLabel}) and force-closed ${killed} process${killed === 1 ? '' : 'es'}, but ${remaining} ${remaining === 1 ? 'window is' : 'windows are'} still open. It may be elevated.`;
    }
    return `Closed ${windowsClosed} ${windowWord} for ${label} (${processLabel}) after force-closing ${killed} process${killed === 1 ? '' : 'es'}. ${result.processRunning ? 'It is still running in the background.' : 'It is no longer running.'}`;
  }
  if (remaining > 0) return CLOSE_STILL_OPEN_MESSAGE;
  return `Closed ${windowsClosed} ${windowWord} for ${label} (${processLabel}). ${result.processRunning ? 'It is still running in the background.' : 'It is no longer running.'}`;
}

async function closeFocusedApp(providedTarget, force) {
  let focused = providedTarget;
  if (!focused || (!focused.id && !focused.handle)) {
    try {
      focused = await getFocusedTarget();
    } catch {
      throw new Error('No window is focused, so there is nothing to close.');
    }
  }
  if (!focused || (!focused.id && !focused.handle)) throw new Error('No window is focused, so there is nothing to close.');
  const processName = String(focused.processName || '').toLowerCase();
  const frameProcessName = String(focused.frameProcessName || '').toLowerCase();
  const refusal = closeAppRefusal(processName) || (!focused.resolved ? closeAppRefusal(frameProcessName) : '');
  if (refusal) throw new Error(refusal);
  if (Number(focused.processId) === process.pid) throw new Error('I cannot close Voxa itself.');
  const handle = parseWindowHandle(focused.resolved && focused.frameHandle ? focused.frameHandle : focused.handle);
  if (!handle) throw new Error('Voxa could not identify the focused window.');
  const rawLabel = String(focused.title || focused.processName || 'the focused window').replace(/\s+/g, ' ').trim();
  const label = rawLabel.slice(0, 120) || 'the focused window';
  const result = await runCloseHelper({
    selfPid: process.pid,
    processNames: [...new Set([processName].filter(Boolean))],
    titleNeedles: [],
    focusHandles: [handle],
    focusPids: Number.isFinite(Number(focused.processId)) ? [Number(focused.processId)] : [],
    focusProcessName: processName,
    force,
    label
  });
  return formatCloseResult(result, label, force);
}

async function closeApp(query, options = {}) {
  const force = options.force === true;
  const raw = String(query || '').trim();
  if (!raw || /^(it|that)$/i.test(raw)) {
    const lastApp = typeof options.lastApp === 'string' ? { name: options.lastApp } : options.lastApp;
    if (lastApp?.name && !/^(it|that)$/i.test(String(lastApp.name).trim())) {
      return closeApp(lastApp.name, { ...options, lastApp: null, force });
    }
    return closeFocusedApp(options.focusedTarget || null, force);
  }
  const refusal = closeAppRefusal(raw);
  if (refusal) throw new Error(refusal);
  const entry = apps.findApp(raw);
  const label = String(entry?.name || normalizeAppQuery(raw) || raw).replace(/\s+/g, ' ').trim().slice(0, 120);
  const processNames = processNamesFor(entry, raw);
  if (!processNames.length) throw new Error(`I could not find a running app matching "${raw}". It is not running.`);
  const namesRefusal = processNames.map((name) => closeAppRefusal(name)).find(Boolean);
  if (namesRefusal) throw new Error(namesRefusal);
  const result = await runCloseHelper({
    selfPid: process.pid,
    processNames,
    titleNeedles: closeTitleNeedles(entry, raw),
    focusHandles: [],
    focusPids: [],
    focusProcessName: '',
    force,
    label
  });
  return formatCloseResult(result, label, force);
}

function resolveUserDirectory(value) {
  let text = String(value || '').trim();
  if (!text) throw new Error('No folder was provided.');
  if (text.length > 1000) throw new Error('That folder path is too long.');
  const name = text.toLowerCase();
  const mapping = {
    home: () => app.getPath('home'),
    desktop: () => app.getPath('desktop'),
    documents: () => app.getPath('documents'),
    downloads: () => app.getPath('downloads'),
    pictures: () => app.getPath('pictures'),
    music: () => app.getPath('music'),
    videos: () => app.getPath('videos')
  };
  text = mapping[name] ? mapping[name]() : text;
  if (text === '~' || text.startsWith(`~${path.sep}`) || text.startsWith('~/')) {
    text = path.join(app.getPath('home'), text.slice(1));
  }
  if (!path.isAbsolute(text)) text = path.join(app.getPath('home'), text);
  const resolved = realPath(text);
  if (!resolved) throw new Error(`I could not find ${path.basename(text) || 'that folder'}.`);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error('That folder could not be opened.');
  }
  if (!stat.isDirectory()) throw new Error('That path is not a folder.');
  const root = userFileRoots().find((candidate) => withinRoot(resolved, candidate));
  if (!root) throw new Error('Only folders inside your Home, Desktop, Documents, Downloads, Pictures, Music, or Videos folders can be opened.');
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const sensitiveKind = parts.some((part) => permissions.isSensitiveDirectory(part)) ? 'credentials' : '';
  return { path: resolved, name: path.basename(resolved) || resolved, sensitiveKind };
}

function folderPath(folder) {
  return resolveUserDirectory(folder).path;
}

async function openFolder(folder) {
  const target = resolveUserDirectory(folder);
  const result = await shell.openPath(target.path);
  if (result) throw new Error(result);
}

function realPath(value) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch {
    return null;
  }
}

function withinRoot(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function userFileRoots() {
  const roots = [];
  for (const name of ['home', 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) {
    try {
      const resolved = realPath(app.getPath(name));
      if (resolved && !roots.some((root) => root.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
    } catch {
      // Some known folders are optional on a Windows profile.
    }
  }
  return roots;
}

function resolveUserFile(value) {
  let text = String(value || '').trim();
  if (!text) throw new Error('No file path was provided.');
  if (text.length > 1000) throw new Error('That file path is too long.');
  if (text === '~' || text.startsWith(`~${path.sep}`) || text.startsWith('~/')) {
    text = path.join(app.getPath('home'), text.slice(1));
  }
  if (!path.isAbsolute(text)) text = path.join(app.getPath('home'), text);
  const resolved = realPath(text);
  if (!resolved) throw new Error(`I could not find ${path.basename(text) || 'that file'}.`);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error('That file could not be read.');
  }
  if (!stat.isFile()) throw new Error('That path is not a file.');
  const root = userFileRoots().find((candidate) => withinRoot(resolved, candidate));
  if (!root) throw new Error('Only files inside your Home, Desktop, Documents, Downloads, Pictures, Music, or Videos folders can be used.');
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let sensitiveKind = '';
  if (parts.some((part) => permissions.isSensitiveDirectory(part)) || permissions.isSensitiveFileName(path.basename(resolved))) {
    sensitiveKind = 'credentials';
  } else if (permissions.isExecutableFile(resolved)) {
    sensitiveKind = 'executable';
  }
  return { path: resolved, name: path.basename(resolved), sensitiveKind };
}

async function openFile(file) {
  const target = resolveUserFile(file);
  const result = await shell.openPath(target.path);
  if (result) throw new Error(result);
  return `Opened ${target.name}.`;
}

function looksBinary(text) {
  const sample = String(text || '').slice(0, 8192);
  if (!sample) return false;
  let bad = 0;
  for (const character of sample) {
    const code = character.codePointAt(0);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f || character === '\uFFFD') bad += 1;
  }
  return bad / sample.length > 0.02;
}

function decodeUtf16Be(buffer) {
  const length = buffer.length - (buffer.length % 2);
  const swapped = Buffer.alloc(length);
  for (let index = 0; index < length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString('utf16le').replace(/^\uFEFF/, '');
}

function decodeTextBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('The file could not be decoded.');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: decodeUtf16Be(buffer.subarray(2)), encoding: 'utf-16be' };
  }
  if (buffer.includes(0)) {
    const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
    let evenZeros = 0;
    let oddZeros = 0;
    for (let index = 0; index < sample.length; index += 1) {
      if (sample[index] !== 0) continue;
      if (index % 2 === 0) evenZeros += 1;
      else oddZeros += 1;
    }
    if (evenZeros > oddZeros * 2) {
      const text = decodeUtf16Be(buffer);
      if (!looksBinary(text)) return { text, encoding: 'utf-16be' };
    } else {
      const text = buffer.toString('utf16le');
      if (!looksBinary(text)) return { text, encoding: 'utf-16le' };
    }
    throw new Error('The file is not a text file.');
  }
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (looksBinary(text)) throw new Error('The file is not a text file.');
  return { text, encoding: 'utf-8' };
}

async function readFile(file) {
  const target = resolveUserFile(file);
  let stat;
  try {
    stat = fs.statSync(target.path);
  } catch {
    throw new Error(`Could not read ${target.name}.`);
  }
  if (stat.size > MAX_READ_FILE_BYTES) throw new Error(`${target.name} is too large to read.`);
  let buffer;
  try {
    buffer = fs.readFileSync(target.path);
  } catch {
    throw new Error(`Could not read ${target.name}.`);
  }
  let decoded;
  try {
    decoded = decodeTextBuffer(buffer);
  } catch {
    throw new Error(`${target.name} is not a text file.`);
  }
  let text = decoded.text;
  const truncated = text.length > MAX_READ_FILE_CHARS;
  if (truncated) text = text.slice(0, MAX_READ_FILE_CHARS);
  return `Read ${target.name}${truncated ? ' (truncated)' : ''}:\n\n${text}`;
}

function validUrl(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 2000) throw new Error('URL is empty or too long.');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('URL is not valid. Include https://.');
  }
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links can be opened.');
  if (parsed.username || parsed.password) throw new Error('Links with embedded credentials are not allowed.');
  return parsed.href;
}

async function openUrl(url) {
  await shell.openExternal(validUrl(url));
}

async function webSearch(query) {
  const text = String(query || '').trim();
  if (!text || text.length > 500) throw new Error('Search text must be between 1 and 500 characters.');
  await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(text)}`);
}

module.exports = {
  getFocusedTarget,
  findAppWindow,
  focusTarget,
  warmFocusHelper,
  disposeFocusHelper,
  describeWindow,
  typeText,
  pressKeys,
  closeApp,
  closeAppRefusal,
  parseShortcut,
  validateShortcut,
  openFolder,
  folderPath,
  resolveUserDirectory,
  resolveUserFile,
  openFile,
  readFile,
  decodeTextBuffer,
  validUrl,
  openUrl,
  webSearch
};
