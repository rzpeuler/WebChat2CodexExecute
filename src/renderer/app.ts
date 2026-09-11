import type { ProjectConfig, ProjectConfigInput, ProjectScanResult } from '../shared/contracts/project-config.js';
import { LOOP_GRAPH_NODE_DEFINITIONS } from '../shared/contracts/dashboard.js';
import type {
  DashboardActionState,
  DashboardCommand,
  DashboardCommandName,
  DashboardSnapshot,
  LoopGraphNodeId,
  LoopGraphNodeSnapshot,
  LoopGraphNodeState,
} from '../shared/contracts/dashboard.js';

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
const viewProjectDetailsButton = document.querySelector<HTMLButtonElement>('#view-project-details');
const scanButton = document.querySelector<HTMLButtonElement>('#scan');
const selectDirectoryButton = document.querySelector<HTMLButtonElement>('#select-directory');
const checkGitAccessButton = document.querySelector<HTMLButtonElement>('#check-git-access');
const cloneInitializeButton = document.querySelector<HTMLButtonElement>('#clone-initialize');
const adoptInitializeButton = document.querySelector<HTMLButtonElement>('#adopt-initialize');
const saveButton = document.querySelector<HTMLButtonElement>('#save');
const previewButton = document.querySelector<HTMLButtonElement>('#preview');
const dashboardHeaderProjectElement = document.querySelector<HTMLElement>('#dashboard-header-project');
const dashboardStatusBadgeElement = document.querySelector<HTMLElement>('#dashboard-status-badge');
const dashboardUpdatedAtElement = document.querySelector<HTMLElement>('#dashboard-updated-at');
const dashboardProjectElement = document.querySelector<HTMLElement>('#dashboard-project');
const dashboardSolElement = document.querySelector<HTMLElement>('#dashboard-sol');
const dashboardStageElement = document.querySelector<HTMLElement>('#dashboard-stage');
const dashboardTaskElement = document.querySelector<HTMLElement>('#dashboard-task');
const dashboardRevisionsElement = document.querySelector<HTMLElement>('#dashboard-revisions');
const dashboardLunaElement = document.querySelector<HTMLElement>('#dashboard-luna');
const dashboardCommitsElement = document.querySelector<HTMLElement>('#dashboard-commits');
const dashboardErrorElement = document.querySelector<HTMLElement>('#dashboard-error');
const dashboardSuggestionElement = document.querySelector<HTMLElement>('#dashboard-suggestion');
const loopGraphElement = document.querySelector<HTMLElement>('#loop-graph');
const loopGraphRoundElement = document.querySelector<HTMLElement>('#loop-graph-round');
const loopGraphDetailsElement = document.querySelector<HTMLElement>('#loop-graph-details');
const loopGraphDetailsTitleElement = document.querySelector<HTMLElement>('#loop-graph-details-title');
const loopGraphDetailsStateElement = document.querySelector<HTMLElement>('#loop-graph-details-state');
const loopGraphDetailsSummaryElement = document.querySelector<HTMLElement>('#loop-graph-details-summary');
const loopGraphDetailsListElement = document.querySelector<HTMLUListElement>('#loop-graph-details-list');
const helpButton = document.querySelector<HTMLButtonElement>('#help-button');
const helpDialog = document.querySelector<HTMLElement>('#help-dialog');
const helpCloseButton = document.querySelector<HTMLButtonElement>('#help-close');
const contentDialog = document.querySelector<HTMLElement>('#content-dialog');
const contentDialogTitleElement = document.querySelector<HTMLElement>('#content-dialog-title');
const contentDialogBodyElement = document.querySelector<HTMLElement>('#content-dialog-body');
const contentCopyButton = document.querySelector<HTMLButtonElement>('#content-copy');
const contentCloseButton = document.querySelector<HTMLButtonElement>('#content-close');

let scanResult: ProjectScanResult | null = null;
let currentSnapshot: DashboardSnapshot | null = null;
let refreshInFlight: Promise<void> | null = null;
let helpPreviouslyFocused: HTMLElement | null = null;
let contentPreviouslyFocused: HTMLElement | null = null;
let savedProjectLoadCompleted = false;
let selectedLoopGraphNodeId: LoopGraphNodeSnapshot['id'] | null = null;
let lastCurrentLoopGraphNodeId: LoopGraphNodeSnapshot['id'] | null = null;
const loopGraphNodeButtons = new Map<LoopGraphNodeId, LoopGraphButtonParts>();
const pendingDashboardCommands = new Set<DashboardCommandName>();

