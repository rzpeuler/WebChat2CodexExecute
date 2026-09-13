import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const PROCESS_TREE_SCRIPT = String.raw`
$rootPid = __ROOT_PID__
$ownershipToken = '__OWNERSHIP_TOKEN__'
$userDataDirectory = '__USER_DATA_DIRECTORY__'
$processIds = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$processIds.Add([uint32]$rootPid)
$edgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")
$edgeProcesses | ForEach-Object {
  $commandLine = [string]$_.CommandLine
  if (($ownershipToken -ne '' -and $commandLine -like "*$ownershipToken*") -or
      ($userDataDirectory -ne '' -and $commandLine -like "*$userDataDirectory*")) {
    [void]$processIds.Add([uint32]$_.ProcessId)
  }
}
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $edgeProcesses) {
    if ($processIds.Contains([uint32]$process.ParentProcessId) -and $processIds.Add([uint32]$process.ProcessId)) {
      $changed = $true
    }
  }
}
`;

const WINDOW_CONTROLLER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
__PROCESS_TREE_SCRIPT__
$showCommand = __SHOW_COMMAND__
$excludedWindowHandle = [IntPtr]::new(__EXCLUDED_WINDOW_HANDLE__)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class W2CWindowController {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  public static int SetForProcesses(uint[] processIds, int command, IntPtr excludedWindowHandle) {
    var changed = 0;
    EnumWindows((hWnd, lParam) => {
      uint ownerPid;
      GetWindowThreadProcessId(hWnd, out ownerPid);
      foreach (var processId in processIds) {
        if (ownerPid == processId) {
          if (excludedWindowHandle != IntPtr.Zero && hWnd == excludedWindowHandle) break;
          ShowWindowAsync(hWnd, command);
          if (command != 0) SetForegroundWindow(hWnd);
          changed++;
          break;
        }
      }
      return true;
    }, IntPtr.Zero);
    return changed;
  }
}
'@

[void][W2CWindowController]::SetForProcesses([uint32[]]$processIds, $showCommand, $excludedWindowHandle)
`;

const WINDOW_LOOKUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
__PROCESS_TREE_SCRIPT__

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class W2CWindowFinder {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  public static long Find(uint[] processIds) {
    var foreground = GetForegroundWindow();
    if (BelongsTo(foreground, processIds)) return foreground.ToInt64();
    long firstWindow = 0;
    EnumWindows((hWnd, lParam) => {
      if (!BelongsTo(hWnd, processIds)) return true;
      if (firstWindow == 0) firstWindow = hWnd.ToInt64();
      if (IsWindowVisible(hWnd)) return false;
      return true;
    }, IntPtr.Zero);
    return firstWindow;
  }

  private static bool BelongsTo(IntPtr hWnd, uint[] processIds) {
    if (hWnd == IntPtr.Zero) return false;
    uint ownerPid;
    GetWindowThreadProcessId(hWnd, out ownerPid);
    foreach (var processId in processIds) if (ownerPid == processId) return true;
    return false;
  }
}
'@

$windowHandle = [W2CWindowFinder]::Find([uint32[]]$processIds)
if ($windowHandle -ne 0) { [Console]::WriteLine($windowHandle) }
`;

const WINDOW_VISIBILITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$windowHandle = [IntPtr]::new(__WINDOW_HANDLE__)
$command = __SHOW_COMMAND__
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class W2CWindowVisibility {
  [DllImport("user32.dll")]
  private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  public static void Set(IntPtr hWnd, int command) { ShowWindowAsync(hWnd, command); }
}
'@
[W2CWindowVisibility]::Set($windowHandle, $command)
`;

function powershellSingleQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function fillProcessTreeScript(
  template: string,
  processId: number,
  ownershipToken: string,
  userDataDirectory: string,
): string {
  return template
    .replace('__PROCESS_TREE_SCRIPT__', PROCESS_TREE_SCRIPT)
    .replace('__ROOT_PID__', String(processId))
    .replace('__OWNERSHIP_TOKEN__', powershellSingleQuote(ownershipToken))
    .replace('__USER_DATA_DIRECTORY__', powershellSingleQuote(userDataDirectory));
}

async function runHiddenPowerShell(script: string): Promise<string> {
  const result = await execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    { windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024 },
  );
  return result.stdout.trim();
}

export async function findOwnedEdgeProcessId(ownershipToken: string, userDataDirectory = ''): Promise<number | null> {
  if (process.platform !== 'win32' || ownershipToken.trim() === '') return null;
  const output = await runHiddenPowerShell(
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { ([string]$_.CommandLine -like "*${powershellSingleQuote(ownershipToken)}*") -or ([string]$_.CommandLine -like "*${powershellSingleQuote(userDataDirectory)}*") } | Select-Object -First 1 -ExpandProperty ProcessId`,
  );
  const processId = Number.parseInt(output, 10);
  return Number.isInteger(processId) && processId > 0 ? processId : null;
}

export async function findOwnedEdgeWindowHandle(
  processId: number,
  ownershipToken: string,
  userDataDirectory: string,
): Promise<number | null> {
  if (process.platform !== 'win32' || !Number.isInteger(processId) || processId <= 0) return null;
  const output = await runHiddenPowerShell(
    fillProcessTreeScript(WINDOW_LOOKUP_SCRIPT, processId, ownershipToken, userDataDirectory),
  );
  const windowHandle = Number.parseInt(output, 10);
  return Number.isInteger(windowHandle) && windowHandle > 0 ? windowHandle : null;
}

export async function setWindowsProcessWindowVisibility(
  processId: number,
  visible: boolean,
  ownershipToken = '',
  userDataDirectory = '',
  excludedWindowHandle: number | null = null,
): Promise<void> {
  if (process.platform !== 'win32' || !Number.isInteger(processId) || processId <= 0) return;
  const script = fillProcessTreeScript(WINDOW_CONTROLLER_SCRIPT, processId, ownershipToken, userDataDirectory)
    .replace('__SHOW_COMMAND__', visible ? '9' : '0')
    .replace('__EXCLUDED_WINDOW_HANDLE__', String(excludedWindowHandle ?? 0));
  await runHiddenPowerShell(script);
}

export async function setWindowsWindowVisibility(windowHandle: number, visible: boolean): Promise<void> {
  if (process.platform !== 'win32' || !Number.isInteger(windowHandle) || windowHandle <= 0) return;
  const script = WINDOW_VISIBILITY_SCRIPT.replace('__WINDOW_HANDLE__', String(windowHandle)).replace(
    '__SHOW_COMMAND__',
    visible ? '9' : '0',
  );
  await runHiddenPowerShell(script);
}
