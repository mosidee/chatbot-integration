import type { Logger } from '@ci/core'

/** Line-delimited JSON logging, which is what container log collectors expect. */
export function createLogger(service: string, level: 'debug' | 'info' | 'warn' = 'info'): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 }
  const threshold = order[level]

  const emit = (severity: keyof typeof order, message: string, meta?: Record<string, unknown>) => {
    if (order[severity] < threshold) return
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: severity,
      service,
      message,
      ...meta,
    })
    if (severity === 'error' || severity === 'warn') console.error(line)
    else console.log(line)
  }

  return {
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
  }
}
