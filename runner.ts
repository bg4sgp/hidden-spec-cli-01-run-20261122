// runner.ts — the trial driver for mend.
//
// When the grader runs `node /bot/main.ts` it sets MAKEFUN_ENV_URL, and main.ts hands over to runTrial here.
// The env speaks a small protocol:
//
//   GET  $MAKEFUN_ENV_URL/checks    -> {"checks": [{"id", "argv", "stdin", "files"}], "answered", "total"}
//   POST $MAKEFUN_ENV_URL/results   <- {"results": [{"id", "exit", "stdout", "files"}]}
//
// runTrial fetches the checks once, runs each one (runCheck) in the env's order, and posts the results back
// in batches. A POST is accepted whole or refused whole; a network failure is retried, and a 409 answer to a
// retried POST means the first send landed, so it counts as delivered.
//
// runCheck reproduces the conditions SPEC.md grades under: `node main.ts <argv>` in a fresh directory that
// holds exactly the check's files, fed the check's standard input, with MAKEFUN_ENV_URL removed so the child
// behaves as the plain CLI. It reports the exit code (124 when the run overruns its limit), the stdout, and
// every regular file left in the directory afterwards.
//
// Node 22, standard library only. This file calls no model and needs no key.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One check to run: arguments, standard input (null for none) and the files the run starts with. */
export interface Check {
  id: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
}

/** The outcome of one check: exit code, stdout and the files left behind. */
export interface Result {
  id: string;
  exit: number;
  stdout: string;
  files: Record<string, string>;
}

/** The CLI under test: main.ts, beside this file. */
export const MAIN_TS = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

/** A single run gets at most this long before it is stopped and reported as exit 124. */
export const RUN_LIMIT_MS = 10_000;
/** The env accepts at most this much stdout and this many files in one result. */
export const STDOUT_CAP = 64 * 1024;
export const FILE_CAP = 64;
/** Results are posted this many at a time; a failed request is resent at most this many times. */
export const POST_BATCH = 10;
export const POST_TRIES = 4;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** fetch with retries on network errors only; any HTTP answer, good or bad, is returned as it came. */
async function fetchRetrying(url: string, init?: RequestInit): Promise<Response> {
  let tries = 0;
  for (;;) {
    try {
      return await fetch(url, init);
    } catch (err) {
      tries += 1;
      if (tries > POST_TRIES) throw err;
      await pause(200 * tries);
    }
  }
}

/** Every regular file under dir, keyed by its path relative to dir with '/' separators. */
function collectFiles(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) visit(p);
      else if (st.isFile() && Object.keys(found).length < FILE_CAP) {
        found[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    }
  };
  visit(dir);
  return found;
}

/** Run the CLI (main.ts unless another program is named) on one check and report what it did. */
export function runCheck(check: Check, program: string = MAIN_TS): Result {
  const dir = mkdtempSync(join(tmpdir(), 'mend-check-'));
  try {
    for (const [path, text] of Object.entries(check.files)) {
      const target = join(dir, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.MAKEFUN_ENV_URL;
    const run = spawnSync(process.execPath, [program, ...check.argv], {
      cwd: dir,
      env,
      input: check.stdin ?? '',
      encoding: 'utf8',
      timeout: RUN_LIMIT_MS,
      maxBuffer: 8 * STDOUT_CAP,
    });
    const exit = run.error !== undefined || run.status === null ? 124 : run.status;
    let stdout = run.stdout ?? '';
    while (Buffer.byteLength(stdout, 'utf8') > STDOUT_CAP) {
      stdout = stdout.slice(0, Math.floor(stdout.length / 2));
    }
    return { id: check.id, exit, stdout, files: collectFiles(dir) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run every check the env at envUrl lists and post each result back, in batches. */
export async function runTrial(envUrl: string): Promise<void> {
  const origin = envUrl.replace(/\/+$/, '');
  const postBatch = async (results: Result[]): Promise<void> => {
    const res = await fetchRetrying(`${origin}/results`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results }),
    });
    const body = await res.text(); // always drained, so no socket keeps the process alive at the end
    if (!res.ok && res.status !== 409) throw new Error(`POST /results -> ${res.status}: ${body}`);
  };
  const res = await fetchRetrying(`${origin}/checks`);
  if (!res.ok) throw new Error(`GET /checks -> ${res.status}`);
  const { checks } = (await res.json()) as { checks: Check[] };
  let pending: Result[] = [];
  for (const check of checks) {
    pending.push(runCheck(check));
    if (pending.length === POST_BATCH) {
      await postBatch(pending);
      pending = [];
    }
  }
  if (pending.length > 0) await postBatch(pending);
  process.stdout.write(`posted ${checks.length} results\n`);
}
