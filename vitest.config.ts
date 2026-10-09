import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `.local/` holds machine-local development backups (copies of peer packages)
    // and helpers; they are not this package's tests and are not run on CI.
    exclude: [...configDefaults.exclude, '**/.local/**'],
  },
})