const dangerousDashboardCommands = new Set<DashboardCommandName>(['start', 'pause', 'retry-current-stage', 'rebind']);
const dashboardCommandNames: DashboardCommandName[] = [
  'start',
  'pause',
  'retry-current-stage',
  'continue-interrupted',
  'rebind',
  'governance-consistency-check',
  'open-edge',
  'open-project',
  'view-report',
];
const stageLabels: Record<string, string> = {
  IDLE: '待启动',
  READING_SOL: '读取 Sol',
  PARSING: '解析任务',
  APPLYING_UPDATES: '应用更新',
  SYNCING_GOVERNANCE: '同步治理',
  RUNNING_LUNA: '执行 Luna',
  SYNCING_CODE: '同步代码',
  NOTIFYING_SOL: '通知 Sol',
  WAITING_FOR_SOL: '等待 Sol',
  PAUSED: '已暂停',
  FAILED: '执行失败',
};
const statusLabels: Record<string, string> = {
  IDLE: '待机',
  ARMED: '已准备',
  RUNNING: '运行中',
  PAUSED: '已暂停',
  NEEDS_USER_ACTION: '需要用户处理',
  FAILED: '失败',
};
const lunaLabels: Record<string, string> = {
  NOT_STARTED: '未开始',
  RUNNING: '执行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  PAUSED: '已暂停',
};
const solLabels: Record<string, string> = {
  THINKING: '思考中',
  COMPLETED_CANDIDATE: '等待确认',
  NETWORK_ERROR: '网络错误',
  CONTEXT_LIMIT: '上下文已满',
  AUTH_REQUIRED: '需要授权',
  SESSION_LOST: '会话已丢失',
  AMBIGUOUS: '状态不明确',
};
const loopGraphStateLabels: Record<LoopGraphNodeState, string> = {
  PENDING: '待处理',
  ACTIVE: '执行中',
  COMPLETED: '已完成',
  RECOVERABLE_BLOCKED: '可恢复阻塞',
  NEEDS_USER_ACTION: '需要用户处理',
  PAUSED: '已暂停',
  NOT_APPLICABLE: '不适用',
};

interface LoopGraphButtonParts {
  wrapper: HTMLElement;
  button: HTMLButtonElement;
  id: HTMLElement;
  label: HTMLElement;
  summary: HTMLElement;
  stateLabel: HTMLElement;
  actions: HTMLElement;
  startButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  retryButton: HTMLButtonElement;
  continueButton: HTMLButtonElement;
}

