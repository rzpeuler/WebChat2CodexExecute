import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const WINDOW_CONTROLLER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$rootPid = __ROOT_PID__
$showCommand = __SHOW_COMMAND__

$processIds = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$processIds.Add([uint32]$rootPid)
$edgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($process in $edgeProcesses) {
    if ($processIds.Contains([uint32]$process.ParentProcessId) -and $processIds.Add([uint32]$process.ProcessId)) {
      $changed = $true
    }
  }
}

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

  public static int SetForProcesses(uint[] processIds, int command) {
    var changed = 0;
    EnumWindows((hWnd, lParam) => {
      uint ownerPid;
      GetWindowThreadProcessId(hWnd, out ownerPid);
      foreach (var processId in processIds) {
        if (ownerPid == processId) {
          if (ShowWindowAsync(hWnd, command)) changed++;
          if (command != 0) SetForegroundWindow(hWnd);
          break;
        }
      }
      return true;
    }, IntPtr.Zero);
    return changed;
  }
}
'@

$windowCount = [W2CWindowController]::SetForProcesses([uint32[]]$processIds, $showCommand)
if ($windowCount -eq 0) { exit 2 }
`;

export async function setWindowsProcessWindowVisibility(processId: number, visible: boolean): Promise<void> {
  if (process.platform !== 'win32' || !Number.isInteger(processId) || processId <= 0) return;
  const script = WINDOW_CONTROLLER_SCRIPT.replace('__ROOT_PID__', String(processId)).replace(
    '__SHOW_COMMAND__',
    visible ? '9' : '0',
  );
  await execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    },
  );
}
