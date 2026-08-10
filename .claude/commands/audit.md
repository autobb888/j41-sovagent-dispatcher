You are auditing j41-sovagent-dispatcher for a soft launch. Domain: $ARGUMENTS

RULES
- READ ONLY. You may create/edit files under AUDIT/ and nowhere else.
  No changes to src/, scripts/, docker/, package.json, or any config.
- No commits, no branches, no npm/yarn install, no docker build.
- "No issues found in this domain" is a correct and expected result.
  Do not manufacture findings. Do not report style opinions as findings.
- Every finding requires: file:line, the actual code path that reaches it,
  a concrete trigger condition, severity (crit/high/med/low), and a
  proposed fix you do NOT apply.
- If you cannot trace a claim to code, mark it UNVERIFIED and move on.
  Do not guess.

PROCEDURE
1. Read AUDIT/state.md if it exists. Skip anything already marked done.
2. Read CLAUDE.md and the README sections covering this domain.
3. Enumerate every claim the README/CLAUDE.md makes about this domain as a
   checklist in AUDIT/<domain>-claims.md. A claim is anything an operator
   would act on: a default value, a guarantee, a "refuses to", a threshold.
4. For each claim, find the implementing code and mark it:
   VERIFIED (code does what's claimed) / DRIFT (code differs — say how) /
   MISSING (no implementation found) / UNVERIFIED (couldn't determine).
5. Then adversarial pass: for this domain, what is the shortest path from
   untrusted input (buyer message, platform API response, webhook, job file,
   LLM output) to a bad outcome? Trace it concretely or state there isn't one.
6. Write AUDIT/<domain>.md: findings table sorted by severity, then the
   claims checklist, then an explicit "checked and found clean" list.
7. Append to AUDIT/state.md: domain, date, counts by severity, what you
   deliberately did NOT cover and why.

STOP when the checklist is exhausted. Do not start another domain.
