<!--
Fidelity PR: a change that can move a simulated result, fee or metering figure
relative to the network. Typical paths: the vendored host (crates/soroban-sim-host/),
the engine (crates/soroban-sim-core/src/), the RPC facade, the component, the
preview engine, a host or simulation version bump. Delete these comments before
you mark the PR ready. The description is a record of the change: no instructions
or review discussion.
-->

## Why

<!-- The divergence or gap, in a reader's terms, and why this approach.
Closes #N / Refs #N. -->

## What changes

<!-- What a CLI user, RPC client or browser integrator sees differently; then what
deliberately does NOT change. -->

## Fidelity impact

<!-- Which results can move, and on which host (p29, p30, both): return values,
events, footprints, resource fees, refunds and rent, CPU and memory metering, auth
and `__check_auth` outcomes, RPC response fields. Say whether each moves toward the
network or is a deliberate difference.
"None: <why this change cannot move a result>" is a valid answer; give the reason. -->

## Network comparison

<!-- What was replayed or compared, and the result with counts:
- `cargo test -p soroban-sim-cli --test replay` (the committed sample);
- `soroban-sim replay run fixtures/replay/*.json.gz --report fidelity`: N transactions,
  N matched, N explained divergences, 0 unexplained;
- a fresh `replay fetch` sample: network, ledger range, protocol;
- the parity fixtures (`fixtures/parity/`), the differential oracles, or a live RPC.
Mismatches that moved, before -> after. "None: <why nothing could be compared>". -->

## How to review

<!-- Start at: `path::symbol`. Risky: 1-3 places and their failure mode. Skim: twin
copies (`scripts/sync-protocol-twins.py`) and regenerated fixtures. -->

## Evidence

<!-- Tests beyond the comparison above, with counts, under both hosts where it
matters. A test that fails without this change. What was not run, and why. -->

## Decisions for review

<!-- The alternative you rejected and why, as a question a reviewer can answer. "None." -->

## After merge

<!-- Release notes, fixture recaptures, docs/replay.md or docs/upstream.md updates,
and who owns each. "Nothing." -->