function setStatus(message: string): void {
  if (statusElement !== null) statusElement.textContent = message;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

function errorSuggestion(message: string): string {
  if (/登录|授权|credential|token|api key|otp/i.test(message)) return '建议：完成登录或授权后重试。';
  if (/协议|冲突|范围|replan|规划|writing block/i.test(message)) return '建议：请让 Sol 重新输出/规划任务。';
  return '建议：查看 Dashboard 最近异常和动作禁用原因。';
}

function showOperationError(error: unknown, fallback: string): void {
  const message = errorMessage(error, fallback);
  setStatus(`${message} ${errorSuggestion(message)}`);
}

function projectRelativePath(localPath: string, childPath: string): string {
  const root = localPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const child = childPath.replaceAll('\\', '/');
  const rootKey = root.toLowerCase();
  const childKey = child.toLowerCase();
  if (childKey === rootKey) return '.';
  if (childKey.startsWith(`${rootKey}/`)) return child.slice(root.length + 1);
  return childPath;
}

function hydrateSavedProjectConfig(config: ProjectConfig): void {
  if (localPathElement !== null) localPathElement.value = config.localPath;
  if (remoteUrlElement !== null) remoteUrlElement.value = config.remoteUrl ?? '';
  if (targetBranchElement !== null) targetBranchElement.value = config.targetBranch;
  if (reportDirectoryElement !== null)
    reportDirectoryElement.value = projectRelativePath(config.localPath, config.reportDirectory);
}

async function loadSavedProjectConfig(): Promise<void> {
  try {
    const configs = await window.desktopApi.loadProjectConfigs();
    const saved = configs[0];
    if (saved === undefined) {
      setStatus('就绪 — 尚未运行自动化循环。');
      return;
    }

    hydrateSavedProjectConfig(saved);
    setStatus(`已加载上次项目配置：${saved.localPath}，正在刷新 Git 状态…`);
    try {
      const scanned = await window.desktopApi.scanProject(saved.localPath);
      scanResult = { ...scanned, projectId: saved.projectId };
      if (localPathElement !== null) localPathElement.value = scanned.localPath;
      if (remoteUrlElement !== null) remoteUrlElement.value = scanned.remoteUrl ?? '';
      if (targetBranchElement !== null) targetBranchElement.value = saved.targetBranch;
      if (reportDirectoryElement !== null)
        reportDirectoryElement.value = projectRelativePath(saved.localPath, saved.reportDirectory);
      if (detailsElement !== null) detailsElement.textContent = JSON.stringify(scanned, null, 2);
      if (viewProjectDetailsButton !== null) viewProjectDetailsButton.disabled = false;
      setStatus(`已加载上次项目：${scanned.localPath}。Git 状态已刷新。`);
    } catch (error) {
      if (detailsElement !== null) detailsElement.textContent = JSON.stringify(saved, null, 2);
      setStatus(`已加载上次项目配置，但 Git 状态刷新失败：${errorMessage(error, '未知错误')} 请重新扫描。`);
    }
  } finally {
    savedProjectLoadCompleted = true;
  }
}

function getConfigInput(): ProjectConfigInput {
  if (localPathElement === null || targetBranchElement === null || reportDirectoryElement === null) {
    throw new Error('项目表单不可用');
  }
  if (scanResult === null) throw new Error('请先扫描 Git 项目');
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
  if (viewProjectDetailsButton !== null) viewProjectDetailsButton.disabled = false;
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
  const result = await window.desktopApi.initializeProject(input);
  localPathElement.value = result.projectRoot;
  await scanSelectedProject();
  setStatus(
    result.idempotent
      ? '项目治理已是最新状态，未重复覆盖。'
      : `项目初始化完成${result.remoteCommit === undefined ? '' : `，已同步 ${result.remoteCommit}`}。请保存配置。`,
  );
}

async function checkRemoteAccess(): Promise<string> {
  if (localPathElement === null || remoteUrlElement === null) throw new Error('项目表单不可用');
  if (localPathElement.value.trim() === '') throw new Error('请先选择本地目录');
  if (remoteUrlElement.value.trim() === '') throw new Error('请先输入远程仓库地址');
  const result = await window.desktopApi.checkProjectRemoteAccess({
    directory: localPathElement.value.trim(),
    remoteUrl: remoteUrlElement.value.trim(),
  });
  return result.message;
}

function setButtonsBusy(buttons: Array<HTMLButtonElement | null>, busy: boolean): void {
  buttons.forEach((button) => {
    if (button === null) return;
    if (busy) {
      if (button.dataset.idleLabel === undefined) button.dataset.idleLabel = button.textContent ?? '';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = `${button.dataset.idleLabel}（处理中）`;
    } else {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (button.dataset.idleLabel !== undefined) button.textContent = button.dataset.idleLabel;
    }
  });
}

async function runProjectOperation<T>(options: {
  buttons: Array<HTMLButtonElement | null>;
  startMessage: string;
  action: () => Promise<T>;
  successMessage: string | ((value: T) => string);
  errorFallback: string;
}): Promise<T | null> {
  if (options.buttons.some((button) => button?.disabled === true)) return null;
  setButtonsBusy(options.buttons, true);
  setStatus(options.startMessage);
  try {
    const result = await options.action();
    setStatus(typeof options.successMessage === 'function' ? options.successMessage(result) : options.successMessage);
    return result;
  } catch (error) {
    showOperationError(error, options.errorFallback);
    return null;
  } finally {
    setButtonsBusy(options.buttons, false);
  }
}

function getStageLabel(stage: string): string {
  return stageLabels[stage] ?? (stage || '未知阶段');
}

function getStatusLabel(status: string): string {
  return statusLabels[status] ?? (status || '未知状态');
}

function getLunaLabel(status: string): string {
  return lunaLabels[status] ?? (status || '未知');
}

function getSolLabel(status: string): string {
  return solLabels[status] ?? (status || '未知');
}

function formatUpdatedAt(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) return '—';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp);
}

function readActionState(snapshot: DashboardSnapshot, command: DashboardCommandName): DashboardActionState {
  const action = snapshot.actions?.[command];
  if (action === undefined) return { enabled: false, busy: false, reason: '状态动作不可用，请刷新状态面板。' };
  return action;
}

