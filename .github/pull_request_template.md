<!--
Title: `type(scope): imperative summary`, at most 72 characters. It becomes the
squash commit's subject on main and the crate CHANGELOG line (CONTRIBUTING.md).
Write this description for a reviewer, and for someone reading the change in a
year: what changed and why, never the instructions or discussion that led to it.
Review back-and-forth goes in PR comments. Answer any section "None." rather than
deleting its heading, and delete every comment like this one before you mark the
PR ready.
Other shapes (`gh pr create --template <name>.md`, or `?template=<name>.md` on
the compare URL):
  fidelity.md    can move simulated results, fees or metering against the network
  mechanical.md  twin sync, the vendored host, package assets, lockfiles, fixtures
  stack.md       one member of a stacked series
  docs.md        documentation only
-->

## Why

<!-- The problem, in a reader's terms, and why this approach. Closes #N / Refs #N.
Name known shortcomings. One short paragraph. -->

## What changes

<!-- Behaviour, not a file list: what a CLI user, RPC client, browser integrator or
signer sees differently. Then one line on what deliberately does NOT change. -->

## How to review

<!-- Start at: `path::symbol`.
Risky: the 1-3 places where a bug would hurt, and why.
Skim: what is mechanical, moved or generated, and the command that produced it
(`scripts/sync-protocol-twins.py`, `scripts/sync-package-assets.py`).
Commits: "review commit by commit" if the history is curated, otherwise "review the diff". -->

## Evidence

<!-- What ran, where, and the result, with counts: `cargo test -p soroban-sim-core`,
29 passed; `pnpm --filter @theahaco/soroban-sign-dialog test`. Under both hosts where
it matters (p29, p30). Name a test that FAILS without this change. Name what was
NOT run, and why. -->

## Decisions for review

<!-- Choices a reviewer could reasonably make differently: the alternative and why it
was rejected. Ask the specific question you want answered. "None." is fine. -->

## After merge

<!-- Release, crates.io, docs or follow-up steps, and who owns each. "Nothing." -->
