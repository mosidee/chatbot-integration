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

/** The built-in registry, so anything else in the offered set is the tenant's own. */
const INTERNAL_TOOL_NAMES = new Set([
  'handoff_to_human',
  'tag_conversation',
  'set_customer_field',
  'get_customer_profile',
  'search_knowledge',
  'search_past_conversations',
  'request_identity_verification',
])

function toolCallResponse(name: string, args: Record<string, unknown>): Response {
  return Response.json({
    id: `chatcmpl-mock-${name}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_mock_${name}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
  })
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

    // An unknown model is refused the way a real gateway refuses one, so the console can be
    // tested against a failure as well as a success.
    const probe = (await request.clone().json()) as { model?: string }
    if (probe.model && !probe.model.startsWith('mock')) {
      return Response.json(
        {
          error: {
            message: `The supported API model names are mock-model, mock-model-vision, but you passed ${probe.model}.`,
            type: 'invalid_request_error',
          },
        },
        { status: 400 },
      )
    }

    const body = (await request.json()) as {
      messages?: { role: string; content: string | { type: string }[] }[]
      tools?: { function?: { name?: string } }[]
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

    /**
     * A customer volunteering a phone number gets it recorded, the way a real model would.
     *
     * Only on the first pass: once the tool has answered, the conversation carries a `tool`
     * message and the model is expected to write a reply instead of calling again. Without
     * that check the turn would loop until the harness gave up.
     */
    const offersPhone = /0\d[\d\s-]{7,}\d/.exec(question)
    const canSetField = (body.tools ?? []).some((t) => t.function?.name === 'set_customer_field')
    const alreadyCalled = (body.messages ?? []).some((m) => m.role === 'tool')

    /**
     * Call whichever tool the workspace defined for itself.
     *
     * Named by exclusion rather than by a fixed name, so an end-to-end test can define a
     * tool called anything and still see it exercised. Guarded by the same "no tool message
     * yet" check: without it the turn would call forever.
     */
    const tenantTool = (body.tools ?? [])
      .map((t) => t.function?.name)
      .find((name) => name && !INTERNAL_TOOL_NAMES.has(name))

    if (/check my plan|แพ็กเกจของฉัน/i.test(question) && tenantTool && !alreadyCalled) {
      return toolCallResponse(tenantTool, {})
    }

    /**
     * Asking for a person, which is what a browser test needs to reach the handoff path.
     *
     * Every other route to a handoff in this mock is a failure of some kind, and a test
     * that asserts the customer was told somebody is coming should not have to break the
     * provider to get there.
     */
    const canHandOff = (body.tools ?? []).some((t) => t.function?.name === 'handoff_to_human')
    if (/talk to a human|ขอคุยกับเจ้าหน้าที่/i.test(question) && canHandOff && !alreadyCalled) {
      return toolCallResponse('handoff_to_human', {
        reason: 'customer_requested',
        note: 'Asked for a person.',
      })
    }

    const canVerify = (body.tools ?? []).some(
      (t) => t.function?.name === 'request_identity_verification',
    )
    if (/verify me|ยืนยันตัวตน/i.test(question) && canVerify && !alreadyCalled) {
      return toolCallResponse('request_identity_verification', {})
    }

    // Answering from what the tool returned, which is what a real model does and what lets
    // a test assert that the tool's answer actually reached the customer.
    const toolAnswer = [...(body.messages ?? [])].reverse().find((m) => m.role === 'tool')
    if (toolAnswer && typeof toolAnswer.content === 'string') {
      const plan = /"plan"\s*:\s*"([^"]+)"/.exec(toolAnswer.content)?.[1]
      if (plan) {
        return Response.json({
          id: 'chatcmpl-mock-tool-answer',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `แพ็กเกจของคุณคือ ${plan} ค่ะ` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 140, completion_tokens: 20, total_tokens: 160 },
        })
      }
    }

    if (offersPhone && canSetField && !alreadyCalled) {
      return Response.json({
        id: 'chatcmpl-mock-tool',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_mock_phone',
                  type: 'function',
                  function: {
                    name: 'set_customer_field',
                    arguments: JSON.stringify({ key: 'phone', value: offersPhone[0].trim() }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
      })
    }

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
