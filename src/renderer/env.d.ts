import { RendererApi } from '../shared/types';

declare global {
  interface Window {
    amaneStock: RendererApi;
  }
}

export {};
