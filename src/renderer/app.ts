import type { ProjectConfigInput, ProjectScanResult } from '../shared/contracts/project-config.js';

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
let scanResult: ProjectScanResult | null = null;

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
