/**
 * A stand-in OpenAI-compatible provider for local smoke tests, so the loop can be
 * exercised without spending money or needing network access.
 */
const port = Number(process.env.MOCK_PORT ?? 4010)

function trigramEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  const normalised = ` ${text.toLowerCase().trim()} `

  for (let i = 0; i < normalised.length - 2; i += 1) {
    const gram = normalised.slice(i, i + 3)
    let hash = 2166136261
    for (let c = 0; c < gram.length; c += 1) {
      hash ^= gram.charCodeAt(c)
      hash = Math.imul(hash, 16777619)
    }
    const slot = Math.abs(hash) % dimensions
    vector[slot] = (vector[slot] ?? 0) + 1
  }

  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) {
    vector[0] = 1
    return vector
  }
  return vector.map((v) => v / magnitude)
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)

    // Deterministic embeddings: character trigrams hashed into a fixed-size vector, then
    // normalised, so text sharing substrings lands nearby. Enough for retrieval to behave
    // meaningfully without calling a real provider.
    if (url.pathname.endsWith('/embeddings')) {
      const payload = (await request.json()) as {
        input?: string | string[]
        model?: string
        dimensions?: number
      }
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? '']
      const dimensions = payload.dimensions ?? 1024

      return Response.json({
        object: 'list',
        model: payload.model ?? 'mock-embed-model',
        data: inputs.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: trigramEmbedding(text, dimensions),
        })),
        usage: { prompt_tokens: 10, total_tokens: 10 },
      })
    }

    if (url.pathname.endsWith('/models')) {
      // More than one, so a test can prove the console offers a choice rather than a single
      // value it could have guessed.
      return Response.json({
        object: 'list',
        data: [
          { id: 'mock-model', object: 'model' },
          { id: 'mock-model-vision', object: 'model' },
          { id: 'mock-embedding', object: 'model' },
        ],
      })
    }

    const body = (await request.json()) as {
      messages?: { role: string; content: string | { type: string }[] }[]
    }
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')

    // A vision request carries content parts rather than a plain string.
    const isVisionRequest =
      Array.isArray(lastUser?.content) &&
      lastUser.content.some((part) => part.type === 'file' || part.type === 'image_url')

    if (isVisionRequest) {
      return Response.json({
        id: 'chatcmpl-mock-vision',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-vision-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content:
                'A screenshot of the salon-saas booking screen showing the error "payment declined" in red beneath the Confirm button.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 800, completion_tokens: 30, total_tokens: 830 },
      })
    }

    const question = typeof lastUser?.content === 'string' ? lastUser.content : ''

    const reply = question.includes('description of the image')
      ? 'จากภาพที่ส่งมา ระบบแจ้งว่าการชำระเงินถูกปฏิเสธค่ะ รบกวนตรวจสอบบัตรหรือลองใหม่อีกครั้งนะคะ'
      : question.includes('ราคา')
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
