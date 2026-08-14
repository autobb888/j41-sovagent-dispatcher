'use strict';
/**
 * One contender in the credit-meter race. Real process, because in-process calls
 * cannot reproduce a lost update — Node's single thread already serialises them,
 * which is exactly why this file went unlocked for so long.
 *
 * argv: <agentId> <buyer> <amount> <startAtEpochMs>
 */
const os = require('os');
const [agentId, buyer, amount, startAt] = process.argv.slice(2);
const { creditDeposit } = require('../../src/credit-meter.js');
void os;

const target = parseInt(startAt, 10);
while (Date.now() < target) { /* spin to a common instant */ }

try {
  creditDeposit(agentId, buyer, Number(amount), `tx_${process.pid}`);
  process.stdout.write('CREDITED\n');
} catch (e) {
  process.stdout.write(`FAILED:${e.message}\n`);
}
