import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const innerPath = join('lib', 'client.inner.cjs')
const inner = await readFile(innerPath, 'utf8')
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-im",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${inner}
		return module.exports;
	}
});
`
await writeFile(join('lib', 'client.js'), wrapped, 'utf8')
console.log('wrote lib/client.js')
