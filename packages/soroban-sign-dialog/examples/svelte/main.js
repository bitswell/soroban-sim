import { mount } from 'svelte';
import { define } from '@theahaco/soroban-sign-dialog';
import App from './App.svelte';
import { loadRequest, report } from '../shared.js';

// Define first: Svelte sets a prop as a property when the element has it.
define();
mount(App, { target: document.getElementById('root'), props: { request: await loadRequest(), report } });
