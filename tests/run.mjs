import { readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Node 20 does not expand test globs. Pass explicit paths on every runtime.
const directory = new URL('./', import.meta.url)
const selected = readdirSync(directory).filter((name) => name.endsWith('.test.mjs'))
  .sort().map((name) => fileURLToPath(new URL(name, directory)))
if (selected.length === 0) throw new Error('No test files found')
// Arguments are forwarded so a caller can add runner flags (`--test-timeout=…`)
// or name files, but a file that is named *and* in the list above must not run
// twice: match by full path or by file name, and let the directory order win.
const named = process.argv.slice(2).filter((argument) => (
  !selected.some((file) => file === resolve(argument) || basename(file) === basename(argument))
))
const result = spawnSync(process.execPath, ['--test', ...named, ...selected], { stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
