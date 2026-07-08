# Dispatcher Accessibility & Integration Tweaks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the highest-value accessibility, onboarding, and integration gaps found in the 3-reviewer audit (2026-07-07): make the CLI's self-references work for npm-installed users, close the encryption-unlock UX regression, unblock brainbox monitoring via poll-mode events, and refresh the docs.

**Architecture:** A batch of targeted fixes to `src/cli.js`, `src/dashboard.js`, and the docs. No new modules, no dependency changes, no behavior change for existing correct paths. Each task is independently testable/reviewable.

**Tech Stack:** Node.js CJS (no build step), Commander, Inquirer, `node:test`.

**Source audit:** the three reviewer reports (CLI-flow, brainbox-integration, accessibility) from session 2026-07-07. This plan implements "Tier 1 + 3a" of that synthesis.

## Global Constraints

- No new runtime dependency; no build step (CJS). Validate with `node --check src/cli.js src/dashboard.js` and `node --test test/*.test.js` (currently 319 pass — must stay green).
- Do NOT change the fail-closed encryption semantics from the at-rest feature (`ensureKeystoreUnlockedIfEncrypted` already exists in cli.js at the definition line ~361; reuse it, do not reimplement).
- Match existing house style (unqualified `require('...')`, existing logging/emoji conventions, `promptWithEsc` in the dashboard).
- User-facing command references in printed hints must use the published binary name `j41-dispatcher`, never `node src/cli.js`.
- Actual process spawns must use `process.execPath` (the node binary) + `process.argv[1]` (the running cli.js path) so they work from both a source checkout and an npm-global install — never the literal `'node'` + `'src/cli.js'`.
- Event emissions must use the existing guarded form `state.emitEvent?.(type, data)` (a no-op when the control API is off) — never assume `state.emitEvent` exists.

---

### Task 1: Self-reference correctness — hints, spawns, and the `dashboard` command

Make every way the tool refers to itself work for an npm-installed user. Three parts: (a) printed hints `node src/cli.js …` → `j41-dispatcher …` in `cli.js`; (b) the dashboard's actual spawns use `process.execPath` + `process.argv[1]`; (c) register a real `dashboard` command (docs tell users to run it, but it isn't registered — it errors today); (d) add the missing `finalize` step to `init`'s next-step hint.

**Files:**
- Modify: `src/cli.js` (22 printed `node src/cli.js` hint strings; `init` next-step block ~`src/cli.js:1300-1304`; add a `dashboard` command near the no-args TUI trigger at ~`src/cli.js:7252`)
- Modify: `src/dashboard.js` (spawn sites at ~`514`, `1165`, `1973`, `2007`, `2040`, `2060`, `2946`)
- Test: `test/cli-self-reference.test.js` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: a registered `dashboard` command; no runtime interface other tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `test/cli-self-reference.test.js`. It asserts source-level invariants (the cheapest reliable way to pin these — the strings and command registration live in a 7000-line CLI that is not import-safe to execute):

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');
const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('no printed hint tells users to run "node src/cli.js"', () => {
  assert.equal(CLI.includes('node src/cli.js'), false, 'cli.js still references node src/cli.js in a hint');
});

