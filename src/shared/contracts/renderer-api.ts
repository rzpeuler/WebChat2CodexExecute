export interface RuntimeInfo {
  appName: string;
  version: string;
}

import type { ProjectConfig, ProjectConfigInput, ProjectScanResult } from './project-config.js';
import type {
  ProjectInitializationInput,
  ProjectInitializationResult,
  ProjectRemoteAccessCheckInput,
  ProjectRemoteAccessCheckResult,
} from './project-initialization.js';
import type { DashboardCommand, DashboardCommandResult, DashboardSnapshot } from './dashboard.js';

export interface SolPromptPreview {
  initializationPrompt: string;
  dynamicContext: string;
  initializationPromptLength: number;
  initializationPromptMaxLength: number;
}

export interface RendererApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
  selectProjectDirectory(): Promise<string | null>;
  checkProjectRemoteAccess(input: ProjectRemoteAccessCheckInput): Promise<ProjectRemoteAccessCheckResult>;
  initializeProject(input: ProjectInitializationInput): Promise<ProjectInitializationResult>;
  scanProject(localPath: string): Promise<ProjectScanResult>;
  saveProjectConfig(config: ProjectConfigInput): Promise<ProjectConfig>;
  loadProjectConfigs(): Promise<ProjectConfig[]>;
  previewSolPrompt(config: ProjectConfigInput): Promise<SolPromptPreview>;
  getDashboardSnapshot(): Promise<DashboardSnapshot>;
  executeDashboardCommand(command: DashboardCommand): Promise<DashboardCommandResult>;
}
