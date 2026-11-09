// Compile-time checks of the published types (`pnpm check`).
import { define, request, type ApproveDetail } from '@theahaco/soroban-sign-dialog';
import { createPreview, type SignerHint } from '@theahaco/soroban-sign-dialog/preview';
import { SignDialog } from '@theahaco/soroban-sign-dialog/react';

define();
const el = document.createElement('soroban-sign-dialog');
el.labels = { G: 'Me', C: { name: 'Token', token: { code: 'TOK', decimals: 7 } } };
el.strings = { approveButton: 'Aprobar', summarySend: (p: { amount: string; to: string }) => `Enviar ${p.amount} a ${p.to}`, notices: { protocol: (p: { protocol: number }) => `p${p.protocol}` } };
el.addEventListener('approve', (e) => { const d: ApproveDetail = e.detail; void d.entries[0]?.invocationHash; });
el.addEventListener('reject', (e) => { const r: 'rejected' | 'dismissed' | 'closed' | 'superseded' = e.detail.reason; void r; });
const hint: SignerHint = { verifier: 'C…', key: 'ab', ruleIds: [1] };
el.previewProvider = createPreview({ rpcUrl: 'https://rpc.example', hints: { C: hint } });

export async function flow(transaction: string) {
  const r = await request({ transaction, signer: 'G', network: 'testnet', theme: 'dark' });
  if (r.approved) return r.entries.filter((e) => e.forSigner).map((e) => e.entryXdr);
  return r.reason;
}

export const view = (
  <SignDialog transaction="AAAA" labels={{}} open onApprove={(e) => e.detail.transactionHash} onReject={(e) => e.detail.reason}>
    <img slot="logo" alt="" />
  </SignDialog>
);
