<!--
Mechanical PR: the protocol-30 twin sync, the vendored host copy and its
UPSTREAM.json, package assets, lockfile or dependency bumps, recaptured fixtures,
moved code. The goal is a review of the hand edits only, plus a reproduction of
everything else. Delete these comments before you mark the PR ready.
A host, simulation or XDR version that moves can move results: also answer
"## Fidelity impact" and "## Network comparison" from fidelity.md.
-->

## Why

<!-- What prompted it: the upstream release, the advisory, the issue. One line is fine. -->

## What was generated, moved or vendored

<!-- One line per artifact: path glob -> producing command and tool version(s), and
the input. For example:
crates/soroban-sim-*-p30/src/** -> `python scripts/sync-protocol-twins.py`
crates/soroban-sim-{core,facade,cli,component}/fixtures/** -> `python scripts/sync-package-assets.py`
crates/soroban-sim-host/src/**, build.rs -> soroban-env-host X.Y.Z .crate (sha256)
fixtures/parity/<name>.json -> `pnpm run capture:parity <name>` against <network, ledger>
Cargo.lock, pnpm-lock.yaml -> `cargo update -p <crate> --precise <v>`, `pnpm install` -->

## Reproduce

<!-- Exact commands from a clean checkout of the base. Expected result: an empty
`git diff`. CI already runs the `--check` form of both sync scripts and
`python scripts/check-upstream-host.py`. -->

## Hand edits

<!-- Every line NOT produced by the commands above (file:line), and why: a twin
manifest, UPSTREAM.json fields, a pin in Cargo.toml. These are the only lines to
review closely. "None." -->

## Provenance

<!-- How the content is checked against its source: a sync script's `--check`,
`check-upstream-host.py`, a checksum, a test. Vendored code: upstream URL and tag or
sha, license, and the local delta (docs/releases.md "Maintaining the isolated host"). -->

## After merge

<!-- Release-plz release (a host change can publish a new soroban-sim-host), docs,
and who owns each. "Nothing." -->
