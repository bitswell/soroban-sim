import { useState } from 'react';
import { SignDialog } from '@theahaco/soroban-sign-dialog/react';

export function App({ request, report }) {
  const [open, setOpen] = useState(true);
  return (
    <SignDialog
      open={open}
      transaction={request.transaction}
      network={request.network}
      signer={request.signer}
      labels={request.labels}
      onApprove={(e) => { setOpen(false); report(`approved:${e.detail.entries.length}`); }}
      onReject={(e) => { setOpen(false); report(`rejected:${e.detail.reason}`); }}
    >
      <span slot="footer">Signed with Acme Wallet</span>
    </SignDialog>
  );
}
