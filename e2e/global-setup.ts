import { request } from '@playwright/test'
import { apiSignIn, clearInbox } from './helpers'

/**
 * One tidy-up before the suite runs.
 *
 * Every spec creates conversations and none of them removes one, which cost nothing while
 * the inbox was ordered newest first. It is no longer free: the queue is ordered by longest
 * wait, so conversations nobody ever answered stay at the top and push each new arrival off
 * the page the list actually asks for.
 */
export default async function globalSetup(): Promise<void> {
  const context = await request.newContext()
  try {
    await apiSignIn(context)
    await clearInbox(context)
  } finally {
    await context.dispose()
  }
}
