import { useTranslation } from 'react-i18next'
import { cn } from './ui'

/**
 * Delivery state on an outbound message, drawn the way every messaging app draws it.
 *
 * One tick means the platform accepted it, two that it reached the customer's device, and
 * two in colour that they opened the conversation. Agents already read this vocabulary
 * without being taught it, which is the whole reason for using it.
 *
 * Only Messenger reports delivery and read today, and it reports them as a watermark over
 * the whole conversation rather than per message. A channel that never sends receipts
 * simply stays on one tick, which is honest: we know it was accepted and nothing more.
 */

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed'

function Tick({ className, double }: { className?: string; double?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 12"
      className={cn('h-3 w-4', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 6.5 4.5 10 11 2" />
      {double ? <path d="M8.5 10 15 2" /> : null}
    </svg>
  )
}

export function DeliveryTicks({ status }: { status: DeliveryStatus }) {
  const { t } = useTranslation()

  if (status === 'failed') {
    return (
      <span className="font-semibold text-red-200" title={t('inbox.deliveryFailed')}>
        !
      </span>
    )
  }

  // Queued means it has not left here yet. A tick would claim more than we know.
  if (status === 'queued') {
    return (
      <span className="opacity-70" title={t('inbox.deliveryQueued')}>
        <svg
          viewBox="0 0 12 12"
          className="h-3 w-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.75 1" strokeLinecap="round" />
        </svg>
      </span>
    )
  }

  const label =
    status === 'read'
      ? t('inbox.deliveryRead')
      : status === 'delivered'
        ? t('inbox.deliveryDelivered')
        : t('inbox.deliverySent')

  return (
    <span role="img" data-testid={`delivery-${status}`} title={label} aria-label={label}>
      <Tick
        double={status !== 'sent'}
        // Colour is what separates "arrived" from "was read", exactly as elsewhere.
        className={status === 'read' ? 'text-sky-300' : undefined}
      />
    </span>
  )
}
