/**
 * Display-only formatting: exact decimal strings in, human figures out.
 * Nothing here bills anything, so the assertions pin presentation rules only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countdownString, isMoneyString, isTokenString, moneyString, tokenString } from '../src/shared/format.ts'

test('money strings reject anything that is not an exact non-negative decimal', () => {
  for (const value of ['0', '1', '0.5', '123456789.123456789']) assert.equal(isMoneyString(value), true, value)
  for (const value of ['', ' 1', '1 ', '-1', '+1', '.5', '1.', '1e3', 'NaN', 'Infinity', '01', '1,000', 1, null, undefined, {}]) {
    assert.equal(isMoneyString(value), false, String(value))
  }
})

test('token strings are non-negative integers without padding or separators', () => {
  for (const value of ['0', '1', '99999999999999999999']) assert.equal(isTokenString(value), true, value)
  for (const value of ['', '1.5', '-1', '007', '1e3', 5, null, undefined]) assert.equal(isTokenString(value), false, String(value))
})

test('an absent or invalid amount reads as absence, never as zero', () => {
  assert.equal(moneyString(undefined), '—')
  assert.equal(moneyString(null), '—')
  assert.equal(moneyString('nope'), '—')
  assert.equal(moneyString('0'), '¥0')
  assert.equal(moneyString('0.000000001'), '<¥0.0001')
})

test('adaptive precision keeps small costs visible and whole costs two places', () => {
  assert.equal(moneyString('1.234567'), '¥1.23')
  assert.equal(moneyString('0.0004567'), '¥0.0005')
  assert.equal(moneyString('0.004567'), '¥0.0046')
  assert.equal(moneyString('1234567.891'), '¥1,234,567.89')
  assert.equal(moneyString('0.5', 'usd'), '$0.50')
  assert.equal(moneyString('0.05', 'usd'), '$0.05')
  assert.equal(moneyString('0.1234', 'usd'), '$0.123')
})

test('display rounding carries across digit boundaries without floating point', () => {
  assert.equal(moneyString('0.9999'), '¥1.00')
  assert.equal(moneyString('9.999'), '¥10.00')
  assert.equal(moneyString('0.00199'), '¥0.002')
  assert.equal(moneyString('0.99999999'), '¥1.00')
})

test('token counts stay grouped when small and compact when large', () => {
  assert.equal(tokenString('950'), '950')
  assert.equal(tokenString('10496'), '10.5k')
  assert.equal(tokenString('1500'), '1,500')
  assert.equal(tokenString('9999'), '9,999')
  assert.equal(tokenString('10000'), '10k')
  assert.equal(tokenString('999999'), '1M')
  assert.equal(tokenString('1280000'), '1.3M')
  assert.equal(tokenString('12345678'), '12.3M')
  assert.equal(tokenString('999500000'), '1,000M')
})

test('token display never invents Infinity for absurd counts', () => {
  const huge = '9'.repeat(60)
  const rendered = tokenString(huge)
  assert.ok(!rendered.includes('Infinity'), rendered)
  assert.ok(rendered.endsWith('M'), rendered)
})

test('the countdown is bounded, padded and never negative', () => {
  assert.equal(countdownString(-5000), '0m 00s')
  assert.equal(countdownString(0), '0m 00s')
  assert.equal(countdownString(1000), '0m 01s')
  assert.equal(countdownString(61000), '1m 01s')
  assert.equal(countdownString(3600000), '1h 00m')
  assert.equal(countdownString(86400000 + 7200000), '1d 2h')
  assert.equal(countdownString(Number.NaN), '—')
})
