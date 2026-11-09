// What every example needs: a request to review and a place to report the
// decision (the browser tests read `document.body.dataset.result`).
export async function loadRequest() {
  const f = await (await fetch('/dist/demo-fixture.json')).json();
  return {
    transaction: f.scenarios.find((s) => s.id === 'within-cap').transaction,
    network: f.passphrase,
    signer: f.signer,
    labels: f.labels,
  };
}

export function report(result) {
  document.body.dataset.result = result;
}
