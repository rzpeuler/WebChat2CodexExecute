export type ProjectInitializationMode = 'clone' | 'adopt';

export interface CloneProjectInitializationInput {
  mode: 'clone';
  parentDirectory: string;
  directoryName: string;
  remoteUrl: string;
  targetBranch?: string;
}

export interface AdoptProjectInitializationInput {
  mode: 'adopt';
  targetDirectory: string;
}

export type ProjectInitializationInput = CloneProjectInitializationInput | AdoptProjectInitializationInput;

export interface ProjectRemoteAccessCheckInput {
  directory: string;
  remoteUrl: string;
}

export interface ProjectRemoteAccessCheckResult {
  accessible: boolean;
  remoteUrl: string;
  code:
    'OK' | 'DIRECTORY_INVALID' | 'REMOTE_AUTH_REQUIRED' | 'REMOTE_UNREACHABLE' | 'REMOTE_INVALID' | 'GIT_UNAVAILABLE';
  message: string;
}

export interface ProjectInitializationResult {
  mode: ProjectInitializationMode;
  projectRoot: string;
  governanceManifestPath: string;
  changedPaths: string[];
  backupPath: string | null;
  idempotent: boolean;
  commit?: string | null;
  remoteCommit?: string | null;
}
