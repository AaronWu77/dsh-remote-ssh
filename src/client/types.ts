import type { RemoteSshLocaleKey } from './locales.ts'

export type Translate = (key: RemoteSshLocaleKey, params?: Record<string, unknown>) => string