test('dashboard spawns do not hardcode node + src/cli.js', () => {
  assert.equal(/['"]node['"]\s*,\s*\[\s*['"]src\/cli\.js['"]/.test(DASH), false, 'dashboard still spawns node src/cli.js');
});

test('a dashboard command is registered', () => {
  assert.match(CLI, /\.command\(['"]dashboard['"]\)/);
});

test('init next-step mentions finalize', () => {
  // The init "Next steps" block must include a finalize step.
  const idx = CLI.indexOf('agents initialized');
  assert.ok(idx > -1);
  const block = CLI.slice(idx, idx + 500);
  assert.match(block, /finalize/i, 'init next-step block does not mention finalize');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli-self-reference.test.js`
Expected: FAIL — `node src/cli.js` still present; no `dashboard` command; init block lacks finalize.

- [ ] **Step 3: Replace printed hints in `src/cli.js`**

Replace every occurrence of the literal `node src/cli.js` with `j41-dispatcher` in `src/cli.js` (they are all inside `console.log`/`console.error` hint strings — e.g. `src/cli.js:1058, 1067, 1242, 1244, 1439, 1480, 1642, 1649, 1661, 1702, 1868, 1976, 2046, 2706, 2707, 2793, 2794, 4136, 4137, 5807, 6265, 6268`). This is a mechanical global replace of the substring `node src/cli.js` → `j41-dispatcher`. Verify none remain: `grep -c "node src/cli.js" src/cli.js` → `0`.

- [ ] **Step 4: Add the missing `finalize` step to `init`'s next-step hint**

At `src/cli.js:~1300-1304`, the block currently reads:

```js
    console.log('\nNext steps:');
    console.log('  1. Fund the agent addresses (they need VRSC for registration)');
    console.log('  2. Register each: j41-dispatcher register agent-1 <name>');
    console.log('  3. Start dispatcher: j41-dispatcher start');
```

Replace with (insert finalize as step 3, renumber start to 4):

```js
    console.log('\nNext steps:');
    console.log('  1. Fund the agent addresses (they need VRSC for registration)');
    console.log('  2. Register each: j41-dispatcher register agent-1 <name>');
    console.log('  3. Finalize each: j41-dispatcher finalize agent-1');
    console.log('  4. Start dispatcher: j41-dispatcher start');
```

- [ ] **Step 5: Fix the dashboard spawns to use the real node + script path**

In `src/dashboard.js`, each spawn currently passes the literal `'node'` and `'src/cli.js'` with `REPO_DIR` as cwd. Replace `'node'` with `process.execPath` and `'src/cli.js'` with `process.argv[1]` (the path of the cli.js that require()'d this dashboard — correct for both source and npm installs), and drop the `REPO_DIR` cwd argument so it runs in the user's cwd. Apply to all sites:

- `src/dashboard.js:514` — `const cliArgs = ['node', 'src/cli.js', 'update-profile', agentId];` → `const cliArgs = [process.execPath, process.argv[1], 'update-profile', agentId];`
- `src/dashboard.js:1165` — `runCommandAsync('node', ['src/cli.js', 'setup', agentId, name, '--template', template], REPO_DIR)` → `runCommandAsync(process.execPath, [process.argv[1], 'setup', agentId, name, '--template', template])`
- `src/dashboard.js:1973` — `runCommandAsync('node', ['src/cli.js', 'recover', agentId], REPO_DIR)` → `runCommandAsync(process.execPath, [process.argv[1], 'recover', agentId])`
- `src/dashboard.js:2007` and `2040` — `runCommandAsync('node', ['src/cli.js', 'register', agentId, identityName], REPO_DIR)` → `runCommandAsync(process.execPath, [process.argv[1], 'register', agentId, identityName])`
- `src/dashboard.js:2060` — `runCommandAsync('node', ['src/cli.js', 'finalize', agentId, '--interactive'], REPO_DIR)` → `runCommandAsync(process.execPath, [process.argv[1], 'finalize', agentId, '--interactive'])`
- `src/dashboard.js:2946` — `spawn('node', ['src/cli.js', 'start'], { ... })` → `spawn(process.execPath, [process.argv[1], 'start'], { ... })` (keep the rest of the options object unchanged; if it sets `cwd: REPO_DIR`, remove that key so it inherits the caller's cwd)

Check the `runCommandAsync` signature first (search `function runCommandAsync` / `const runCommandAsync` in dashboard.js): if its third parameter is a cwd used as `spawn(cmd, args, { cwd })`, dropping the argument makes it inherit the current cwd, which is correct. If removing it breaks the call, pass `undefined` explicitly.

- [ ] **Step 6: Register the `dashboard` command**

The TUI currently launches only when `process.argv.length <= 2` (`src/cli.js:7252`). Add an explicit command so `j41-dispatcher dashboard` works (it's what every doc tells users to run). Add this alongside the other `program.command(...)` definitions (e.g. right after the `start` command):

```js
program
  .command('dashboard')
  .description('Launch the interactive TUI menu')
  .action(() => { require('./dashboard.js'); });
```

Note: `dashboard.js` runs its menu on require (same mechanism the no-args branch uses). Keep the existing `process.argv.length <= 2` no-args branch as-is.

- [ ] **Step 7: Run tests + syntax check**

Run: `node --check src/cli.js src/dashboard.js && node --test test/cli-self-reference.test.js`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
git add src/cli.js src/dashboard.js test/cli-self-reference.test.js
git commit -m "fix(cli): self-references work for npm installs + register dashboard command + init finalize step"
```

---

### Task 2: Encryption unlock guard on all key-dependent management commands

Regression fix: the at-rest encryption feature only added `ensureKeystoreUnlockedIfEncrypted()` to `setup`/`recover`/`createNewAgent`. Every other command that reads or writes an agent's keys throws a raw `ELOCKED` on an encrypted pool instead of prompting (works only if `J41_KEYS_PASSPHRASE` is set). Add the guard to the rest.

**Files:**
- Modify: `src/cli.js` (action bodies of the commands listed below)
- Test: `test/cli-encryption-guard.test.js` (new)

**Interfaces:**
- Consumes: `ensureKeystoreUnlockedIfEncrypted()` (already defined in cli.js ~line 361 — a no-op unless `master-key.json` exists; prompts interactively or resolves from env/systemd-cred, else exits non-zero with a clear message).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/cli-encryption-guard.test.js` (source-level assertion — the interactive commands are not import-safe to run):

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

// Every key-dependent command action should call the unlock guard so an
// encrypted pool prompts to unlock instead of throwing ELOCKED.
const COMMANDS = [
  "register <agent-id> <identity-name>",
  "finalize <agent-id>",
  "set-authorities <agentId>",
  "check-authorities",
  "deactivate <agent-id>",
  "activate <agent-id>",
  "activate-all",
  "deactivate-all",
  "update-profile <agent-id>",
  "inspect <agent-id>",
];

for (const cmd of COMMANDS) {
  test(`command "${cmd}" calls ensureKeystoreUnlockedIfEncrypted`, () => {
    const marker = `.command('${cmd}')`;
    const start = CLI.indexOf(marker);
    assert.ok(start > -1, `command not found: ${cmd}`);
    // Look within this command's block: from its .command() to the next .command( at column 0-ish.
    const next = CLI.indexOf('\n  .command(', start + marker.length);
    const block = CLI.slice(start, next === -1 ? start + 4000 : next);
    assert.match(block, /ensureKeystoreUnlockedIfEncrypted\(\)/, `missing guard in "${cmd}"`);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cli-encryption-guard.test.js`
Expected: FAIL for register/finalize/set-authorities/check-authorities/deactivate/activate/activate-all/deactivate-all/update-profile/inspect (only setup/recover have the guard today).

- [ ] **Step 3: Add the guard to each command action**

For each of these commands, add `await ensureKeystoreUnlockedIfEncrypted();` as the first statement inside the `.action(async (...) => {` body (before any `loadAgentKeys`/`writeKeysFile`/`readKeysFile` use). The `.action` callbacks are already `async`. Command locations:

- `register <agent-id> <identity-name>` — `src/cli.js:~1309`
- `finalize <agent-id>` — `src/cli.js:~1489`
- `set-authorities <agentId>` — `src/cli.js:~1775`
- `check-authorities` — `src/cli.js:~1826`
- `deactivate <agent-id>` — `src/cli.js:~1874`
- `activate <agent-id>` — `src/cli.js:~1985`
- `activate-all` — `src/cli.js:~2055`
- `deactivate-all` — `src/cli.js:~2122`
- `update-profile <agent-id>` — `src/cli.js:~2195`
- `inspect <agent-id>` — `src/cli.js:~2299`

Example (register):

```js
  .action(async (agentId, identityName, options) => {
    await ensureKeystoreUnlockedIfEncrypted();
    // ... existing body ...
```

Match each action's exact parameter list (some take `(agentId, options)`, some take `()`); only insert the guard line as the new first statement.

- [ ] **Step 4: Run tests + syntax check**

Run: `node --check src/cli.js && node --test test/cli-encryption-guard.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/cli-encryption-guard.test.js
git commit -m "fix(cli): prompt to unlock encrypted key pool on all key-dependent commands"
```

---

### Task 3: Dashboard — surface WIF encryption in the Security menu

The `encrypt-keys`/`decrypt-keys`/`change-passphrase` commands are invisible to TUI-only users. Add them to the Security Setup screen, shelling out to the CLI via the corrected spawn pattern from Task 1.

**Files:**
- Modify: `src/dashboard.js` (`securityScreen` at ~`src/dashboard.js:2072`)
- Test: `test/dashboard-security-menu.test.js` (new)

**Interfaces:**
- Consumes: the corrected spawn pattern (`process.execPath` + `process.argv[1]`) and `runCommandAsync` from Task 1.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/dashboard-security-menu.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DASH = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.js'), 'utf8');

test('security screen offers WIF encryption actions', () => {
  const idx = DASH.indexOf('async function securityScreen');
  assert.ok(idx > -1);
  const block = DASH.slice(idx, idx + 3000);
  assert.match(block, /encrypt-keys/, 'no encrypt-keys action in security screen');
  assert.match(block, /change-passphrase/, 'no change-passphrase action in security screen');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard-security-menu.test.js`
Expected: FAIL — securityScreen has no encryption actions.

- [ ] **Step 3: Add the menu choices + handlers**

Read `securityScreen` (`src/dashboard.js:2072`) to match its existing `promptWithEsc` list shape and how it dispatches choices. Add two choices to the list (using the same `{ name, value }` style already there):

```js
    { name: '  🔐 Encrypt WIF keys at rest (set a passphrase)', value: 'encrypt-keys' },
    { name: '  🔑 Change encryption passphrase', value: 'change-passphrase' },
```

And handle them in the screen's action dispatch (matching how existing choices call `runCommandAsync`), using the Task 1 spawn pattern:

```js
    if (action === 'encrypt-keys') {
      await runCommandAsync(process.execPath, [process.argv[1], 'encrypt-keys']);
      return;
    }
    if (action === 'change-passphrase') {
      await runCommandAsync(process.execPath, [process.argv[1], 'change-passphrase']);
      return;
    }
```

Place these consistently with how the existing security actions (isolation setup, self-test) are dispatched in that function. Do not restructure the screen.

- [ ] **Step 4: Run tests + syntax check**

Run: `node --check src/dashboard.js && node --test test/dashboard-security-menu.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js test/dashboard-security-menu.test.js
git commit -m "feat(dashboard): surface WIF encryption in the Security menu"
```

---

### Task 4: Poll-mode job event emission (brainbox monitoring)

In the default poll mode, `job.accepted`, `job.completed`, and `job.delivered` never reach the control-API event bus, so an external monitor (brainbox) polling `/v1/events` misses job outcomes. Emit them at the poll-detection / handler sites using the existing guarded `state.emitEvent?.()` form. Webhook mode already emits via the generic path (`src/cli.js:5082`), so guard against double-emit by only adding emits at the poll/handler sites named below.

**Files:**
- Modify: `src/cli.js` (~`4912` job.completed poll-detect; ~`5095` after `acceptJob`; ~`5348` job.delivered handler)
- Test: `test/job-events-emit.test.js` (new — source-level assertion; the poll loop and message handler are closures inside `start` and are not unit-callable)

**Interfaces:**
- Consumes: `state.emitEvent?.(type, data)` (defined in the `start` action; no-op when control API is off).
- Produces: `job.accepted` / `job.completed` / `job.delivered` bus events for poll-mode deployments.

- [ ] **Step 1: Write the failing test**

Create `test/job-events-emit.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CLI = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.js'), 'utf8');

for (const ev of ['job.accepted', 'job.completed', 'job.delivered']) {
  test(`${ev} is emitted to the event bus`, () => {
    const re = new RegExp(`emitEvent\\?\\.\\(\\s*['"]${ev.replace('.', '\\.')}['"]`);
    assert.match(CLI, re, `no state.emitEvent for ${ev}`);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/job-events-emit.test.js`
Expected: FAIL — none of the three are emitted (only `job.started`, `container.*`, `agent.*` are today).

- [ ] **Step 3: Add the emits**

Read each site first to confirm the in-scope variable names, then add the emit next to the existing action (do not remove the existing `sendToJobAgent`/`acceptJob` calls):

**Architecture note (corrected during execution):** `pollForJobs` (~cli.js:4773) owns BOTH poll-mode accept (~4845) and the status loop that detects completed/delivered (~4929/4944). `handleWebhookEvent` (~cli.js:5084) is webhook-mode only and its generic emit at ~5099 already mirrors every inbound event. So poll-mode emits go in `pollForJobs`; the webhook handler must NOT add its own (it would double the generic emit).

1. **job.completed** — poll status loop, `currentJob.status === 'completed'` branch (~cli.js:4929), right after `sendToJobAgent(activeInfo, { type: 'job.completed', data: { jobId } });`:

```js
        state.emitEvent?.('job.completed', { jobId, agentId: activeInfo.agentInfo?.id });
```

2. **job.accepted (poll)** — poll accept in `pollForJobs` (~cli.js:4846), right after the `✅ Job … accepted` log line, inside the `if (fullJob?.jobHash && fullJob?.buyerVerusId)` block:

```js
              state.emitEvent?.('job.accepted', { jobId: job.id, agentId: agentInfo.id });
```

3. **job.accepted (webhook)** — keep the emit after the webhook `acceptJob` (~cli.js:5113): `state.emitEvent?.('job.accepted', { jobId, agentId: agentInfo.id });`. The generic path emits `job.requested`, not `job.accepted`, so this is the non-duplicating webhook signal.

4. **job.delivered (poll)** — poll status loop, `currentJob.status === 'delivered'` branch (~cli.js:4944), right after `sendToJobAgent(activeInfo, { type: 'end_session_request', jobId });`:

```js
        state.emitEvent?.('job.delivered', { jobId, agentId: activeInfo.agentInfo?.id });
```

Do NOT add a `job.delivered` emit in the webhook `case 'job.delivered':` handler — the generic emit at ~5099 already covers webhook mode; an emit there would unconditionally double.

Use the variable actually in scope at each site (the event just needs `jobId` + a best-effort `agentId`).

- [ ] **Step 4: Run tests + full suite**

Run: `node --check src/cli.js && node --test test/job-events-emit.test.js && node --test test/*.test.js`
Expected: PASS (new file green; full suite still green).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/job-events-emit.test.js
git commit -m "feat(events): emit job.accepted/completed/delivered to the control-API bus in poll mode"
```

---

### Task 5: Documentation refresh (README + CLAUDE.md)

Bring the docs back in line with the actual command surface and add the missing prerequisites so a newcomer can get to a running agent.

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Test: none (docs only; verified by the checklist below)

**Interfaces:**
- Consumes: the real command surface and the changes from Tasks 1–4.
- Produces: nothing.

- [ ] **Step 1: Fix the command table + dashboard menu**

In `README.md` and `CLAUDE.md`:
- Add the security commands to the command table: `encrypt-keys`, `decrypt-keys`, `change-passphrase` (opt-in at-rest WIF encryption).
- Add the missing commands the audit found absent from tables: `activate-all`, `deactivate-all`, `api-setup`, `privacy`, and `ctl resources`.
- Correct the dashboard menu example so labels match `src/dashboard.js` (verify against the `choices` array in `dashboard.js:~210-234` — item `[3]` is "Configure Agent Executor", `[4]` is "Configure Global LLM Default"). Update CLAUDE.md's "Dashboard Menu Structure" to the current item count and labels.

- [ ] **Step 2: Add a "Before you begin" prerequisites block to Quick Start**

In `README.md`, before the Quick Start commands, add a prerequisites section listing, in order: (1) Docker installed; (2) build the job-agent image with `./scripts/build-image.sh` (required — not obvious); (3) fund a testnet VRSC address for the registration fee (link the standard verustest faucet). Note that `j41-dispatcher setup` needs (2) and (3) or it will hang mid-registration. Recommend the single-agent path (`j41-dispatcher setup agent-1 <name> --template <tpl>`) as the default rather than `init -n 9`.

- [ ] **Step 3: Document unattended operation + at-rest encryption**

Add a short "Unattended / production" note in `README.md`: the `J41_KEYS_PASSPHRASE` env var (or a systemd credential named `j41-keys-passphrase`) unlocks an encrypted key pool without an interactive prompt; without it, `start` and key-dependent commands prompt interactively. Mention `j41-dispatcher encrypt-keys` as the opt-in entry point and restate the honest scope (protects a stolen disk/backup, not a live-compromised host).

- [ ] **Step 4: Verify docs against reality**

Run these and confirm each documented command exists:
`for c in encrypt-keys decrypt-keys change-passphrase activate-all deactivate-all api-setup privacy dashboard; do grep -q "\.command('$c'" src/cli.js && echo "OK $c" || echo "MISSING $c"; done`
Expected: all `OK` (note `dashboard` is added in Task 1). Read the two docs once more for any remaining `node src/cli.js` reference and replace with `j41-dispatcher`.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: refresh command table, dashboard menu, prerequisites, and encryption/unattended notes"
```

---

## Self-Review

**Spec coverage (Tier 1 + 3a from the audit):**
- `node src/cli.js` → `j41-dispatcher` (hints) + spawn fixes → Task 1. ✓
- `dashboard` command registration → Task 1. ✓
- `init` next-step includes finalize → Task 1. ✓
- Encryption unlock guard on management commands (regression) → Task 2. ✓
- Encryption surfaced in dashboard → Task 3. ✓
- Poll-mode event emission (3a) → Task 4. ✓
- README/CLAUDE refresh + prereqs + `J41_KEYS_PASSPHRASE` docs → Task 5. ✓
- Single-agent quickstart guidance → Task 5 Step 2. ✓

**Deliberately OUT of scope (deferred, not regressions):** control-API write mutations (3b), `J41_EXECUTOR_MODULE` (3c), hirer `POST /v1/hire/*` (3d), `--json` on status/config, `NO_COLOR`/isTTY dashboard color guard, systemd unit sample, `register --finalize` double-register. These are Tier 2/3 — separate spec'd effort.

**Placeholder scan:** no TBD/TODO; every code step shows the exact edit; tests are source-level assertions (justified: the CLI/dashboard are large, side-effecting-on-require modules that are not unit-callable — this matches the honest testing posture used for interactive wiring elsewhere in this repo).

**Type consistency:** `ensureKeystoreUnlockedIfEncrypted()`, `runCommandAsync(cmd, args)`, `state.emitEvent?.(type, data)`, `process.execPath` + `process.argv[1]` — used identically across tasks. Task 3 depends on Task 1's spawn pattern; Task 4 depends on the `state.emitEvent` form already present.
