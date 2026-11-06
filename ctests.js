// Checks one run of a student's program against a sample test (exam.json "tests").
// grader/grade.py's check() implements the same rules for grading; keep them in step.
//
// A test:
//   { "name": "sum of 1..5",
//     "input": "5\n",              stdin (then end-of-file)
//     "args": ["5"],               command-line arguments
//     "output": "sum = 15\n",      exact stdout (trailing whitespace on each line ignored)
//     "contains": "sum = 15",      substring of stdout
//     "regex": "^sum = \\d+$",     regex searched in stdout, line by line (^ and $ match at each line)
//     "exitCode": 0,               expected exit status
//     "timeout": 5,                seconds (default 5)
//     "points": 1 }
// A test with no output, contains, regex or exitCode passes if the program exits with 0.

export const TIMED_OUT = 137;   // the exit status the grader reports for a program killed at its time limit

const norm = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
const show = (s) => JSON.stringify(s.slice(0, 200));

// code: exit status, TIMED_OUT, or null if the program crashed
export function checkTest(test, out, code) {
  const problems = [];
  if (code === TIMED_OUT) problems.push(`timed out after ${test.timeout ?? 5}s (infinite loop?)`);
  if ('output' in test && norm(out) !== norm(test.output)) problems.push(`output was ${show(out)}, expected ${show(test.output)}`);
  if ('contains' in test && !out.includes(test.contains)) problems.push(`output does not contain ${JSON.stringify(test.contains)}`);
  if ('regex' in test && !new RegExp(test.regex, 'm').test(out)) problems.push(`output does not match /${test.regex}/`);
  if ('exitCode' in test && code !== test.exitCode && code !== TIMED_OUT) problems.push(`exit code ${code ?? '(crashed)'}, expected ${test.exitCode}`);
  const anyCheck = ['output', 'contains', 'regex', 'exitCode'].some((k) => k in test);
  if (!anyCheck && code !== 0 && code !== TIMED_OUT) problems.push(code === null ? 'the program crashed' : `exit code ${code}`);
  return problems;
}
