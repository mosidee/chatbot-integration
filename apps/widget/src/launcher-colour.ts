/**
 * Black or white, whichever reads better on the brand colour. A copy of `readableOn` in
 * contrast.ts rather than an import: this file is embedded with a classic `<script>` tag,
 * and a chunk shared with the chat app would turn it into a module with an `import` the
 * host cannot run. Imported by the loader alone, so the build inlines it.
 * contrast.test.ts pins both to the same answers.
 */
export function launcherTextOn(background: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(background)) return '#fff'
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(background.slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff'
}
