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

export type DeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'canceled'
  | 'uncertain'

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

  /**
   * The states where something did not go as planned, named in words rather than a bare
   * mark with a hover title nobody on a phone could read. The reason itself is printed on
   * the bubble (see `DeliveryProblem`).
   */
  if (status === 'failed' || status === 'canceled' || status === 'uncertain') {
    const label =
      status === 'failed'
        ? t('inbox.deliveryFailed')
        : status === 'canceled'
          ? t('inbox.deliveryCanceled')
          : t('inbox.deliveryUncertain')
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        data-testid={`delivery-${status}`}
        className={cn('font-semibold', status === 'canceled' ? 'opacity-70' : 'text-red-200')}
      >
        {status === 'canceled' ? '⊘' : '!'}
      </span>
    )
  }

  // Queued means it has not left here yet. A tick would claim more than we know.
  if (status === 'queued') {
    return (
      <span
        className="opacity-70"
        role="img"
        aria-label={t('inbox.deliveryQueued')}
        title={t('inbox.deliveryQueued')}
        data-testid="delivery-queued"
      >
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

/**
 * Why an outbound message did not simply arrive, printed under it.
 *
 * Failed: the platform refused, and the reason is its own. Withdrawn: a colleague took over
 * before it went. Uncertain: the platform did not answer, so it may have arrived; it is not
 * resent automatically, because a second copy is worse than a person checking.
 */
export function DeliveryProblem({
  status,
  error,
  onResend,
  resending = false,
}: {
  status: DeliveryStatus
  error: string | null | undefined
  /** Only for `failed`: nothing will try again on its own, so a person may. */
  onResend?: (() => void) | undefined
  resending?: boolean
}) {
  const { t } = useTranslation()
  if (status !== 'failed' && status !== 'canceled' && status !== 'uncertain') return null
  const lead =
    status === 'failed'
      ? t('inbox.deliveryFailed')
      : status === 'canceled'
        ? t('inbox.deliveryCanceled')
        : t('inbox.deliveryUncertainHint')
  return (
    <p className="mt-1 text-[11px] opacity-90" data-testid="delivery-problem">
      {lead}
      {error && status !== 'uncertain' ? `: ${error}` : ''}
      {status === 'failed' && onResend ? (
        <button
          type="button"
          data-testid="resend"
          disabled={resending}
          onClick={onResend}
          className="ml-2 font-semibold underline underline-offset-2 disabled:opacity-60"
        >
          {resending ? t('inbox.resending') : t('inbox.resend')}
        </button>
      ) : null}
    </p>
  )
}
