import { describe, expect, test } from 'bun:test'
import { toPlainText } from '../src/ai/plain-text'

describe('markdown a customer would otherwise read as punctuation', () => {
  test('bold loses its asterisks and keeps its words', () => {
    expect(toPlainText('**Growth ฿299/เดือน** ใช้ได้ 10 คน')).toBe('Growth ฿299/เดือน ใช้ได้ 10 คน')
    expect(toPlainText('__important__')).toBe('important')
    expect(toPlainText('***both***')).toBe('both')
  })

  test('italics only where it is really emphasis', () => {
    expect(toPlainText('that is *not* included')).toBe('that is not included')
    // A filename and a tool name are not emphasis, and mangling them is worse than a stray
    // underscore: the customer cannot tell what the original said.
    expect(toPlainText('set check_plan_status in settings')).toBe(
      'set check_plan_status in settings',
    )
    expect(toPlainText('the file is report_2026_final.pdf')).toBe(
      'the file is report_2026_final.pdf',
    )
  })

  test('a heading becomes a line of text', () => {
    expect(toPlainText('### ราคาแพ็กเกจ\nStarter ฿99')).toBe('ราคาแพ็กเกจ\nStarter ฿99')
  })

  test('a list keeps being a list', () => {
    expect(toPlainText('- Starter\n- Growth\n- Pro')).toBe('• Starter\n• Growth\n• Pro')
    expect(toPlainText('* one\n+ two')).toBe('• one\n• two')
    // Indentation survives, so a nested list still reads as nested.
    expect(toPlainText('- plan\n  - add-on')).toBe('• plan\n  • add-on')
  })

  test('a numbered list is left exactly as it is', () => {
    // It already reads correctly as plain text, and renumbering it would be meddling.
    expect(toPlainText('1. open settings\n2. paste the key')).toBe(
      '1. open settings\n2. paste the key',
    )
  })

  test('a link keeps the address, which is the useful half', () => {
    expect(toPlainText('see [the pricing page](https://example.com/pricing)')).toBe(
      'see the pricing page (https://example.com/pricing)',
    )
    // A bare link written as markdown should not be said twice.
    expect(toPlainText('[https://example.com](https://example.com)')).toBe('https://example.com')
  })

  test('an image keeps its description and address, with no stray punctuation', () => {
    expect(toPlainText('![screenshot](https://x.co/a.png)')).toBe('screenshot: https://x.co/a.png')
    expect(toPlainText('![](https://x.co/a.png)')).toBe('https://x.co/a.png')
  })

  test('a plain URL is untouched', () => {
    expect(toPlainText('go to https://salon.mosidee.com/settings now')).toBe(
      'go to https://salon.mosidee.com/settings now',
    )
  })

  test('code fences and backticks go, their contents stay', () => {
    expect(toPlainText('run `bun install` first')).toBe('run bun install first')
    expect(toPlainText('```\nSTARTER99\n```')).toBe('STARTER99')
  })

  test('a horizontal rule leaves no punctuation behind', () => {
    expect(toPlainText('ราคา\n\n---\n\nสรุป')).toBe('ราคา\n\nสรุป')
  })

  test('a quote of the customer keeps the words', () => {
    expect(toPlainText('> ยกเลิกยังไง\nกดที่ตั้งค่าค่ะ')).toBe('ยกเลิกยังไง\nกดที่ตั้งค่าค่ะ')
  })

  test('ordinary Thai and English come through untouched', () => {
    const thai = 'สวัสดีค่ะ แพ็กเกจ Starter ราคา ฿99/เดือน สอบถามเพิ่มเติมได้เลยนะคะ'
    expect(toPlainText(thai)).toBe(thai)
  })

  test('arithmetic and a price range are not emphasis', () => {
    expect(toPlainText('2 * 3 = 6')).toBe('2 * 3 = 6')
  })

  test('the reply that prompted all this', () => {
    // Taken from the pilot tenant, where the customer read every asterisk.
    const raw = [
      'เรื่อง "รายจ่ายประจำ" ค่ะ อธิบายให้ฟังดังนี้',
      '',
      '**รายจ่ายประจำ** เป็นฟีเจอร์ที่เริ่มใช้ได้ตั้งแต่แพ็กเกจ **Growth ขึ้นไป**',
      '',
      'วิธีใช้งาน:',
      '- คุณตั้งค่ารายจ่ายที่เกิดซ้ำทุกเดือน เช่น ค่าเช่า',
      '- ระบบจะ**บันทึกให้อัตโนมัติทุกเดือน**',
    ].join('\n')

    expect(toPlainText(raw)).toBe(
      [
        'เรื่อง "รายจ่ายประจำ" ค่ะ อธิบายให้ฟังดังนี้',
        '',
        'รายจ่ายประจำ เป็นฟีเจอร์ที่เริ่มใช้ได้ตั้งแต่แพ็กเกจ Growth ขึ้นไป',
        '',
        'วิธีใช้งาน:',
        '• คุณตั้งค่ารายจ่ายที่เกิดซ้ำทุกเดือน เช่น ค่าเช่า',
        '• ระบบจะบันทึกให้อัตโนมัติทุกเดือน',
      ].join('\n'),
    )
  })

  test('nothing in, nothing out', () => {
    expect(toPlainText('')).toBe('')
  })
})
