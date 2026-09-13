import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const WINDOW_CONTROLLER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$rootPid = __ROOT_PID__
$showCommand = __SHOW_COMMAND__
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

[void][W2CWindowController]::SetForProcesses([uint32[]]$processIds, $showCommand)
`;

const ROOT_PROCESS_LOOKUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ownershipToken = '__OWNERSHIP_TOKEN__'
$userDataDirectory = '__USER_DATA_DIRECTORY__'
$process = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object {
    $commandLine = [string]$_.CommandLine
    ($ownershipToken -ne '' -and $commandLine -like "*$ownershipToken*") -or
      ($userDataDirectory -ne '' -and $commandLine -like "*$userDataDirectory*")
  } |
  Select-Object -First 1
if ($null -ne $process) { [Console]::WriteLine([int]$process.ProcessId) }
`;

function powershellSingleQuote(value: string): string {
  return value.replaceAll("'", "''");
}

async function runHiddenPowerShell(script: string): Promise<string> {
  const result = await execFile(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
    {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    },
  );
  return result.stdout.trim();
}

export async function findOwnedEdgeProcessId(ownershipToken: string, userDataDirectory = ''): Promise<number | null> {
  if (process.platform !== 'win32' || ownershipToken.trim() === '') return null;
  const output = await runHiddenPowerShell(
    ROOT_PROCESS_LOOKUP_SCRIPT.replace('__OWNERSHIP_TOKEN__', powershellSingleQuote(ownershipToken)).replace(
      '__USER_DATA_DIRECTORY__',
      powershellSingleQuote(userDataDirectory),
    ),
  );
  const processId = Number.parseInt(output, 10);
  return Number.isInteger(processId) && processId > 0 ? processId : null;
}

export async function setWindowsProcessWindowVisibility(
  processId: number,
  visible: boolean,
  ownershipToken = '',
  userDataDirectory = '',
): Promise<void> {
  if (process.platform !== 'win32' || !Number.isInteger(processId) || processId <= 0) return;
  const script = WINDOW_CONTROLLER_SCRIPT.replace('__ROOT_PID__', String(processId))
    .replace('__SHOW_COMMAND__', visible ? '9' : '0')
    .replace('__OWNERSHIP_TOKEN__', powershellSingleQuote(ownershipToken))
    .replace('__USER_DATA_DIRECTORY__', powershellSingleQuote(userDataDirectory));
  await runHiddenPowerShell(script);
}