function actionReasonSuggestion(snapshot: DashboardSnapshot): string | null {
  for (const command of dashboardCommandNames) {
    const action = readActionState(snapshot, command);
    if (!action.enabled && action.reason !== null) return action.reason;
  }
  return null;
}

function getDashboardSuggestion(snapshot: DashboardSnapshot): string {
  if (snapshot.recentError?.code === 'EXECUTION_RECOVERY_CONFIRMATION_REQUIRED') {
    return '请查看解析任务书节点的执行摘要，确认无误后点击“继续执行”。';
  }
  if (
    snapshot.recentError !== null &&
    /WRITING_BLOCK|PROTOCOL|INVALID_RESULT|BASELINE_CHANGED|GOVERNANCE.*(?:CONFLICT|BLOCKED)|CONFLICT|SCOPE|SOL_BLOCKED|WRONG_ENTRYPOINT/i.test(
      snapshot.recentError.code,
    )
  ) {
    return '请让 Sol 重新输出/规划任务，不要重复旧输出。';
  }
  const actionReason = actionReasonSuggestion(snapshot);
  if (actionReason !== null) return actionReason;
  if (snapshot.recentError !== null) {
    return '请查看最近异常的诊断，并按提示完成修复后再执行可用动作。';
  }
  if (snapshot.status === 'NEEDS_USER_ACTION') return '请完成登录、授权、API Key 或 OTP 等外部操作。';
  if (snapshot.status === 'IDLE') return '请先完成项目准备和 Web Chat 会话绑定。';
  return '当前没有需要用户处理的事项。';
}

function loopGraphNode(snapshot: DashboardSnapshot, nodeId: LoopGraphNodeSnapshot['id']): LoopGraphNodeSnapshot {
  return (
    snapshot.loopGraph.nodes.find((node) => node.id === nodeId) ?? {
      id: nodeId,
      label: LOOP_GRAPH_NODE_DEFINITIONS.find((definition) => definition.id === nodeId)?.label ?? nodeId,
      state: 'PENDING',
      summary: '',
      details: [],
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(0).toISOString(),
    }
  );
}

function renderLoopGraphDetails(node: LoopGraphNodeSnapshot | null): void {
  if (
    loopGraphDetailsElement === null ||
    loopGraphDetailsTitleElement === null ||
    loopGraphDetailsStateElement === null ||
    loopGraphDetailsSummaryElement === null ||
    loopGraphDetailsListElement === null
  )
    return;
  loopGraphDetailsListElement.replaceChildren();
  if (node === null) {
    loopGraphDetailsElement.hidden = true;
    loopGraphDetailsElement.setAttribute('aria-expanded', 'false');
    return;
  }
  loopGraphDetailsElement.hidden = false;
  loopGraphDetailsElement.setAttribute('aria-expanded', 'true');
  loopGraphDetailsTitleElement.textContent = `${node.label}（${node.id}）`;
  loopGraphDetailsStateElement.textContent = loopGraphStateLabels[node.state];
  loopGraphDetailsStateElement.className = `loop-graph-details-state state-${node.state.toLowerCase()}`;
  loopGraphDetailsSummaryElement.textContent = node.summary || '暂无摘要。';
  for (const detail of node.details) {
    const item = document.createElement('li');
    item.textContent = detail;
    loopGraphDetailsListElement.append(item);
  }
  if (node.details.length === 0) {
    const item = document.createElement('li');
    item.textContent = '暂无更多详情。';
    loopGraphDetailsListElement.append(item);
  }
}

function selectLoopGraphNode(nodeId: LoopGraphNodeSnapshot['id']): void {
  selectedLoopGraphNodeId = nodeId;
  if (currentSnapshot !== null) renderLoopGraphDetails(loopGraphNode(currentSnapshot, nodeId));
  loopGraphNodeButtons.get(nodeId)?.button.focus();
}

