/** Settings navigation glyph for the Remote SSH section. */
import { IconLinkOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionIconOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Render the Remote SSH navigation glyph.
 * @param props - shell-provided icon size; the glyph keeps the row's text color in both selection states.
 * @returns the section glyph.
 */
export function RemoteSshSettingsIcon({ size }: SettingsSectionIconOwnerProps) {
  return <IconLinkOutlineMedium size={size} />
}
