# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bg4sgp/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bg4sgp/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** — one patch tool for every AI edit format. AI models write the same edit in incompatible
dialects; mend applies any of them to a tree of text files, atomically: every edit lands, or none do.

It reads four formats, auto-detected or forced with `--format`:

- **unified** diffs — sections and hunks, creations, deletions and renames, prose and code fences
  around the patch, and hunks applied at the occurrence nearest their (often wrong) stated line;
- **SEARCH/REPLACE** blocks — the path taken from the line above each block, fences included;
- **V4A** patches — Add / Delete / Update File sections, anchored chunks walked with a cursor,
  end-of-file chunks, and moves;
- **JSON** edit lists — `create`, `str_replace` and `insert` tool calls, as one array or as JSON Lines.

Old lines are matched at the first of three tiers that finds them: exact, ignoring trailing
whitespace, or ignoring indentation too (with the replacement re-indented to the file's own leading
whitespace). `--strict` keeps only the exact tier. Line endings are preserved per file — a CRLF file
stays CRLF, including through JSON `str_replace` — and the `\ No newline at end of file` marker is
honoured where a hunk reaches the end of a file. On success mend prints one line per changed file
(`A`/`D`/`M`/`R`) and an `ok:` summary; on failure it prints one `error: <code> <path>` line per failed
edit and writes nothing.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file in the working directory; without it (or with `-`) the patch is read from
standard input. `--check` prints the same report without writing. Exit codes: 0 when every edit
applied, 1 when some failed (nothing is written), 2 for usage, unreadable-patch, format and parse
errors. Node 22 and its standard library only — no dependencies, nothing to install.

## Layout

- `main.ts` — mend itself: the command line, the four format readers, the three-tier line matcher,
  the staged tree that makes a run all-or-nothing, and the trial hand-over.
- `runner.ts` — the trial driver: when `MAKEFUN_ENV_URL` is set, it fetches the trial's checks from
  the env, runs `node main.ts` on each in a fresh directory, and posts back the exit code, stdout and
  resulting files.
- `check.ts` — the local practice harness: `node check.ts <practice.json>` runs the public practice
  checks and prints the practice score.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ww39pck3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