function ensureLoopGraphButtons(): void {
  if (loopGraphElement === null || loopGraphNodeButtons.size === LOOP_GRAPH_NODE_DEFINITIONS.length) return;
  for (const definition of LOOP_GRAPH_NODE_DEFINITIONS) {
    const wrapper = document.createElement('div');
    wrapper.className = 'loop-node-wrapper';
    wrapper.setAttribute('role', 'listitem');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'loop-node state-pending';
    button.dataset.loopNodeId = definition.id;
    button.setAttribute('aria-controls', 'loop-graph-details');
    const id = document.createElement('span');
    id.className = 'loop-node-id';
    const label = document.createElement('span');
    label.className = 'loop-node-label';
    const summary = document.createElement('span');
    summary.className = 'loop-node-summary';
    const state = document.createElement('span');
    state.className = 'loop-node-state';
    const marker = document.createElement('span');
    marker.className = 'loop-node-state-marker';
    marker.setAttribute('aria-hidden', 'true');
    const stateLabel = document.createElement('span');
    stateLabel.className = 'loop-node-state-label';
    state.append(marker, stateLabel);
    button.append(id, label, summary, state);
    button.addEventListener('click', () => selectLoopGraphNode(definition.id));
    const actions = document.createElement('div');
    actions.className = 'loop-node-actions';
    actions.setAttribute('aria-label', `${definition.label}操作`);
    const createActionButton = (command: DashboardCommandName, text: string): HTMLButtonElement => {
      const actionButton = document.createElement('button');
      actionButton.type = 'button';
      actionButton.className = 'loop-node-action button-secondary';
      actionButton.dataset.dashboardCommand = command;
      actionButton.textContent = text;
      return actionButton;
    };
    const startButton = createActionButton('start', '启动');
    const pauseButton = createActionButton('pause', '暂停');
    const retryButton = createActionButton('retry-current-stage', '重试');
    const continueButton = createActionButton('continue-interrupted', '继续执行');
    actions.append(startButton, pauseButton, retryButton, continueButton);
    wrapper.append(button, actions);
    loopGraphElement.append(wrapper);
    loopGraphNodeButtons.set(definition.id, {
      wrapper,
      button,
      id,
      label,
      summary,
      stateLabel,
      actions,
      startButton,
      pauseButton,
      retryButton,
      continueButton,
    });
  }
}

function renderLoopGraph(snapshot: DashboardSnapshot): void {
  if (loopGraphElement === null) return;
  const currentNodeId = snapshot.loopGraph.currentNodeId;
  if (currentNodeId !== lastCurrentLoopGraphNodeId) {
    selectedLoopGraphNodeId = currentNodeId;
    lastCurrentLoopGraphNodeId = currentNodeId;
  }
  if (selectedLoopGraphNodeId !== null) {
    selectedLoopGraphNodeId = LOOP_GRAPH_NODE_DEFINITIONS.some(({ id }) => id === selectedLoopGraphNodeId)
      ? selectedLoopGraphNodeId
      : currentNodeId;
  }
  ensureLoopGraphButtons();
  for (const definition of LOOP_GRAPH_NODE_DEFINITIONS) {
    const node = loopGraphNode(snapshot, definition.id);
    const parts = loopGraphNodeButtons.get(node.id);
    if (parts === undefined) continue;
    parts.button.className = `loop-node state-${node.state.toLowerCase()}`;
    parts.button.setAttribute('aria-expanded', String(selectedLoopGraphNodeId === node.id));
    parts.button.setAttribute('aria-current', String(currentNodeId === node.id));
    parts.id.textContent = node.id;
    parts.label.textContent = node.label;
    parts.summary.textContent = node.summary || '暂无摘要。';
    parts.stateLabel.textContent = loopGraphStateLabels[node.state];
    parts.startButton.hidden = node.id !== 'read-sol' || snapshot.status === 'RUNNING';
    parts.pauseButton.hidden = !(currentNodeId === node.id && node.state === 'ACTIVE');
    parts.retryButton.hidden = !(
      currentNodeId === node.id &&
      (node.state === 'RECOVERABLE_BLOCKED' || node.state === 'NEEDS_USER_ACTION' || node.state === 'PAUSED')
    );
    parts.continueButton.hidden = !(
      snapshot.recovery !== null &&
      snapshot.recovery.interruptedNodeId === node.id &&
      snapshot.recovery.error !== null &&
      node.state === 'NEEDS_USER_ACTION'
    );
    parts.actions.hidden =
      parts.startButton.hidden && parts.pauseButton.hidden && parts.retryButton.hidden && parts.continueButton.hidden;
  }
  if (loopGraphRoundElement !== null)
    loopGraphRoundElement.textContent = `当前轮次：${snapshot.loopGraph.roundId ?? '—'}`;
  renderLoopGraphDetails(selectedLoopGraphNodeId === null ? null : loopGraphNode(snapshot, selectedLoopGraphNodeId));
}

