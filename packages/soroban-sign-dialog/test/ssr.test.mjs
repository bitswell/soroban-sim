// Server rendering: importing the package touches no DOM, `define()` is a
// no-op without custom elements, and the React wrapper renders the tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

test('imports and defines without a DOM', async () => {
  assert.equal(globalThis.document, undefined);
  const m = await import('../src/index.js');
  m.define();
  assert.equal(m.TAG, 'soroban-sign-dialog');
  assert.equal(m.STRINGS.approveButton, 'Approve');
});

test('the React wrapper renders the element on the server', async () => {
  const { SignDialog } = await import('../src/react.js');
  const html = renderToString(createElement(SignDialog, { theme: 'dark', inline: true, transaction: 'AAAA' }, createElement('img', { slot: 'logo', alt: 'Acme' })));
  assert.match(html, /^<soroban-sign-dialog theme="dark" inline="">/);
  assert.match(html, /<img slot="logo" alt="Acme"\/>/);
  assert.doesNotMatch(html, /transaction=/, 'rich data waits for the browser, as properties');
});
