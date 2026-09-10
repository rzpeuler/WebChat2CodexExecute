import type { ProjectConfigInput, ProjectScanResult } from '../shared/contracts/project-config.js';
import type { DashboardCommand, DashboardCommandName, DashboardSnapshot } from '../shared/contracts/dashboard.js';

const statusElement = document.querySelector<HTMLElement>('#status');
const versionElement = document.querySelector<HTMLElement>('#version');
const form = document.querySelector<HTMLFormElement>('#project-form');
const localPathElement = document.querySelector<HTMLInputElement>('#local-path');
const targetBranchElement = document.querySelector<HTMLInputElement>('#target-branch');
const reportDirectoryElement = document.querySelector<HTMLInputElement>('#report-directory');
const detailsElement = document.querySelector<HTMLElement>('#project-details');
const promptElement = document.querySelector<HTMLElement>('#prompt-preview');
const scanButton = document.querySelector<HTMLButtonElement>('#scan');
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
    !['start', 'pause', 'retry-current-stage', 'rebind', 'open-edge', 'open-project', 'view-report'].includes(command)
  ) {
    return null;
  }
  if (dangerousDashboardCommands.has(command as DashboardCommandName)) {
    if (!window.confirm(`确认执行“${command}”？`)) return null;
    return { command: command as 'start' | 'pause' | 'retry-current-stage' | 'rebind', confirm: true };
  }
  return { command: command as 'open-edge' | 'open-project' | 'view-report' };
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
  if (localPathElement === null || detailsElement === null) return;
  setStatus('正在扫描 Git 仓库…');
  try {
    scanResult = await window.desktopApi.scanProject(localPathElement.value);
    localPathElement.value = scanResult.localPath;
    if (targetBranchElement !== null) targetBranchElement.value = scanResult.currentBranch;
    detailsElement.textContent = JSON.stringify(scanResult, null, 2);
    setStatus(
      scanResult.governanceManifestStatus === 'invalid'
        ? `扫描完成，但 governance manifest 无效：${scanResult.governanceManifestError?.message ?? '未知错误'}`
        : '扫描完成，请确认目标分支和报告目录。',
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '项目扫描失败');
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
