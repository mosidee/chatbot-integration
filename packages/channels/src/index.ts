export * from './adapters/line'
export * from './adapters/test-channel'
export * from './adapters/web-channel'
export * from './jwt'
export * from './signature'
export * from './text'
export * from './types'

import type { ChannelType } from '@ci/shared'
import { lineChannelAdapter } from './adapters/line'
import { testChannelAdapter } from './adapters/test-channel'
import { webChannelAdapter } from './adapters/web-channel'
import type { ChannelAdapter } from './types'

/**
 * Adapter lookup. Registering a channel here is the only wiring a new platform needs;
 * the webhook route, worker and console are already channel-neutral.
 */
const adapters: Partial<Record<ChannelType, ChannelAdapter<never>>> = {
  test: testChannelAdapter as ChannelAdapter<never>,
  web: webChannelAdapter as ChannelAdapter<never>,
  line: lineChannelAdapter as unknown as ChannelAdapter<never>,
}

export function getAdapter(type: ChannelType): ChannelAdapter<never> {
  const adapter = adapters[type]
  if (!adapter) throw new Error(`No adapter registered for channel type "${type}"`)
  return adapter
}

export function hasAdapter(type: ChannelType): boolean {
  return adapters[type] !== undefined
}
