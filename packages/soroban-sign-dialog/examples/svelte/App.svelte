<script>
  import { onMount } from 'svelte';

  let { request, report } = $props();
  let dialog;
  onMount(() => dialog.show());
</script>

<soroban-sign-dialog
  bind:this={dialog}
  transaction={request.transaction}
  network={request.network}
  signer={request.signer}
  labels={request.labels}
  onapprove={(e) => report(`approved:${e.detail.entries.length}`)}
  onreject={(e) => report(`rejected:${e.detail.reason}`)}
>
  <span slot="footer">Signed with Acme Wallet</span>
</soroban-sign-dialog>
