// Toy dapp glue for the demo. The wallet side (here, the page) binds the
// engine to a state provider and to what it knows about its own session key;
// the dialog only sees a previewProvider.
import { createPreview, fixtureProvider, rpcProvider } from '../dist/preview/soroban-sim-preview.js';

const F = await (await fetch('../dist/demo-fixture.json')).json();
const dialog = document.getElementById('dialog');
const log = document.getElementById('log');
const short = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// A partial translation: anything not listed keeps its English default.
const SPANISH = {
  titleOne: 'Autoriza esta llamada',
  titleMany: (p) => `Autoriza ${p.count} llamadas`,
  reject: 'Rechazar',
  approveButton: 'Aprobar',
  approveAnyway: 'Aprobar de todos modos',
  confirmApproveAnyway: 'Confirmar: aprobar de todos modos',
  whatYouAuthorize: 'Lo que autorizas',
  effects: 'Efectos',
  details: 'Detalles',
  previewButton: 'Comprobar el resultado',
  statusSuccess: 'Saldrá bien',
  statusRefused: 'Será rechazada',
  statusUnknown: 'Resultado desconocido',
  statusChecking: 'Comprobando el resultado…',
  summarySend: (p) => `Enviar ${p.amount} a ${p.to}`,
  send: (p) => `Enviar ${p.amount} de ${p.from} a ${p.to}`,
  badgeExtra: '⚠ Esta transacción no la usa',
  badgeMatch: '✓ Coincide con la simulación',
  summary: (p) => `Comisión de hasta ${p.fee} XLM, pagada por ${p.payer}`,
  requestFrom: (p) => `Solicitud de <b>${p.dapp}</b>`,
};

const fixture = (protocolVersion) => fixtureProvider({ ledger: F.ledger, latest: { ...F.latest, protocolVersion }, latency: 60, name: 'the captured ledger' });
const providers = {
  fixture: () => createPreview({ stateProvider: fixture(29), hints: F.hints }),
  'fixture-30': () => createPreview({ stateProvider: fixture(30), hints: F.hints }),
  'fixture-31': () => createPreview({ stateProvider: fixture(31), hints: F.hints }),
  testnet: () => createPreview({ stateProvider: rpcProvider('https://soroban-testnet.stellar.org'), hints: F.hints }),
};
let source = 'fixture';
dialog.labels = F.labels;
dialog.previewProvider = providers.fixture();

const set = (id, fn) => document.getElementById(id).addEventListener('change', (e) => fn(e.target.value));
set('theme', (v) => {
  v ? document.documentElement.setAttribute('data-theme', v) : document.documentElement.removeAttribute('data-theme');
  v ? dialog.setAttribute('theme', v) : dialog.removeAttribute('theme');
});
set('look', (v) => dialog.classList.toggle('brand', v === 'brand'));
set('lang', (v) => { dialog.strings = v === 'es' ? SPANISH : {}; });
set('preview', (v) => dialog.setAttribute('preview', v));
set('source', (v) => { source = v; dialog.previewProvider = providers[v](); });

dialog.addEventListener('preview', (e) => {
  const r = e.detail.result;
  const t = r?.timings;
  const item = document.createElement('div');
  item.className = 'ev';
  item.innerHTML = t
    ? `<b>preview</b> · ${esc(r.status)} in ${t.totalMs.toFixed(0)} ms, protocol ${esc(r.engine.protocol)}
    <pre>engine load ${t.engineLoadMs.toFixed(0)} ms (compile ${t.engine.compileMs.toFixed(0)}, instantiate ${t.engine.instantiateMs.toFixed(0)})
state ${t.stateCalls} read(s), ${t.keysFetched} keys, ${t.needsStateRounds} needs-state round(s)
record ${t.reactorRecordMs.toFixed(1)} ms · enforce ${t.reactorEnforceMs.toFixed(1)} ms in the reactor</pre>`
    : `<b>preview</b> · ${esc(r?.status)}${r?.code ? ` (${esc(r.code)})` : ''}`;
  log.prepend(item);
});

for (const button of document.querySelectorAll('[data-scenario]')) {
  button.addEventListener('click', async () => {
    const s = F.scenarios.find((x) => x.id === button.dataset.scenario);
    const network = source === 'testnet' ? 'testnet' : F.passphrase;
    const r = await dialog.request({ transaction: s.transaction, network, signer: F.signer, dapp: 'corner-cafe.example' });
    const item = document.createElement('div');
    item.className = 'ev';
    item.dataset.result = r.approved ? 'approved' : r.reason;
    if (r.approved) {
      const mine = r.entries.filter((e) => e.forSigner);
      item.innerHTML = `<b class="ok">approve</b> · ${esc(s.title)}<br>
        The wallet now signs ${mine.length} entr${mine.length === 1 ? 'y' : 'ies'} for ${esc(short(r.signer))}:
        <pre>${esc(mine.map((e) => `#${e.index + 1} ${e.credentials} nonce ${e.nonce}\n   invocationHash ${e.invocationHash}`).join('\n'))}</pre>
        ${r.flags.length ? `Signed despite: ${esc(r.flags.map((f) => f.kind).join(', '))}` : 'No flags.'}`;
    } else {
      item.innerHTML = `<b class="no">reject</b> · ${esc(s.title)} · reason <code>${esc(r.reason)}</code>`;
    }
    log.prepend(item);
    button.focus();
  });
}
document.body.dataset.ready = 'true';
