// Local replica of awesome-dsh-plugin/scripts/lib/entries.mjs validation,
// used to pre-flight the entry before opening the PR.
import { readFileSync } from 'node:fs'
import yaml from '../node_modules/.pnpm/js-yaml@4.3.2/node_modules/js-yaml/index.js'

const CAT_IDS = ['agi', 'ui', 'usage', 'theme', 'model', 'identity', 'session', 'memory',
  'tools', 'wsl', 'browser', 'vision', 'voice', 'docs', 'skill', 'workflow', 'git',
  'notify', 'dev', 'security', 'remote', 'market', 'fun']
const ENTRY_KEYS = new Set(['url', 'name', 'category', 'description', 'tarball', 'file'])
const LOCALE_CODES = ['en', 'zh']
const TARBALL_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])

function slugFor(url) {
  const p = url.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  const repo = p.split('/').slice(0, 2).join('/')
  const sub = p.includes('/tree/') ? p.split('/tree/')[1].replace(/^[^/]+\//, '') : null
  const base = repo.replaceAll('/', '__')
  return sub ? `${base}--${sub.replaceAll('/', '-')}` : base
}

function tarballProblem(value) {
  if (typeof value !== 'string' || !value.trim()) return 'must be a URL string'
  let u
  try { u = new URL(value) } catch { return `is not a valid URL: ${value}` }
  if (u.protocol !== 'https:') return 'must be https'
  if (!TARBALL_HOSTS.has(u.hostname)) return `must be hosted on GitHub releases (got ${u.hostname})`
  if (u.hostname === 'github.com' && !u.pathname.includes('/releases/')) return 'must point at a GitHub release asset'
  if (!u.pathname.endsWith('.tgz') && !u.pathname.endsWith('.tar.gz')) return 'must point at a .tgz'
  return null
}

const file = process.argv[2]
const text = readFileSync(file, 'utf8')
const problems = []
const at = file

let e
try {
  e = yaml.load(text)
} catch (err) {
  console.error(`FAIL: ${at} does not parse as YAML: ${err.message}`)
  process.exit(1)
}

console.log('parsed keys:', JSON.stringify(Object.keys(e)))

const extra = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k))
if (extra.length) {
  problems.push(`${at}: unknown field${extra.length > 1 ? 's' : ''} ${extra.map((k) => `"${k}"`).join(', ')} — an entry may only declare ${[...ENTRY_KEYS].filter((k) => k !== 'file').join(', ')}.`)
}

if (typeof e.url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(e.url)) {
  problems.push(`${at}: url must be a https://github.com/owner/repo link`)
}

if (typeof e.name !== 'string' || !e.name.trim()) {
  problems.push(`${at}: name is required`)
} else {
  const before = e.name.split('#')[0]
  if (before.includes('/') && typeof e.url === 'string') {
    const want = e.url.replace(/^https:\/\/github\.com\//, '').split('/').slice(0, 2).join('/').toLowerCase()
    if (before.toLowerCase() !== want) {
      problems.push(`${at}: "name" says ${before} but the url is ${want}`)
    }
  }
}

if (!CAT_IDS.includes(e.category)) {
  problems.push(`${at}: category "${e.category}" is not one of ${CAT_IDS.join(', ')}`)
}

if (!e.description || typeof e.description !== 'object') {
  problems.push(`${at}: description is required`)
} else {
  for (const loc of Object.keys(e.description)) {
    if (!LOCALE_CODES.includes(loc)) {
      problems.push(`${at}: "description" has "${loc}", but the site renders only en and zh`)
    }
  }
  for (const loc of LOCALE_CODES) {
    const d = e.description[loc]
    if (d === undefined) {
      if (loc === 'en') problems.push(`${at}: "description.en" is required`)
      continue
    }
    if (typeof d !== 'string' || !d.trim()) {
      problems.push(`${at}: "description.${loc}" is present but empty — omit the key instead`)
      continue
    }
    if (d.includes('\n')) problems.push(`${at}: "description.${loc}" must be a single line`)
  }
}

const want = slugFor(e.url)
const base = 'NIRVANA-APOC__dsh-api-cost'
if (base !== want) problems.push(`${at}: filename must match the url — expected ${want}.yml`)

if (e.tarball !== undefined) {
  const tp = tarballProblem(e.tarball)
  if (tp) problems.push(`${at}: tarball ${tp}`)
}

const enLen = e.description?.en?.length ?? 0
const zhLen = e.description?.zh?.length ?? 0
console.log(`slug expected   : ${want}.yml`)
console.log(`slug actual     : ${base}.yml  ->  ${base === want ? 'OK' : 'MISMATCH'}`)
console.log(`category        : ${e.category} (${CAT_IDS.includes(e.category) ? 'valid' : 'INVALID'})`)
console.log(`description.en  : ${enLen} chars, single line: ${!e.description.en.includes('\n')}`)
console.log(`description.zh  : ${zhLen} chars, single line: ${e.description.zh ? !e.description.zh.includes('\n') : 'absent'}`)
console.log(`tarball         : ${e.tarball ?? '(none)'}`)

if (problems.length) {
  console.error('\nPROBLEMS:')
  for (const p of problems) console.error(' - ' + p)
  process.exit(1)
}
console.log('\nRESULT: entry passes every replicated validation rule.')
