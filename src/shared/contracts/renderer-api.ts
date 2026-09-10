export interface RuntimeInfo {
  appName: string;
  version: string;
}

import type { ProjectConfig, ProjectConfigInput, ProjectScanResult } from './project-config.js';
import type { DashboardCommand, DashboardCommandResult, DashboardSnapshot } from './dashboard.js';

export interface SolPromptPreview {
  initializationPrompt: string;
  dynamicContext: string;
}

export interface RendererApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  scanProject(localPath: string): Promise<ProjectScanResult>;
  saveProjectConfig(config: ProjectConfigInput): Promise<ProjectConfig>;
  loadProjectConfigs(): Promise<ProjectConfig[]>;
  previewSolPrompt(config: ProjectConfigInput): Promise<SolPromptPreview>;
  getDashboardSnapshot(): Promise<DashboardSnapshot>;
  executeDashboardCommand(command: DashboardCommand): Promise<DashboardCommandResult>;
}
