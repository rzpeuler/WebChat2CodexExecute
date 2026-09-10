import type { ProjectConfigInput, ProjectScanResult } from '../shared/contracts/project-config.js';
import type { DashboardCommand, DashboardCommandName, DashboardSnapshot } from '../shared/contracts/dashboard.js';

const statusElement = document.querySelector<HTMLElement>('#status');
const versionElement = document.querySelector<HTMLElement>('#version');
const form = document.querySelector<HTMLFormElement>('#project-form');
const localPathElement = document.querySelector<HTMLInputElement>('#local-path');
const remoteUrlElement = document.querySelector<HTMLInputElement>('#remote-url');
const directoryNameElement = document.querySelector<HTMLInputElement>('#directory-name');
const targetBranchElement = document.querySelector<HTMLInputElement>('#target-branch');
const reportDirectoryElement = document.querySelector<HTMLInputElement>('#report-directory');
const detailsElement = document.querySelector<HTMLElement>('#project-details');
const promptElement = document.querySelector<HTMLElement>('#prompt-preview');
const scanButton = document.querySelector<HTMLButtonElement>('#scan');
const selectDirectoryButton = document.querySelector<HTMLButtonElement>('#select-directory');
const cloneInitializeButton = document.querySelector<HTMLButtonElement>('#clone-initialize');
const adoptInitializeButton = document.querySelector<HTMLButtonElement>('#adopt-initialize');
const previewButton = document.querySelector<HTMLButtonElement>('#preview');
const dashboardProjectElement = document.querySelector<HTMLElement>('#dashboard-project');
const dashboardSolElement = document.querySelector<HTMLElement>('#dashboard-sol');
const dashboardStageElement = document.querySelector<HTMLElement>('#dashboard-stage');
const dashboardTaskElement = document.querySelector<HTMLElement>('#dashboard-task');
const dashboardRevisionsElement = document.querySelector<HTMLElement>('#dashboard-revisions');
const dashboardLunaElement = document.querySelector<HTMLElement>('#dashboard-luna');
const dashboardCommitsElement = document.querySelector<HTMLElement>('#dashboard-commits');
const dashboardErrorElement = document.querySelector<HTMLElement>('#dashboard-error');
let scanResult: ProjectScanResult | null = null;

const dangerousDashboardCommands = new Set<DashboardCommandName>(['start', 'pause', 'retry-current-stage', 'rebind']);

function setStatus(message: string): void {
  if (statusElement !== null) {
    statusElement.textContent = message;
  }
}

function getConfigInput(): ProjectConfigInput {
  if (localPathElement === null || targetBranchElement === null || reportDirectoryElement === null) {
    throw new Error('Project form is unavailable');
  }
  if (scanResult === null) {
    throw new Error('请先扫描 Git 项目');
  }
  return {
    projectId: scanResult.projectId,
    localPath: scanResult.localPath,
    remoteUrl: scanResult.remoteUrl,
    targetBranch: targetBranchElement.value,
    reportDirectory: reportDirectoryElement.value,
    currentBranch: scanResult.currentBranch,
    headCommit: scanResult.headCommit,
    governanceManifestPath: scanResult.governanceManifestPath,
  };
}

async function scanSelectedProject(): Promise<void> {
  if (localPathElement === null || detailsElement === null) return;
  if (localPathElement.value.trim() === '') throw new Error('请先选择本地项目目录');
  scanResult = await window.desktopApi.scanProject(localPathElement.value);
  localPathElement.value = scanResult.localPath;
  if (remoteUrlElement !== null) remoteUrlElement.value = scanResult.remoteUrl ?? '';
  if (targetBranchElement !== null) targetBranchElement.value = scanResult.currentBranch;
  detailsElement.textContent = JSON.stringify(scanResult, null, 2);
}

async function initializeProject(mode: 'clone' | 'adopt'): Promise<void> {
  if (localPathElement === null) return;
  const selectedDirectory = localPathElement.value.trim();
  if (selectedDirectory === '') throw new Error('请先选择本地目录');
  const input =
    mode === 'clone'
      ? {
          mode,
          parentDirectory: selectedDirectory,
          directoryName: directoryNameElement?.value.trim() ?? '',
          remoteUrl: remoteUrlElement?.value.trim() ?? '',
          ...(targetBranchElement?.value.trim() ? { targetBranch: targetBranchElement.value.trim() } : {}),
        }
      : { mode, targetDirectory: selectedDirectory };
  setStatus(mode === 'clone' ? '正在克隆并初始化项目…' : '正在备份并初始化治理目录…');
  const result = await window.desktopApi.initializeProject(input);
  localPathElement.value = result.projectRoot;
  await scanSelectedProject();
  setStatus(
    result.idempotent
      ? '项目治理已是最新状态，未重复覆盖。'
      : `项目初始化完成${result.remoteCommit === undefined ? '' : `，已同步 ${result.remoteCommit}`}。请保存配置。`,
  );
}

async function checkRemoteAccess(): Promise<void> {
  if (localPathElement === null || remoteUrlElement === null) return;
  if (localPathElement.value.trim() === '') throw new Error('请先选择本地目录');
  if (remoteUrlElement.value.trim() === '') throw new Error('请先输入远程仓库地址');
  setStatus('正在检查 Git 远程授权…');
  const result = await window.desktopApi.checkProjectRemoteAccess({
    directory: localPathElement.value.trim(),
    remoteUrl: remoteUrlElement.value.trim(),
  });
  setStatus(result.message);
}

