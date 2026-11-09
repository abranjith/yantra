# Spike S2 - Windows Job object probe and kill-on-close harness.
#   -Mode probe : reports whether this process is in a job and that job's limit flags.
#   -Mode run   : creates a job with -Flags, joins it, runs the launcher (which spawns the
#                 worker detached), waits for -WaitFile, then exits so the job handle closes.
param(
  [string]$Mode = 'probe',
  [uint32]$Flags = 0,
  [string]$Node = '',
  [string]$Launcher = '',
  [string]$LaunchFile = '',
  [string]$Out = '',
  [string]$Via = 'direct',
  [int]$WindowPid = 0
)

if ($Mode -eq 'close-window') {
  # Posts WM_CLOSE to a console host's window: exactly what clicking the window's X does.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SpikeWindow {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  public static int Close(uint owner) {
    int posted = 0;
    EnumWindows((h, p) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == owner) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); posted++; } return true; }, IntPtr.Zero);
    return posted;
  }
}
'@
  Write-Output ([SpikeWindow]::Close([uint32]$WindowPid))
  exit 0
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class SpikeJob {
  [StructLayout(LayoutKind.Sequential)]
  public struct Basic {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Io {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Extended {
    public Basic BasicLimitInformation;
    public Io IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  public static string Probe() {
    bool inJob;
    IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob);
    if (!inJob) return "{\"inJob\":false}";
    Extended info = new Extended();
    bool ok = QueryInformationJobObject(IntPtr.Zero, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)), IntPtr.Zero);
    if (!ok) return "{\"inJob\":true,\"queryError\":" + Marshal.GetLastWin32Error() + "}";
    return "{\"inJob\":true,\"limitFlags\":" + info.BasicLimitInformation.LimitFlags + "}";
  }

  public static string Join(uint flags) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "create:" + Marshal.GetLastWin32Error();
    Extended info = new Extended();
    info.BasicLimitInformation.LimitFlags = flags;
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended))))
      return "set:" + Marshal.GetLastWin32Error();
    if (!AssignProcessToJobObject(job, GetCurrentProcess()))
      return "assign:" + Marshal.GetLastWin32Error();
    return "ok";
  }
}
'@

if ($Mode -eq 'probe') {
  [SpikeJob]::Probe()
  exit 0
}

$joined = [SpikeJob]::Join($Flags)
if ($joined -ne 'ok') {
  Write-Output "job:$joined"
  exit 7
}
& $Node $Launcher --launch $LaunchFile --out $Out --via $Via
$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-Path $Out) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
Write-Output 'job:ok'
exit 0
