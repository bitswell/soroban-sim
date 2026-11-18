<!--
One member of a stacked series. If a stack tool (gh stack, Graphite, ghstack,
Sapling) writes the position and sibling list, replace the first line with it and
keep the bold lines: no tool can know those. The Stack section must still be
accurate at merge time. Delete these comments before you mark the PR ready.
-->

## Stack

Part **k of n** of <epic or issue link>. Base: `<branch>` (<PR URL>). Next: <PR URL>.

**Reviewed here:** <the concern this member owns>.
**Reviewed elsewhere:** <what this diff shows that belongs to another member, or is only
carried or moved here, with a link>.
**Depends on:** <what from earlier members this relies on>.

## Why

<!-- The problem this member solves and why this approach. -->

## What changes

<!-- Behaviour delta of THIS member, then what does NOT change. -->

## How to review

<!-- Start at: `path::symbol`. Risky: 1-3 places. Skim: carried or generated content.
After a rebase: `git range-diff <old-base>..<old-head> <base>..<head>`. -->

## Evidence

<!-- Builds and passes tests at THIS member's head, not only at the top of the stack:
the commands and counts. -->

## Decisions for review

<!-- Choices a reviewer could make differently, and the question you want answered. -->

## After merge

<!-- Merge order: after <PR URL>; retarget the next member's base once this lands. -->
