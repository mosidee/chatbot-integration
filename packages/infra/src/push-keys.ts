import webpush from 'web-push'

/**
 * A VAPID key pair for Web Push (ADR 0010), as `.env` lines.
 *
 * Printed, so on a server append it rather than reading it: `bun run push:keys >> .env`.
 * Generate once per installation. New keys strand every device already subscribed, which
 * then has to turn notifications on again.
 */
const keys = webpush.generateVAPIDKeys()
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`)
