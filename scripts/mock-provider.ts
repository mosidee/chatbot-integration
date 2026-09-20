/**
 * A stand-in OpenAI-compatible provider for local smoke tests, so the loop can be
 * exercised without spending money or needing network access.
 */
const port = Number(process.env.MOCK_PORT ?? 4010)

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname.endsWith('/models')) {
      return Response.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] })
    }

    const body = (await request.json()) as {
      messages?: { role: string; content: string }[]
    }
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
    const question = typeof lastUser?.content === 'string' ? lastUser.content : ''

    const reply = question.includes('ราคา')
      ? 'แพ็กเกจเริ่มต้นของ salon-saas ราคา 990 บาทต่อเดือนค่ะ รวมการจองคิวและระบบลูกค้าสัมพันธ์'
      : `ได้รับข้อความแล้วค่ะ: "${question.slice(0, 60)}"`

    return Response.json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    })
  },
})

console.log(`mock provider listening on http://localhost:${server.port}`)
