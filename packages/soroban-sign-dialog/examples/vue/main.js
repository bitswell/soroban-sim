import { createApp, onMounted, ref } from 'vue';
import { define } from '@theahaco/soroban-sign-dialog';
import { loadRequest, report } from '../shared.js';

// Define before mounting so Vue sees the element's properties and sets
// `labels` as a property rather than an attribute.
define();
const request = await loadRequest();

const app = createApp({
  setup() {
    const dialog = ref(null);
    onMounted(() => dialog.value.show());
    return {
      dialog, ...request,
      onApprove: (e) => report(`approved:${e.detail.entries.length}`),
      onReject: (e) => report(`rejected:${e.detail.reason}`),
    };
  },
  // The same markup works in a single-file component's <template>.
  template: `
    <soroban-sign-dialog ref="dialog" :transaction="transaction" :network="network" :signer="signer" :labels="labels"
      @approve="onApprove" @reject="onReject">
      <span slot="footer">Signed with Acme Wallet</span>
    </soroban-sign-dialog>`,
});
app.config.compilerOptions.isCustomElement = (tag) => tag === 'soroban-sign-dialog';
app.mount('#root');
