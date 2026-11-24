# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Wisesaaa/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Wisesaaa/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it reads a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as JSON,
finds the lines each edit names at the first of three matching tiers — even when the model drifted
their whitespace or indentation — and changes every file or none.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format". SPEC.md is the whole contract; the entry is
`main.ts`, run as `node main.ts [options] [PATCH]` on Node 22 with the standard library alone.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME`: `auto` (default), `unified`, `search-replace`, `v4a` or `json`.
- `--check`: do everything but write — same output and exit code, no file created, changed or deleted.
- `--strict`: match lines exactly (tier 0 only).
- `PATCH` is the patch file; absent or `-` reads the patch from standard input.

Exit 0 lists the changed files (`A`/`D`/`M`/`R`) and prints `ok: <n> files`. Exit 1 lists
each failed edit (`error: <code> <path>`) and `failed: <k> of <n> edits`. Exit 2 is a usage,
missing-patch, format or parse error (`error: parse <N>` names the patch line).

## License

MIT — see [LICENSE](LICENSE).
