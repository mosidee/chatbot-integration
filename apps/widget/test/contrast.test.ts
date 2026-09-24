import { describe, expect, test } from 'bun:test'
import { contrastRatio, readableOn } from '../src/contrast'
import { launcherTextOn } from '../src/launcher-colour'

/** U10: text on a tenant's brand colour must be readable, whatever the brand. */
describe('readableOn', () => {
  for (const brand of [
    '#808080',
    '#2563eb',
    '#fde047',
    '#ff0000',
    '#10b981',
    '#1f2937',
    '#f5f5f5',
    '#767676',
  ]) {
    test(`${brand} gets text at 4.5:1 or better`, () => {
      const text = readableOn(brand)
      expect(text).not.toBeNull()
      expect(contrastRatio(brand, text as string)).toBeGreaterThanOrEqual(4.5)
    })
  }

  test('mid-grey gets black, which the old white-or-grey choice could not reach', () => {
    expect(readableOn('#808080')).toBe('#000000')
  })

  test('refuses something that is not a colour', () => {
    expect(readableOn('red; background: url(x)')).toBeNull()
  })
})

describe('the launcher', () => {
  test('makes the same choice as the chat inside it', () => {
    for (const brand of ['#808080', '#2563eb', '#fde047', '#1f2937', '#f5f5f5']) {
      expect(launcherTextOn(brand)).toBe(readableOn(brand) as string)
    }
  })
})
