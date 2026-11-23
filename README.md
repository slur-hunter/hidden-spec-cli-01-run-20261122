# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slur-hunter/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/slur-hunter/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
Every file is changed or nothing is.

## Run

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `2` with exactly one error line (usage / no-patch / format /
parse), `1` with one error line per failed edit plus a `failed:` summary,
`0` with one line per changed path (`A`/`D`/`M`/`R`) plus an `ok:` summary.

## Matching

Old lines are found at the first of three tiers at which they occur: exact,
trailing whitespace ignored, leading and trailing whitespace ignored. At the
third tier new lines are re-indented to the file's indentation. Unified hunks
take the occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE
blocks fail when the old lines occur more than once; V4A chunks walk a cursor
with `@@` anchors and `*** End of File`. Line breaks (CRLF or LF) and the
final line break of every file are preserved as the specification says.

Node 22, standard library only. See `SPEC.md` in the competition kit for the
full specification.
