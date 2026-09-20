import { describe, expect, test } from 'bun:test'
import { stripReasoning } from '../src/ai/reasoning'

/**
 * A reasoning model is supposed to report its thinking separately. Several gateways leave
 * it inside the message content instead, and the customer reads it.
 */

describe('stripReasoning', () => {
  test('removes the empty block a gateway prefixed to a Claude answer', () => {
    // Captured from production, tag and all.
    const answer = '<think></think>สวัสดีค่ะคุณโม 🙏'

    expect(stripReasoning(answer)).toBe('สวัสดีค่ะคุณโม 🙏')
  })

  test('removes a block that actually contains thinking', () => {
    const answer = [
      '<think>',
      'The customer asks about pricing. The knowledge base says 990 baht.',
      '</think>',
      'แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ',
    ].join('\n')

    expect(stripReasoning(answer)).toBe('แพ็กเกจเริ่มต้น 990 บาทต่อเดือนค่ะ')
  })

  test('handles the other names models use', () => {
    for (const tag of ['thinking', 'reasoning', 'thought']) {
      expect(stripReasoning(`<${tag}>hidden</${tag}>ok`)).toBe('ok')
    }
  })

  test('removes a block with attributes on the tag', () => {
    expect(stripReasoning('<think duration="2s">hm</think>ok')).toBe('ok')
  })

  test('removes several blocks', () => {
    expect(stripReasoning('<think>a</think>one<think>b</think>two')).toBe('onetwo')
  })

  test('drops everything after an opener that never closes', () => {
    // The answer was cut off mid-thought. What follows is thinking and none of it is an
    // answer, so sending it would be worse than sending nothing: an empty reply hands off.
    expect(stripReasoning('<think>I should check the price')).toBe('')
    expect(stripReasoning('ok so far<think>then it stopped')).toBe('ok so far')
  })

  test('leaves an ordinary answer untouched', () => {
    const answer = 'แพ็กเกจ Pro ราคา 1,290 บาทต่อเดือนค่ะ\n\nสมัครได้ที่หน้าเว็บเลยนะคะ'

    expect(stripReasoning(answer)).toBe(answer)
  })

  test('leaves markdown and code alone', () => {
    const answer = '| แพ็กเกจ | ราคา |\n|---|---|\n| ฟรี | ฿0 |'

    expect(stripReasoning(answer)).toBe(answer)
  })

  test('is not confused by a word that merely starts the same way', () => {
    const answer = '<thinker>not a reasoning tag</thinker>'

    expect(stripReasoning(answer)).toBe(answer)
  })

  test('trims what is left', () => {
    expect(stripReasoning('  <think>a</think>\n\n  answer  ')).toBe('answer')
  })
})
