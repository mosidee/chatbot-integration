import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from './ui'

/**
 * Viewing an attached picture at a size you can actually read.
 *
 * In the thread an image is capped at a couple of hundred pixels, which is right for
 * scanning a conversation and useless for the thing customers actually send: a screenshot
 * of an error, a receipt, a photo of a screen. Opening it fills the window instead.
 *
 * Deliberately plain: no zoom, no gallery, no library. Escape or a click outside the
 * picture closes it, and the picture is also a link, so an agent who needs to zoom further
 * has the browser's own viewer one click away. Focus moves into it and back to the
 * thumbnail on close (`Dialog`).
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useTranslation()

  useEffect(() => {
    // The thread scrolls behind the overlay otherwise, which on a phone looks like the page
    // has jumped when it closes.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  return (
    <Dialog label={alt || t('inbox.image')} onClose={onClose} testId="lightbox">
      {/* The backdrop is a button so that closing by clicking it is reachable, and named. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('common.close')}
        className="absolute inset-0 h-full w-full cursor-default bg-black/80"
        onClick={onClose}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <img
          src={src}
          alt={alt}
          data-testid="lightbox-image"
          className="pointer-events-auto max-h-full max-w-full rounded-lg object-contain"
        />
      </div>
      <div className="absolute top-3 right-3 flex gap-2">
        <button
          type="button"
          data-testid="lightbox-close"
          className="rounded-lg bg-white/90 px-2.5 py-1 text-[13px] font-medium text-black hover:bg-white"
          onClick={onClose}
        >
          {t('common.close')}
        </button>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          data-testid="lightbox-open"
          className="rounded-lg bg-white/90 px-2.5 py-1 text-[13px] font-medium text-black hover:bg-white"
        >
          {t('inbox.openImage')}
        </a>
      </div>
    </Dialog>
  )
}
