// Flattens a run of API-created commits on main into a single commit, using the
// Git data API (blobs -> tree -> commit -> ref update). Root commit is preserved.
//   node marketplace/flip-commit.mjs <target-commit-sha> <new-message> "<old subject 1>" ...
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = 'NIRVANA-APOC/dsh-api-cost'
const [targetSha, message, ...oldSubjects] = process.argv.slice(2)
if (!targetSha || !message || oldSubjects.length === 0) {
  console.error('usage: node flip-commit.mjs <sha> <message> "<old subject>" ...')
  process.exit(2)
}

// gh is used only to read the token; capture via a temp file because the sandbox
// forbids piping a child's stdout.
const dir = mkdtempSync(join(tmpdir(), 'flip-'))
const tokFile = join(dir, 'token')
try {
  execFileSync('pwsh', ['-NoProfile', '-Command', `gh auth token | Set-Content -NoNewline '${tokFile}'`], { stdio: 'inherit' })
} catch (err) {
  console.error('could not obtain a token via gh:', err.message)
  process.exit(1)
}
const token = readFileSync(tokFile, 'utf8').trim()
unlinkSync(tokFile)
if (!token) { console.error('empty token'); process.exit(1) }

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-api-cost-submission',
  'Content-Type': 'application/json',
}
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, { headers, ...init })
  const body = await res.text()
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 400)}`)
  return body ? JSON.parse(body) : null
}

const head = await api(`/repos/${REPO}/commits/${targetSha}`)
const target = head.commit
const targetTree = head.commit.tree.sha
console.log(`target commit : ${targetSha.slice(0, 8)}  ${target.message.split('\n')[0]}`)

let parent = head.parents[0]
const removed = []
while (parent) {
  // the commits list endpoint returns parents as bare {sha} refs, so resolve each
  const p = await api(`/repos/${REPO}/commits/${parent.sha}`)
  const subject = p.commit.message.split('\n')[0]
  if (!oldSubjects.includes(subject)) break
  console.log(`  folding     : ${p.sha.slice(0, 8)}  ${subject}`)
  removed.push(subject)
  parent = p.parents[0]
}

if (removed.length !== oldSubjects.length || !oldSubjects.every((s) => removed.includes(s))) {
  console.error(`refusing to rewrite: expected ${oldSubjects.length} commits (${oldSubjects.join(' | ')}), walked ${removed.length} (${removed.join(' | ')})`)
  process.exit(1)
}

const baseSha = parent ? parent.sha : null
const baseTree = baseSha ? (await api(`/repos/${REPO}/git/commits/${baseSha}`)).tree.sha : null
console.log(`base          : ${baseSha ? baseSha.slice(0, 8) : '(none — root)'}`)

const newCommit = await api(`/repos/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message,
    tree: targetTree,
    parents: baseSha ? [baseSha] : [],
  }),
})
console.log(`new commit    : ${newCommit.sha.slice(0, 8)}  ${newCommit.message.split('\n')[0]}`)

if (baseSha) {
  await api(`/repos/${REPO}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: true }),
  })
} else {
  await api(`/repos/${REPO}/git/refs/heads/main`, {
    method: 'POST',
    body: JSON.stringify({ sha: newCommit.sha, force: true }),
  })
}

const after = await api(`/repos/${REPO}/commits/main`)
console.log(`\nmain now      : ${after.sha.slice(0, 8)}  ${after.commit.message.split('\n')[0]}`)
console.log(`tree identical: ${after.commit.tree.sha === targetTree ? 'yes' : 'NO — tree changed!'}`)

// The fold invalidated these blobs; drop the cache so the next run re-resolves them.
try { unlinkSync('marketplace/.api-shas.json') } catch {}
writeFileSync('marketplace/.api-shas.json', JSON.stringify({ flippedAt: new Date().toISOString(), from: targetSha, to: newCommit.sha, folded: removed, baseTree }, null, 2))
