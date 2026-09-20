import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Viewing an attached picture at a size you can actually read.
 *
 * In the thread an image is capped at a couple of hundred pixels, which is right for
 * scanning a conversation and useless for the thing customers actually send: a screenshot
 * of an error, a receipt, a photo of a screen. Opening it fills the window instead.
 *
 * Deliberately plain: no zoom, no gallery, no library. Escape or a click anywhere closes
 * it, and the picture is also a link, so an agent who needs to zoom further has the
 * browser's own viewer one click away.
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useTranslation()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    // The thread scrolls behind the overlay otherwise, which on a phone looks like the page
    // has jumped when it closes.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      data-testid="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('inbox.image')}
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onClose()
      }}
    >
      <img
        src={src}
        alt={alt}
        data-testid="lightbox-image"
        className="max-h-full max-w-full rounded-lg object-contain"
        // The overlay closes on any click; without this, clicking the picture itself would
        // close it too, which is the one place a person does not expect that.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      />
      <div className="absolute top-3 right-3 flex gap-2">
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          data-testid="lightbox-open"
          className="rounded-lg bg-white/90 px-2.5 py-1 text-[13px] font-medium text-black hover:bg-white"
          onClick={(event) => event.stopPropagation()}
        >
          {t('inbox.openImage')}
        </a>
        <button
          type="button"
          data-testid="lightbox-close"
          className="rounded-lg bg-white/90 px-2.5 py-1 text-[13px] font-medium text-black hover:bg-white"
          onClick={onClose}
        >
          {t('common.close')}
        </button>
      </div>
    </div>
  )
}