function applyDashboardActionStates(snapshot: DashboardSnapshot): void {
  document.querySelectorAll<HTMLButtonElement>('[data-dashboard-command]').forEach((button) => {
    const command = button.dataset.dashboardCommand as DashboardCommandName | undefined;
    if (command === undefined || !dashboardCommandNames.includes(command)) return;
    if (button.dataset.dashboardLabel === undefined) button.dataset.dashboardLabel = button.textContent ?? '';
    const state = readActionState(snapshot, command);
    const busy = state.busy || pendingDashboardCommands.has(command);
    const enabled = state.enabled && !busy;
    const label = button.dataset.dashboardLabel ?? command;
    button.disabled = !enabled;
    button.setAttribute('aria-disabled', String(!enabled));
    if (busy) {
      button.setAttribute('aria-busy', 'true');
      button.textContent = `${label}（处理中）`;
    } else {
      button.removeAttribute('aria-busy');
      button.textContent = label;
    }
    if (state.reason !== null && !enabled) {
      button.title = state.reason;
      button.setAttribute('aria-label', `${label}：${state.reason}`);
    } else if (busy) {
      button.title = '后台处理中，请稍候';
      button.setAttribute('aria-label', `${label}：后台处理中`);
    } else {
      button.removeAttribute('title');
      button.setAttribute('aria-label', label);
    }
  });
}

function renderDashboard(snapshot: DashboardSnapshot): void {
  currentSnapshot = snapshot;
  const rendererSnapshot = snapshot;
  const statusLabel = getStatusLabel(rendererSnapshot.status);
  if (dashboardHeaderProjectElement !== null) {
    dashboardHeaderProjectElement.textContent = rendererSnapshot.project?.name ?? '未选择项目';
  }
  if (dashboardStatusBadgeElement !== null) {
    dashboardStatusBadgeElement.textContent = statusLabel;
    dashboardStatusBadgeElement.className = `status-badge status-${rendererSnapshot.status.toLowerCase()}`;
    dashboardStatusBadgeElement.title = rendererSnapshot.status;
  }
  if (dashboardUpdatedAtElement !== null) {
    dashboardUpdatedAtElement.textContent = `最近更新：${formatUpdatedAt(rendererSnapshot.updatedAt)}`;
    dashboardUpdatedAtElement.title = rendererSnapshot.updatedAt;
  }
  if (dashboardProjectElement !== null)
    dashboardProjectElement.textContent = rendererSnapshot.project?.name ?? '未选择项目';
  if (dashboardSolElement !== null) {
    dashboardSolElement.textContent =
      rendererSnapshot.activeSolSession === null
        ? '无'
        : `${rendererSnapshot.activeSolSession.sessionId} / ${getSolLabel(rendererSnapshot.activeSolSession.status)}`;
  }
  if (dashboardStageElement !== null) {
    dashboardStageElement.textContent = `${getStageLabel(rendererSnapshot.stage)} / ${statusLabel}`;
    dashboardStageElement.title = `${rendererSnapshot.stage} / ${rendererSnapshot.status}`;
  }
  if (dashboardTaskElement !== null) dashboardTaskElement.textContent = rendererSnapshot.taskId ?? '无';
  if (dashboardRevisionsElement !== null) {
    dashboardRevisionsElement.textContent = `${rendererSnapshot.governanceRevision ?? '—'} / ${rendererSnapshot.architectureRevisions.join(', ') || '—'}`;
  }
  if (dashboardLunaElement !== null) {
    dashboardLunaElement.textContent =
      rendererSnapshot.luna.sessionId === null
        ? getLunaLabel(rendererSnapshot.luna.status)
        : `${getLunaLabel(rendererSnapshot.luna.status)} / ${rendererSnapshot.luna.sessionId}`;
  }
  if (dashboardCommitsElement !== null) {
    dashboardCommitsElement.textContent = `本地 ${rendererSnapshot.commits.local ?? '—'} / 远端 ${rendererSnapshot.commits.remote ?? '—'}`;
  }
  if (dashboardErrorElement !== null) {
    dashboardErrorElement.textContent =
      rendererSnapshot.recentError === null
        ? '无'
        : `${rendererSnapshot.recentError.code}：${rendererSnapshot.recentError.message}`;
  }
  if (dashboardSuggestionElement !== null)
    dashboardSuggestionElement.textContent = `建议：${getDashboardSuggestion(rendererSnapshot)}`;
  renderLoopGraph(rendererSnapshot);
  applyDashboardActionStates(rendererSnapshot);
}

