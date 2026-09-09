export interface RuntimeInfo {
  appName: string;
  version: string;
}

export interface RendererApi {
  getRuntimeInfo(): Promise<RuntimeInfo>;
}
