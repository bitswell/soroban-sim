// Types for @theahaco/soroban-sign-dialog/react.
import type { ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { ApproveDetail, Labels, PreviewDetail, PreviewProvider, RejectDetail, SorobanSignDialog, StringOverrides } from './index.js';

export interface SignDialogProps {
  transaction?: string;
  authEntries?: string[];
  network?: string;
  signer?: string;
  dapp?: string;
  engine?: string;
  rpcUrl?: string;
  labels?: Labels;
  strings?: StringOverrides;
  previewProvider?: PreviewProvider;
  strict?: boolean;
  theme?: 'light' | 'dark';
  preview?: 'manual' | 'auto' | 'off';
  inline?: boolean;
  /** Opens the dialog when true; closing it with false reports `reject` with reason `closed`. */
  open?: boolean;
  className?: string;
  id?: string;
  /** Slotted content: elements with slot="logo", "header" or "footer". */
  children?: ReactNode;
  onApprove?: (event: CustomEvent<ApproveDetail>) => void;
  onReject?: (event: CustomEvent<RejectDetail>) => void;
  onPreview?: (event: CustomEvent<PreviewDetail>) => void;
  onOpen?: (event: CustomEvent<void>) => void;
  onClose?: (event: CustomEvent<void>) => void;
}

export declare const SignDialog: ForwardRefExoticComponent<SignDialogProps & RefAttributes<SorobanSignDialog>>;