function refreshDashboard(): Promise<void> {
  if (refreshInFlight !== null) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      renderDashboard(await window.desktopApi.getDashboardSnapshot());
    } catch (error) {
      if (dashboardErrorElement !== null) dashboardErrorElement.textContent = '状态面板不可用';
      showOperationError(error, '状态面板不可用');
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

function dashboardCommandFromButton(button: HTMLButtonElement): DashboardCommand | null {
  const command = button.dataset.dashboardCommand as DashboardCommandName | undefined;
  if (command === undefined || !dashboardCommandNames.includes(command)) return null;
  if (currentSnapshot !== null) {
    const state = readActionState(currentSnapshot, command);
    if (!state.enabled || state.busy || pendingDashboardCommands.has(command)) {
      setStatus(state.reason ?? '该动作当前不可用，请等待状态更新。');
      return null;
    }
  }
  if (dangerousDashboardCommands.has(command)) {
    const labels: Record<string, string> = {
      start: '启动自动循环',
      pause: '暂停自动循环',
      'retry-current-stage': '重试当前阶段',
      'continue-interrupted': '继续上次中断的执行',
      rebind: '重新绑定 Sol 会话',
    };
    if (!window.confirm(`确认执行“${labels[command]}”？`)) return null;
    return {
      command: command as 'start' | 'pause' | 'retry-current-stage' | 'rebind',
      confirm: true,
    };
  }
  return {
    command: command as
      'continue-interrupted' | 'governance-consistency-check' | 'open-edge' | 'open-project' | 'view-report',
  };
}

async function executeDashboardCommandFromButton(button: HTMLButtonElement): Promise<void> {
  const command = button.dataset.dashboardCommand as DashboardCommandName | undefined;
  const dashboardCommand = dashboardCommandFromButton(button);
  if (command === undefined || dashboardCommand === null) return;
  pendingDashboardCommands.add(command);
  if (currentSnapshot !== null) applyDashboardActionStates(currentSnapshot);
  setStatus('动作已接受，后台处理中…');
  try {
    const result = await window.desktopApi.executeDashboardCommand(dashboardCommand);
    setStatus(result.accepted ? `动作已接受，后台处理中：${result.message}` : `动作未执行：${result.message}`);
    await refreshDashboard();
  } catch (error) {
    showOperationError(error, '状态面板命令执行失败');
    await refreshDashboard();
  } finally {
    pendingDashboardCommands.delete(command);
    if (currentSnapshot !== null) applyDashboardActionStates(currentSnapshot);
  }
}

const projectOperationButtons = [
  selectDirectoryButton,
  scanButton,
  checkGitAccessButton,
  cloneInitializeButton,
  adoptInitializeButton,
  saveButton,
  previewButton,
];

if (statusElement !== null && versionElement !== null) {
  window.desktopApi
    .getRuntimeInfo()
    .then((runtimeInfo) => {
      if (!savedProjectLoadCompleted) statusElement.textContent = '就绪 — 正在加载上次项目配置…';
      versionElement.textContent = `Version ${runtimeInfo.version}`;
    })
    .catch((error) => {
      showOperationError(error, '运行时信息不可用');
      versionElement.textContent = '运行时信息不可用';
    });
}

void loadSavedProjectConfig().catch((error) => {
  showOperationError(error, '上次项目配置加载失败');
});

document.querySelectorAll<HTMLButtonElement>('[data-dashboard-command]').forEach((button) => {
  button.addEventListener('click', () => void executeDashboardCommandFromButton(button));
});

scanButton?.addEventListener('click', () => {
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在扫描 Git 仓库…',
    action: scanSelectedProject,
    successMessage: () =>
      scanResult?.governanceManifestStatus === 'invalid'
        ? `扫描完成，但 governance manifest 无效：${scanResult.governanceManifestError?.message ?? '未知错误'}`
        : '扫描完成，请确认目标分支和报告目录。',
    errorFallback: '项目扫描失败',
  });
});

selectDirectoryButton?.addEventListener('click', () => {
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在打开目录选择器…',
    action: () => window.desktopApi.selectProjectDirectory(),
    successMessage: (selected) => {
      if (selected !== null && localPathElement !== null) localPathElement.value = selected;
      return selected === null ? '未选择目录。' : '已选择本地目录，请继续扫描、克隆或接管初始化。';
    },
    errorFallback: '选择目录失败',
  });
});

