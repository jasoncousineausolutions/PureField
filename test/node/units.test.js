import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPt, parseMeasurement, toQuarterTurn, mediumSize } from '../../src/core/units.js';
import { XfaLog } from '../../src/xfa/log.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('absolute units convert to points', () => {
  close(toPt('1in'), 72);
  close(toPt('2.54cm'), 72);
  close(toPt('25.4mm'), 72);
  close(toPt('12pt'), 12);
  close(toPt('1pc'), 12);
  close(toPt('1000mp'), 1);
  close(toPt('-6.35mm'), -18);
  close(toPt('+.5in'), 36);
});

test('bare number is inches, zero needs no unit', () => {
  close(toPt('2'), 144);
  assert.equal(toPt('0'), 0);
  assert.equal(toPt('0mm'), 0);
  assert.equal(toPt(''), 0);
  assert.equal(toPt(null), 0);
});

test('unknown units yield 0 and log; px is not an XFA unit', () => {
  const log = new XfaLog();
  assert.equal(toPt('10px', { log }), 0);
  assert.equal(toPt('abc', { log }), 0);
  assert.deepEqual(log.entries.map(e => e.code), ['XFA_UNIT_UNKNOWN', 'XFA_UNIT_INVALID']);
});

test('percent and em need context', () => {
  assert.equal(toPt('50%'), 0);
  close(toPt('50%', { percentOf: 200 }), 100);
  close(toPt('2em'), 20);
  close(toPt('2em', { em: 12 }), 24);
  assert.deepEqual(parseMeasurement('3.5mm'), { value: 3.5, unit: 'mm' });
});

test('angles snap to quarter turns', () => {
  assert.equal(toQuarterTurn('90'), 90);
  assert.equal(toQuarterTurn('-90'), 270);
  assert.equal(toQuarterTurn('100'), 90);
  assert.equal(toQuarterTurn('400'), 0);
  assert.equal(toQuarterTurn(undefined), 0);
});

test('medium: short/long win, stock fallback, landscape swaps', () => {
  assert.deepEqual(mediumSize({ short: '8.5in', long: '11in' }), { width: 612, height: 792 });
  assert.deepEqual(mediumSize({ stock: 'legal' }), { width: 612, height: 1008 });
  assert.deepEqual(mediumSize({ stock: 'letter', orientation: 'landscape' }), { width: 792, height: 612 });
  assert.deepEqual(mediumSize({}), { width: 612, height: 792 });
});
