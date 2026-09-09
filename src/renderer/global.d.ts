import type { RendererApi } from '../shared/contracts/renderer-api.js';

declare global {
  interface Window {
    desktopApi: RendererApi;
  }
}

export {};
