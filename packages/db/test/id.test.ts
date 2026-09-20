import { describe, expect, test } from 'bun:test'
import { newId } from '../src/id'

describe('newId', () => {
  test('returns a v7 uuid', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('is time-ordered so ids sort chronologically', async () => {
    const first = newId()
    await Bun.sleep(2)
    const second = newId()
    expect([second, first].sort()).toEqual([first, second])
  })

  test('does not collide across a tight loop', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()))
    expect(ids.size).toBe(5000)
  })
})