function renderDashboard(snapshot: DashboardSnapshot): void {
  if (dashboardProjectElement !== null) {
    dashboardProjectElement.textContent = snapshot.project?.name ?? '未选择项目';
  }
  if (dashboardSolElement !== null) {
    dashboardSolElement.textContent =
      snapshot.activeSolSession === null
        ? '无'
        : `${snapshot.activeSolSession.sessionId} / ${snapshot.activeSolSession.status}`;
  }
  if (dashboardStageElement !== null) dashboardStageElement.textContent = `${snapshot.stage} / ${snapshot.status}`;
  if (dashboardTaskElement !== null) dashboardTaskElement.textContent = snapshot.taskId ?? '无';
  if (dashboardRevisionsElement !== null) {
    dashboardRevisionsElement.textContent = `${snapshot.governanceRevision ?? '—'} / ${snapshot.architectureRevisions.join(', ') || '—'}`;
  }
  if (dashboardLunaElement !== null) {
    dashboardLunaElement.textContent =
      snapshot.luna.sessionId === null ? snapshot.luna.status : `${snapshot.luna.status} / ${snapshot.luna.sessionId}`;
  }
  if (dashboardCommitsElement !== null) {
    dashboardCommitsElement.textContent = `本地 ${snapshot.commits.local ?? '—'} / 远端 ${snapshot.commits.remote ?? '—'}`;
  }
  if (dashboardErrorElement !== null) {
    dashboardErrorElement.textContent =
      snapshot.recentError === null ? '无' : `${snapshot.recentError.code}: ${snapshot.recentError.message}`;
  }
}

async function refreshDashboard(): Promise<void> {
  try {
    renderDashboard(await window.desktopApi.getDashboardSnapshot());
  } catch {
    if (dashboardErrorElement !== null) dashboardErrorElement.textContent = '状态面板不可用';
  }
}

function dashboardCommandFromButton(button: HTMLButtonElement): DashboardCommand | null {
  const command = button.dataset.dashboardCommand;
  if (
    command === undefined ||
    ![
      'start',
      'pause',
      'retry-current-stage',
      'rebind',
      'governance-consistency-check',
      'open-edge',
      'open-project',
      'view-report',
    ].includes(command)
  ) {
    return null;
  }
  if (dangerousDashboardCommands.has(command as DashboardCommandName)) {
    if (!window.confirm(`确认执行“${command}”？`)) return null;
    return { command: command as 'start' | 'pause' | 'retry-current-stage' | 'rebind', confirm: true };
  }
  return { command: command as 'governance-consistency-check' | 'open-edge' | 'open-project' | 'view-report' };
}

if (statusElement !== null && versionElement !== null) {
  window.desktopApi
    .getRuntimeInfo()
    .then((runtimeInfo) => {
      statusElement.textContent = '就绪 — 尚未运行自动化循环。';
      versionElement.textContent = `Version ${runtimeInfo.version}`;
    })
    .catch(() => {
      statusElement.textContent = '就绪';
      versionElement.textContent = '运行时信息不可用';
    });
}

void refreshDashboard();

document.querySelectorAll<HTMLButtonElement>('[data-dashboard-command]').forEach((button) => {
  button.addEventListener('click', async () => {
    const command = dashboardCommandFromButton(button);
    if (command === null) return;
    try {
      const result = await window.desktopApi.executeDashboardCommand(command);
      setStatus(result.message);
      await refreshDashboard();
    } catch {
      setStatus('状态面板命令执行失败');
    }
  });
});

scanButton?.addEventListener('click', async () => {
  setStatus('正在扫描 Git 仓库…');
  try {
    await scanSelectedProject();
    if (scanResult === null) throw new Error('扫描没有返回项目');
    setStatus(
      scanResult.governanceManifestStatus === 'invalid'
        ? `扫描完成，但 governance manifest 无效：${scanResult.governanceManifestError?.message ?? '未知错误'}`
        : '扫描完成，请确认目标分支和报告目录。',
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '项目扫描失败');
  }
});

selectDirectoryButton?.addEventListener('click', async () => {
  try {
    const selected = await window.desktopApi.selectProjectDirectory();
    if (selected !== null && localPathElement !== null) {
      localPathElement.value = selected;
      setStatus('已选择本地目录，请选择扫描、克隆或接管初始化。');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '选择目录失败');
  }
});

document.querySelector<HTMLButtonElement>('#check-git-access')?.addEventListener('click', async () => {
  try {
    await checkRemoteAccess();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Git 远程授权检查失败');
  }
});

cloneInitializeButton?.addEventListener('click', async () => {
  try {
    await initializeProject('clone');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '克隆初始化失败');
  }
});

adoptInitializeButton?.addEventListener('click', async () => {
  try {
    await initializeProject('adopt');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '已有项目初始化失败');
  }
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const config = await window.desktopApi.saveProjectConfig(getConfigInput());
    setStatus(`配置已保存：${config.projectId}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '配置保存失败');
  }
});

previewButton?.addEventListener('click', async () => {
  if (promptElement === null) return;
  try {
    const preview = await window.desktopApi.previewSolPrompt(getConfigInput());
    promptElement.textContent = preview.initializationPrompt;
    setStatus('Sol 初始化提示词预览已生成。');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '提示词预览失败');
  }
});
