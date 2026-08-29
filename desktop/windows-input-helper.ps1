param([switch]$DryRun)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshRemoteInput {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }
  delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint threadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG message, IntPtr window, uint minimum, uint maximum);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG message);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  static readonly HashSet<ushort> DownKeys = new HashSet<ushort>();
  static readonly HashSet<string> DownButtons = new HashSet<string>();
  static readonly object OutputLock = new object();
  static readonly HookProc MouseHookProc = OnMouseHook;
  static readonly HookProc KeyboardHookProc = OnKeyboardHook;
  static readonly UIntPtr RemoteInputMarker = new UIntPtr(0x44534852u);
  static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);
  static Thread WatchThread;
  static uint WatchThreadId;
  static IntPtr MouseHook;
  static IntPtr KeyboardHook;
  static long LastPhysicalInputTicks;
  static long WatchStartedTicks;

  static bool IsPhysicalMouseAction(IntPtr message) {
    long value = message.ToInt64();
    return value == 0x0201L || value == 0x0204L || value == 0x0207L || value == 0x020BL || value == 0x020AL || value == 0x020EL;
  }
  static bool IsPhysicalKeyboardAction(IntPtr message) {
    long value = message.ToInt64();
    return value == 0x0100L || value == 0x0104L;
  }
  static bool LocalInputWatchReady() {
    long started = Interlocked.Read(ref WatchStartedTicks);
    return started != 0 && DateTime.UtcNow.Ticks - started >= TimeSpan.TicksPerMillisecond * 800;
  }

  static void ReportPhysicalInput(string kind) {
    long now = DateTime.UtcNow.Ticks;
    long previous = Interlocked.Read(ref LastPhysicalInputTicks);
    if (now - previous < TimeSpan.TicksPerMillisecond * 100) return;
    Interlocked.Exchange(ref LastPhysicalInputTicks, now);
    lock (OutputLock) { Console.Out.WriteLine("{\"event\":\"local-input\",\"kind\":\"" + kind + "\"}"); Console.Out.Flush(); }
  }
  static IntPtr OnMouseHook(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0 && IsPhysicalMouseAction(wParam) && LocalInputWatchReady()) { var value = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT)); if ((value.flags & 0x01u) == 0 && !value.extra.Equals(RemoteInputMarker)) ReportPhysicalInput("mouse"); }
    return CallNextHookEx(MouseHook, code, wParam, lParam);
  }
  static IntPtr OnKeyboardHook(int code, IntPtr wParam, IntPtr lParam) {
    if (code >= 0 && IsPhysicalKeyboardAction(wParam) && LocalInputWatchReady()) { var value = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT)); if ((value.flags & 0x12u) == 0 && !value.extra.Equals(RemoteInputMarker)) ReportPhysicalInput("keyboard"); }
    return CallNextHookEx(KeyboardHook, code, wParam, lParam);
  }
  public static void ConfigureDpiAwareness() { SetThreadDpiAwarenessContext(PerMonitorAwareV2); }
  public static void StartLocalInputWatch() {
    if (WatchThread != null) return;
    WatchThread = new Thread(() => {
      SetThreadDpiAwarenessContext(PerMonitorAwareV2);
      WatchThreadId = GetCurrentThreadId();
      IntPtr module = GetModuleHandle(null);
      MouseHook = SetWindowsHookEx(14, MouseHookProc, module, 0);
      KeyboardHook = SetWindowsHookEx(13, KeyboardHookProc, module, 0);
      Interlocked.Exchange(ref WatchStartedTicks, DateTime.UtcNow.Ticks);
      MSG message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
      if (MouseHook != IntPtr.Zero) UnhookWindowsHookEx(MouseHook);
      if (KeyboardHook != IntPtr.Zero) UnhookWindowsHookEx(KeyboardHook);
      MouseHook = IntPtr.Zero; KeyboardHook = IntPtr.Zero; WatchThreadId = 0; Interlocked.Exchange(ref WatchStartedTicks, 0);
    });
    WatchThread.IsBackground = true;
    WatchThread.SetApartmentState(ApartmentState.STA);
    WatchThread.Start();
  }
  public static void StopLocalInputWatch() { if (WatchThreadId != 0) PostThreadMessage(WatchThreadId, 0x0012u, UIntPtr.Zero, IntPtr.Zero); WatchThread = null; }

  static void Send(INPUT input) { if (SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new System.ComponentModel.Win32Exception(); }
  static void Mouse(uint flags, uint data=0, int dx=0, int dy=0) { Send(new INPUT { type=0, U=new INPUTUNION { mi=new MOUSEINPUT { dx=dx, dy=dy, mouseData=data, flags=flags, extra=RemoteInputMarker } } }); }
  static uint DownFlag(string button) { return button == "right" ? 0x0008u : button == "middle" ? 0x0020u : 0x0002u; }
  static uint UpFlag(string button) { return button == "right" ? 0x0010u : button == "middle" ? 0x0040u : 0x0004u; }
  public static void Move(int x, int y) {
    SetThreadDpiAwarenessContext(PerMonitorAwareV2);
    int left=GetSystemMetrics(76), top=GetSystemMetrics(77), width=GetSystemMetrics(78), height=GetSystemMetrics(79);
    int nx=(int)Math.Round((x-left)*65535.0/Math.Max(1,width-1)), ny=(int)Math.Round((y-top)*65535.0/Math.Max(1,height-1));
    Mouse(0x0001u|0x8000u|0x4000u,0,nx,ny);
  }
  public static void Button(string action, string button) {
    if (action == "down") { Mouse(DownFlag(button)); DownButtons.Add(button); }
    else if (action == "up") { Mouse(UpFlag(button)); DownButtons.Remove(button); }
    else if (action == "click") { Mouse(DownFlag(button)); Mouse(UpFlag(button)); }
    else if (action == "double-click") { Mouse(DownFlag(button)); Mouse(UpFlag(button)); Mouse(DownFlag(button)); Mouse(UpFlag(button)); }
  }
  public static void Wheel(int dx, int dy) { if (dy != 0) Mouse(0x0800u, unchecked((uint)dy)); if (dx != 0) Mouse(0x1000u, unchecked((uint)dx)); }
  static void Key(ushort vk, bool down) { Send(new INPUT { type=1, U=new INPUTUNION { ki=new KEYBDINPUT { vk=vk, flags=down ? 0u : 0x0002u, extra=RemoteInputMarker } } }); if (down) DownKeys.Add(vk); else DownKeys.Remove(vk); }
  public static void Press(ushort[] codes, string action) {
    if (action == "down") { foreach (var code in codes) Key(code,true); return; }
    if (action == "up") { for (int i=codes.Length-1;i>=0;i--) Key(codes[i],false); return; }
    foreach (var code in codes) Key(code,true); for (int i=codes.Length-1;i>=0;i--) Key(codes[i],false);
  }
  public static void Text(string text) { foreach (char ch in text) { Send(new INPUT { type=1, U=new INPUTUNION { ki=new KEYBDINPUT { scan=ch, flags=0x0004u, extra=RemoteInputMarker } } }); Send(new INPUT { type=1, U=new INPUTUNION { ki=new KEYBDINPUT { scan=ch, flags=0x0004u|0x0002u, extra=RemoteInputMarker } } }); } }
  public static void ReleaseAll() { foreach (var button in new List<string>(DownButtons)) Mouse(UpFlag(button)); DownButtons.Clear(); foreach (var key in new List<ushort>(DownKeys)) Key(key,false); DownKeys.Clear(); }
}
'@

