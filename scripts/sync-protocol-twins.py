#!/usr/bin/env python3
"""Keep the protocol-30 twin crates byte-identical to the crates they copy.

The CLI binary links one engine per host protocol. Cargo builds a package once
per dependency graph, so the protocol-30 engine is a second set of packages
(`soroban-sim-{core,facade,cli}-p30`) whose sources are copies of the
protocol-29 crates; only their manifests differ, pinning the protocol-30 host
under the same dependency names. Edit the original crates, then run this.
CI uses --check; it never silently regenerates release inputs. Copies (not
symlinks) also work in Windows checkouts.
"""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CRATES = ROOT / "crates"
PROTOCOL = 30

# The binary's own modules: host selection runs once, outside every engine.
BINARY_ONLY = {"soroban-sim-cli": {"src/main.rs", "src/host.rs"}}

README = """# {twin}

`{name}` built against the protocol-{protocol} Soroban host
(soroban-env-host {protocol}). Its sources are a generated copy of `{name}`;
`soroban-sim` links both, so one binary runs protocol-29 and protocol-30
networks.

Do not edit this crate's sources: edit `{name}` and run
`scripts/sync-protocol-twins.py`. See the
[project documentation](https://github.com/theahaco/soroban-sim).
"""


def files():
    for name in ("soroban-sim-core", "soroban-sim-facade", "soroban-sim-cli"):
        crate, twin = CRATES / name, CRATES / f"{name}-p{PROTOCOL}"
        for source in sorted((crate / "src").rglob("*")):
            relative = source.relative_to(crate).as_posix()
            if source.is_file() and relative not in BINARY_ONLY.get(name, set()):
                yield source.read_bytes(), twin / relative
        if name == "soroban-sim-core":
            # `include_bytes!` fixture contracts, part of core's public API.
            for source in sorted((crate / "fixtures/contracts").glob("*.wasm")):
                yield source.read_bytes(), twin / "fixtures/contracts" / source.name
        text = README.format(twin=twin.name, name=name, protocol=PROTOCOL)
        yield text.encode(), twin / "README.md"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    failures = []
    expected = set()
    twins = set()
    for content, destination in files():
        expected.add(destination)
        twins.add(destination.relative_to(CRATES).parts[0])
        if args.check:
            if not destination.is_file() or destination.read_bytes() != content:
                failures.append(str(destination.relative_to(ROOT)))
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
    for twin in sorted(twins):
        for directory in (CRATES / twin / "src", CRATES / twin / "fixtures"):
            for destination in sorted(directory.rglob("*")):
                if destination.is_file() and destination not in expected:
                    if args.check:
                        failures.append(f"stale: {destination.relative_to(ROOT)}")
                    else:
                        destination.unlink()
    if failures:
        raise SystemExit("Protocol twin crates are out of sync; run scripts/sync-protocol-twins.py:\n" + "\n".join(failures))
    print(f"{'Verified' if args.check else 'Synchronized'} {len(expected)} files in {', '.join(sorted(twins))}")


if __name__ == "__main__":
    main()
