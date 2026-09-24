/**
 * The text colour to put on a tenant's brand colour.
 *
 * Whichever of black and white reads better on it, by the WCAG contrast ratio. The first
 * version switched at a luminance of 0.45 and between white and a dark grey: mid-grey
 * brands got white at 3.9:1, and the grey reached only 4.4:1, so neither passed. Pure black
 * passes wherever white does not.
 */
export function readableOn(background: string): '#000000' | '#ffffff' | null {
  if (!/^#[0-9a-f]{6}$/i.test(background)) return null
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(background.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const onWhite = 1.05 / (luminance + 0.05)
  const onBlack = (luminance + 0.05) / 0.05
  return onBlack >= onWhite ? '#000000' : '#ffffff'
}

/** The WCAG contrast ratio between two colours, for tests and for anyone checking a pick. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}
