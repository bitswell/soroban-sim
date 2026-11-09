// The captured Perch fixture and the multi-party fixture, shared with the
// Rust tests.
import { readFileSync } from 'node:fs';

export const capture = JSON.parse(readFileSync(new URL('../../../crates/soroban-sim-preview/fixtures/perch-capture.json', import.meta.url)));
export const scenario = (id) => capture.scenarios.find((s) => s.id === id);
export const multiParty = JSON.parse(readFileSync(new URL('../../../crates/soroban-sim-preview/fixtures/multi-party.json', import.meta.url)));
