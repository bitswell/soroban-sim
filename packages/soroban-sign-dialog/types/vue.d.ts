// Element typings for Vue 3 templates:
//   /// <reference types="@theahaco/soroban-sign-dialog/vue" />
import type { DefineComponent } from 'vue';
import type { ApproveDetail, Labels, PreviewDetail, PreviewProvider, RejectDetail, StringOverrides } from './index.js';

declare module 'vue' {
  interface GlobalComponents {
    'soroban-sign-dialog': DefineComponent<{
      transaction?: string; network?: string; signer?: string; dapp?: string; engine?: string;
      labels?: Labels; strings?: StringOverrides; previewProvider?: PreviewProvider;
      theme?: 'light' | 'dark'; preview?: 'manual' | 'auto' | 'off'; inline?: boolean; strict?: boolean;
      onApprove?: (e: CustomEvent<ApproveDetail>) => void;
      onReject?: (e: CustomEvent<RejectDetail>) => void;
      onPreview?: (e: CustomEvent<PreviewDetail>) => void;
    }>;
  }
}
