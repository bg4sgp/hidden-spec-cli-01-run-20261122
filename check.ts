// check.ts — run mend on the public practice set and compare it with the expected outcomes.
//
//   node check.ts <practice.json> [<family or key prefix>...]
//
// practice.json is the set the kit carries at program/generator/practice.json: every practice check
// with the files it starts from and what the reference implementation did on it (exit code, stdout and
// the changes it made). Each check runs through runner.ts's runCheck, exactly as a trial runs it, and
// any mismatch is printed with what differed. With no filter every check runs and the practice score —
// round(1000 x passed / checks) — is printed at the end.

import { readFileSync } from 'node:fs';
import { runCheck } from './runner.ts';

interface PracticeCheck {
  key: string;
  group: string;
  family: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
  expect: { exit: number; stdout: string; changes: Record<string, string | null> };
}

const [file, ...only] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write('usage: node check.ts <practice.json> [<family or key prefix>...]\n');
  process.exit(2);
}
const { checks } = JSON.parse(readFileSync(file, 'utf8')) as { checks: PracticeCheck[] };
const picked =
  only.length === 0 ? checks : checks.filter((c) => only.some((o) => c.family === o || c.key.startsWith(o)));

let passed = 0;
for (const c of picked) {
  const want: Record<string, string> = { ...c.files };
  for (const [p, v] of Object.entries(c.expect.changes)) {
    if (v === null) delete want[p];
    else want[p] = v;
  }
  const got = runCheck({ id: c.key, argv: c.argv, stdin: c.stdin, files: c.files });
  const why: string[] = [];
  if (got.exit !== c.expect.exit) why.push(`exit ${got.exit}, expected ${c.expect.exit}`);
  if (got.stdout !== c.expect.stdout) {
    why.push(`stdout ${JSON.stringify(got.stdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
  }
  for (const p of new Set([...Object.keys(want), ...Object.keys(got.files)])) {
    if (want[p] === undefined) why.push(`${p} should not exist`);
    else if (got.files[p] === undefined) why.push(`${p} is missing`);
    else if (got.files[p] !== want[p]) {
      why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(got.files[p])}`);
    }
  }
  if (why.length === 0) passed += 1;
  else process.stdout.write(`FAIL ${c.family} ${c.key.slice(0, 12)} argv ${JSON.stringify(c.argv)}\n  ${why.join('\n  ')}\n`);
}
process.stdout.write(
  `${passed} of ${picked.length} passed${picked.length === checks.length ? `: practice score ${Math.round((1000 * passed) / checks.length)}` : ''}\n`,
);
