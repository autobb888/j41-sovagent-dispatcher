'use strict';
/**
 * The credit meter holds buyers' real prepaid balances and is written by more
 * than one process.
 *
 * For most of this system's life the daemon was the only writer, so the
 * synchronous load → mutate → save was safe by accident: Node's single thread
 * serialised it. `deposits credit` broke that assumption — an operator resolving
 * an anomaly out-of-band is a second process — while the proxy path writes this
 * file two or three times per served request.
 *
 * Two adversarial audits found the gap independently, after a commit message of
 * mine claimed the deposit lock covered "both files". It did not: it covered
 * deposits.json. This is the test that would have caught the claim.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RACER = path.join(__dirname, 'fixtures', 'meter-racer.js');

test('concurrent processes crediting one buyer do not lose a balance update', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'j41-meterrace-'));
  const agentId = 'agent-meter-race';
  const buyer = 'racer@';
  fs.mkdirSync(path.join(home, '.j41', 'dispatcher', 'agents', agentId), { recursive: true, mode: 0o700 });

  const N = 8;
  const startAt = Date.now() + 1200;
  const kids = Array.from({ length: N }, () =>
    spawn(process.execPath, [RACER, agentId, buyer, '1', String(startAt)],
      { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }));

  const { balance, ok, errs } = await new Promise((resolve) => {
    let exited = 0;
    const outs = new Array(N).fill('');
    const errsArr = new Array(N).fill('');
    kids.forEach((c, i) => {
      c.stdout.on('data', (d) => { outs[i] += String(d); });
      c.stderr.on('data', (d) => { errsArr[i] += String(d); });
      c.on('exit', () => {
        if (++exited !== N) return;
        let b = null;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(home, '.j41', 'dispatcher', 'agents', agentId, 'credit-meters.json'), 'utf8'));
          b = m.buyers[buyer].balance;
        } catch {}
        fs.rmSync(home, { recursive: true, force: true });
        resolve({ balance: b, ok: outs.filter((o) => o.includes('CREDITED')).length, errs: errsArr });
      });
    });
  });

  assert.equal(ok, N, `every contender should have credited; stderr: ${JSON.stringify(errs)}`);
  assert.equal(balance, N,
    `${N} credits of 1 VRSC must leave a balance of ${N}, found ${balance} — a lost ` +
    `read-modify-write on a real buyer balance. stderr: ${JSON.stringify(errs)}`);
});
