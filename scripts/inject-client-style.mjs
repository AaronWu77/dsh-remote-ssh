/** Put compiled CSS inside the module-table factory; browser loaders do not evaluate ESM stylesheet imports. */
import { readFile, writeFile } from 'node:fs/promises'
const root = new URL('../', import.meta.url)
const client = new URL('lib/client.js', root)
const css = await readFile(new URL('lib/style.css', root), 'utf8')
const code = await readFile(client, 'utf8')
const marker = 'factory: (require) => {'
if (!code.includes(marker) || /^import /m.test(code)) throw new Error('Expected a closed CommonJS module-table factory')
const injection = [
  'const cssTagId = "dsh-remote-ssh/style.css";',
  'if (!document.querySelector(' + JSON.stringify('style[data-plugin-css="dsh-remote-ssh/style.css"]') + ')) {',
  '  const style = document.createElement("style");',
  '  style.dataset.plugin = "dsh-remote-ssh";',
  '  style.dataset.pluginCss = cssTagId;',
  '  style.textContent = ' + JSON.stringify(css) + ';',
  '  document.head.appendChild(style);',
  '}',
].join('\n')
await writeFile(client, code.replace(marker, marker + '\n' + injection), 'utf8')
console.log('Embedded compiled CSS in the shared-module factory')