if (-not $DryRun) { Add-Type -TypeDefinition $source -Language CSharp; [DshRemoteInput]::ConfigureDpiAwareness(); [DshRemoteInput]::StartLocalInputWatch() }

function Invoke-CommandObject($command) {
  $type = [string]$command.type
  if ($DryRun) {
    [Console]::Out.WriteLine((@{ ok=$true; type=$type } | ConvertTo-Json -Compress))
    if ($type -eq 'shutdown') { return $false }
    return $true
  }
  switch ($type) {
    'pointer' {
      [DshRemoteInput]::Move([int]$command.x, [int]$command.y)
      [DshRemoteInput]::Button([string]$command.action, [string]$command.button)
    }
    'wheel' { [DshRemoteInput]::Wheel([int]$command.deltaX, [int]$command.deltaY) }
    'key' { [DshRemoteInput]::Press([ushort[]]$command.codes, [string]$command.action) }
    'text' { [DshRemoteInput]::Text([string]$command.text) }
    'release-all' { [DshRemoteInput]::ReleaseAll() }
    'ping' { }
    'shutdown' { [DshRemoteInput]::ReleaseAll(); return $false }
    default { throw 'unsupported command' }
  }
  return $true
}

try {
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    if ($line.Length -gt 4096) { continue }
    try {
      $command = $line | ConvertFrom-Json
      $continue = Invoke-CommandObject $command
      if ($continue -eq $false) { break }
    } catch {
      [Console]::Error.WriteLine('invalid command')
    }
  }
} finally {
  if (-not $DryRun) { [DshRemoteInput]::ReleaseAll(); [DshRemoteInput]::StopLocalInputWatch() }
}
