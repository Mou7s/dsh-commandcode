import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const archive = 'scratch/dsh-commandcode-goat-0.8.0.tgz'
const [manifest] = JSON.parse(readFileSync('scratch/pack-manifest.json', 'utf8').replace(/^\uFEFF/, ''))
assert.equal(manifest.version, '0.8.0')
for (const file of manifest.files) {
  assert.ok(!file.path.includes('..') && !/^(scratch|tests|node_modules)\//.test(file.path))
  const packed = execFileSync('tar', ['-xOf', archive, `package/${file.path}`])
  assert.deepEqual(packed, readFileSync(file.path), `Packed file differs from source: ${file.path}`)
}
console.log(`Verified ${manifest.files.length} packed files against the working tree; no scratch data, tests or node_modules.`)
