import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPicture, parseLocaleSet } from '../../src/xfa/picture.js';
import { XfaLog } from '../../src/xfa/log.js';

const f = (pic, raw, opts) => formatPicture(pic, raw, opts);

test('dates', () => {
  assert.equal(f('date{DD.MM.YYYY}', '2024-11-02'), '02.11.2024');
  assert.equal(f('date{MMM D, YYYY}', '2024-11-02'), 'Nov 2, 2024');
  assert.equal(f('date{D MMMM YYYY}', '20241102'), '2 November 2024');
  assert.equal(f('date{YY/M/D}', '2024-01-05'), '24/1/5');
  assert.equal(f('date{JJJ}', '2024-02-01'), '032');
  assert.equal(f('date{EEEE}', '2024-11-02'), 'Saturday');
  assert.equal(f("date{'Le 'D}", '2024-11-02'), 'Le 2');
  assert.equal(f('YYYY/MM/DD', '2024-11-02', { kind: 'dateTimeEdit' }), '2024/11/02');
  // not canonical → raw
  assert.equal(f('date{DD.MM.YYYY}', '11/02/2024'), '11/02/2024');
});

test('null, zero, literal alternates', () => {
  assert.equal(f('null{}|zero{}|date{DD.MM.YYYY}', null), '');
  assert.equal(f("null{'N/A'}|date{DD.MM.YYYY}", ''), 'N/A');
  assert.equal(f("null{'..........'}", null), '..........');
  assert.equal(f('null{*******-**}|num{9999999-99}', null), '       -  ');  // Attestation print: * shows blank
  assert.equal(f("null{'**'}", null), '**');
  assert.equal(f('zero{}|num{9999999-99}', '0'), '');
  assert.equal(f("'n/a'", 'anything'), 'n/a');
  assert.equal(f('date{DD.MM.YYYY}', null), '');
});

test('numbers', () => {
  assert.equal(f('num{z,zzz,zzz,zz9}', '1234567'), '1,234,567');
  assert.equal(f('num{z,zzz,zzz,zz9}', '12'), '12');
  assert.equal(f('num{z,zz9.99}', '0'), '0.00');
  assert.equal(f('num{z,zzz,zz9.99 $}', '1234.5'), '1,234.50 $');
  assert.equal(f('$z,zzz,zz9.99', '-42.126', { kind: 'numericEdit' }), '-$42.13');
  assert.equal(f('num{9999}', '42'), '0042');
  assert.equal(f('num{z9.999999}', '3.5'), '3.500000');
  assert.equal(f('num{z,zz9.zzz}', '1.5'), '1.5');
  assert.equal(f('num{z,zz9.zzz}', '2'), '2');
  assert.equal(f('num{zz9%}', '0.25'), '25%');
  assert.equal(f("null{'State Tax @ 0.00%'}|'State Tax @ 'z9.99'%'", '7.5', { kind: 'numericEdit' }), 'State Tax @ 7.50%');
  assert.equal(f('num{z,zz9.99}', 'abc'), 'abc');
  assert.equal(f('num{9999999-99}', '123456789'), '1234567-89');
});

test('text', () => {
  assert.equal(f('text{999-999-9999}', '6135550142'), '613-555-0142');
  assert.equal(f("'+1 ('999') '999-9999", '6135550142'), '+1 (613) 555-0142');
  assert.equal(f('99999|A9A 9A9', 'K1A0B1'), 'K1A 0B1');
  assert.equal(f('text{9999}', '12a4'), '12a4');
});

test('locales: localeSet symbols and named patterns', () => {
  const xml = new DOMParser().parseFromString(`<localeSet xmlns="http://www.xfa.org/schema/xfa-locale-set/2.7/">
    <locale name="de_DE"><calendarSymbols name="gregorian"><monthNames><month>Januar</month><month>Februar</month><month>März</month>
    <month>April</month><month>Mai</month><month>Juni</month><month>Juli</month><month>August</month><month>September</month>
    <month>Oktober</month><month>November</month><month>Dezember</month></monthNames></calendarSymbols>
    <numberPatterns><numberPattern name="currency">z,zz9.99 $</numberPattern></numberPatterns>
    <numberSymbols><numberSymbol name="decimal">,</numberSymbol><numberSymbol name="grouping">.</numberSymbol></numberSymbols>
    <currencySymbols><currencySymbol name="symbol">€</currencySymbol></currencySymbols></locale></localeSet>`, 'application/xml');
  const locales = parseLocaleSet(xml);
  assert.equal(f('date{D. MMMM YYYY}', '2024-03-05', { locale: 'de_DE', locales }), '5. März 2024');
  assert.equal(f('num{z,zzz,zz9.99}', '1234.5', { locale: 'de_DE', locales }), '1.234,50');
  assert.equal(f('num.currency{}', '1234.5', { locale: 'de_DE', locales }), '1.234,50 €');
});

test('unsupported symbols paint raw and log', () => {
  const log = new XfaLog();
  assert.equal(f('date{YYYYY}', '2024-11-02', { log }), '2024-11-02');
  assert.equal(f('num{9.99E}', '1.5', { log }), '1.5');
  assert.ok(log.byCode('XFA_PICTURE_UNSUPPORTED').length >= 1);
});

test('a numeric field without a picture shows its number without trailing zeros', async () => {
  const { displayValue } = await import('../../src/xfa/format.js');
  assert.equal(displayValue({ type: 'field', ui: { kind: 'numericEdit' }, raw: '2.00000000' }, {}), '2');
  assert.equal(displayValue({ type: 'field', ui: { kind: 'numericEdit' }, raw: '1.50' }, {}), '1.5');
  // a decimal value keeps its digits; text fields are left alone
  assert.equal(displayValue({ type: 'field', ui: { kind: 'numericEdit' }, value: { valueType: 'decimal' }, raw: '1.50' }, {}), '1.50');
  assert.equal(displayValue({ type: 'field', ui: { kind: 'textEdit' }, raw: '2.00' }, {}), '2.00');
});
