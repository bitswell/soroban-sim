import { loadRequest, report } from '../shared.js';

const { transaction, network, signer, labels } = await loadRequest();
const dialog = document.getElementById('dialog');
// Rich data goes in as properties; strings can also be attributes.
dialog.labels = labels;
dialog.network = network;
dialog.signer = signer;
dialog.transaction = transaction;
dialog.addEventListener('approve', (e) => report(`approved:${e.detail.entries.length}`));
dialog.addEventListener('reject', (e) => report(`rejected:${e.detail.reason}`));
dialog.show();
