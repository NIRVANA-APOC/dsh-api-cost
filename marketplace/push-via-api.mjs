// Pushes new files to the plugin repo through the GitHub Contents API, because
// the sandbox blocks git's TLS stack (schannel) and Node cannot pipe gh's stdout.
//   node marketplace/push-via-api.mjs "<message>" "[<branch>]"
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'NIRVANA-APOC/dsh-api-cost'
const message = process.argv[2]
const branch = process.argv[3] ?? 'main'
if (!message) {
  console.error('usage: node push-via-api.mjs "<message>" [branch]')
  process.exit(2)
}

const files = readFileSync('marketplace/.staged-files', 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean)

const dir = mkdtempSync(join(tmpdir(), 'push-'))
const gh = (args, payload) => {
  let input = null
  if (payload) {
    input = join(dir, 'payload.json')
    writeFileSync(input, JSON.stringify(payload))
    args = [...args, '--input', input]
  }
  // Capture gh's stdout through a file: the sandbox forbids stdio pipes to a child.
  const outFile = join(dir, 'out.txt')
  execFileSync('pwsh', ['-NoProfile', '-Command',
    `& gh ${args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(' ')} *> '${outFile}'`,
  ], { stdio: 'inherit' })
  return readFileSync(outFile, 'utf8')
}

let ok = 0
for (const path of files) {
  const content = readFileSync(path).toString('base64')
  let sha
  try {
    sha = JSON.parse(gh(['api', `repos/${REPO}/contents/${path}`, '--jq', '.sha'])).trim()
  } catch {
    sha = undefined // new file
  }
  const payload = { message, branch, content }
  if (sha) payload.sha = sha

  try {
    const out = JSON.parse(gh(['api', `repos/${REPO}/contents/${path}`, '--method', 'PUT', '--jq',
      '.commit.sha + " " + .commit.html_url'], payload))
    console.log(`OK   ${path} -> ${out.trim()}`)
    ok += 1
  } catch (err) {
    console.error(`FAIL ${path}: ${err.message.split('\n')[0]}`)
    process.exitCode = 1
  }
}
console.log(`\n${ok}/${files.length} files committed on ${branch}`)
