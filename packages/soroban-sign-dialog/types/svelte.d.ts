// Element typings for Svelte 5 templates:
//   /// <reference types="@theahaco/soroban-sign-dialog/svelte" />
import type { HTMLAttributes } from 'svelte/elements';
import type { ApproveDetail, Labels, PreviewDetail, PreviewProvider, RejectDetail, SorobanSignDialog, StringOverrides } from './index.js';

declare module 'svelte/elements' {
  interface SvelteHTMLElements {
    'soroban-sign-dialog': HTMLAttributes<SorobanSignDialog> & {
      transaction?: string; network?: string; signer?: string; dapp?: string; engine?: string;
      labels?: Labels; strings?: StringOverrides; previewProvider?: PreviewProvider;
      theme?: 'light' | 'dark'; preview?: 'manual' | 'auto' | 'off'; inline?: boolean; strict?: boolean;
      onapprove?: (e: CustomEvent<ApproveDetail>) => void;
      onreject?: (e: CustomEvent<RejectDetail>) => void;
      onpreview?: (e: CustomEvent<PreviewDetail>) => void;
    };
  }
}