checkGitAccessButton?.addEventListener('click', () => {
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在检查 Git 远程授权…',
    action: checkRemoteAccess,
    successMessage: (message) => message,
    errorFallback: 'Git 远程授权检查失败',
  });
});

cloneInitializeButton?.addEventListener('click', () => {
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在克隆并初始化项目…',
    action: () => initializeProject('clone'),
    successMessage: () => '项目初始化操作已完成。',
    errorFallback: '克隆初始化失败',
  });
});

adoptInitializeButton?.addEventListener('click', () => {
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在备份并初始化治理目录…',
    action: () => initializeProject('adopt'),
    successMessage: () => '项目初始化操作已完成。',
    errorFallback: '已有项目初始化失败',
  });
});

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在保存项目配置…',
    action: () => window.desktopApi.saveProjectConfig(getConfigInput()),
    successMessage: (config) => `配置已保存：${config.projectId}`,
    errorFallback: '配置保存失败',
  });
});

previewButton?.addEventListener('click', () => {
  void runProjectOperation({
    buttons: projectOperationButtons,
    startMessage: '正在生成 Sol 初始化提示词…',
    action: async () => {
      if (promptElement === null) throw new Error('提示词预览区域不可用');
      const preview = await window.desktopApi.previewSolPrompt(getConfigInput());
      promptElement.textContent = preview.initializationPrompt;
      openContentDialog('Sol 初始化提示词', preview.initializationPrompt, previewButton);
      return preview;
    },
    successMessage: () => 'Sol 初始化提示词预览已生成。',
    errorFallback: '提示词预览失败',
  });
});

function closeContentDialog(): void {
  if (contentDialog === null || contentDialog.hidden) return;
  contentDialog.hidden = true;
  contentPreviouslyFocused?.focus();
  contentPreviouslyFocused = null;
}

function openContentDialog(title: string, content: string, returnFocus: HTMLElement | null): void {
  if (contentDialog === null || contentDialogTitleElement === null || contentDialogBodyElement === null) return;
  contentPreviouslyFocused = returnFocus;
  contentDialogTitleElement.textContent = title;
  contentDialogBodyElement.textContent = content;
  contentDialog.hidden = false;
  contentCopyButton?.focus();
}

async function copyContentDialog(): Promise<void> {
  const content = contentDialogBodyElement?.textContent ?? '';
  if (content.trim() === '') {
    setStatus('当前没有可复制的内容。');
    return;
  }
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(content);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.focus();
      textarea.select();
      if (!document.execCommand('copy')) throw new Error('浏览器拒绝复制操作');
      textarea.remove();
    }
    setStatus(`${contentDialogTitleElement?.textContent ?? '内容'}已复制到剪贴板。`);
  } catch (error) {
    setStatus(`复制失败：${errorMessage(error, '剪贴板不可用')} 请手动选择并复制。`);
  }
}

viewProjectDetailsButton?.addEventListener('click', () => {
  const details = detailsElement?.textContent ?? '';
  if (details.trim() === '') {
    setStatus('请先扫描项目，再查看当前配置。');
    return;
  }
  openContentDialog('当前项目配置', details, viewProjectDetailsButton);
});

contentCopyButton?.addEventListener('click', () => void copyContentDialog());
contentCloseButton?.addEventListener('click', closeContentDialog);
contentDialog?.addEventListener('click', (event) => {
  if (event.target === contentDialog) closeContentDialog();
});
contentDialog?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeContentDialog();
    return;
  }
  if (event.key !== 'Tab' || contentDialog === null) return;
  const focusable = Array.from(contentDialog.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]'));
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

function closeHelp(): void {
  if (helpDialog === null || helpDialog.hidden) return;
  helpDialog.hidden = true;
  helpPreviouslyFocused?.focus();
  helpPreviouslyFocused = null;
}

function openHelp(): void {
  if (helpDialog === null) return;
  helpPreviouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  helpDialog.hidden = false;
  helpCloseButton?.focus();
}

helpButton?.addEventListener('click', openHelp);
helpCloseButton?.addEventListener('click', closeHelp);
helpDialog?.addEventListener('click', (event) => {
  if (event.target === helpDialog) closeHelp();
});
helpDialog?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeHelp();
    return;
  }
  if (event.key !== 'Tab' || helpDialog === null) return;
  const focusable = Array.from(
    helpDialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

void refreshDashboard();
window.setInterval(() => void refreshDashboard(), 1500);
