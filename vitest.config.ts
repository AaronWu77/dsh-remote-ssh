import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // The plugin's client tests render UI primitives that this workspace reaches
  // through a junction into the production checkout. That package resolves its
  // own React copy, and react-dom installs the hook dispatcher only on the copy
  // it pairs with, so components would read another copy's null dispatcher.
  // Both planes must share one React instance.
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    // `.local/` holds machine-local development backups (copies of peer packages)
    // and helpers; they are not this package's tests and are not run on CI.
    exclude: [...configDefaults.exclude, '**/.local/**'],
  },
})
