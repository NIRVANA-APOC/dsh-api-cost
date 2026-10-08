/**
 * Release-contract tests: the built artifacts a consumer actually installs.
 * `pnpm test` builds first, so these assertions run against real output rather
 * than against sources.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const manifest = JSON.parse(read('package.json')) as {
  name: string; version: string; main: string; files: string[]; engines?: { node?: string }
  exports: Record<string, unknown>; dsh: { bundle: { patch: string }; client: { platform: string } }
}
const baseline = JSON.parse(read('docs/baseline.json')) as { artifacts: Record<string, { gzipBytes: number }> }
const CLIENT_BUDGET = 10240
const HOST_BUDGET = 20480

test('the manifest points at files that exist and ships them', () => {
  assert.equal(manifest.version, '2.0.0')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'] !== undefined, true)
  assert.deepEqual(manifest.files.filter(entry => entry.startsWith('dist')).length, 1)
  assert.equal(manifest.engines?.node, '>=24')
  for (const path of ['dist/index.js', 'dist/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
    assert.equal(existsSync(join(root, path)), true, path)
  }
  assert.equal(read('cordis.patch.yml').includes("name: 'dsh-api-cost'"), true)
})

test('the host entry is a real ESM plugin face', async () => {
  const text = read('dist/index.js')
  assert.ok(text.includes('export'), 'the host artifact is ESM')
  const module = await import(pathToFileURL(join(root, 'dist/index.js')).href) as { name?: string; inject?: string[]; apply?: unknown }
  assert.equal(module.name, 'dsh-api-cost')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual([...(module.inject ?? [])].sort(), ['sessionProjections', 'sessionQuery'], 'only the two capabilities the plugin cannot work without')
})

test('the client artifact registers lazily under the package name', () => {
  const text = read('dist/client.js')
  assert.ok(text.startsWith('window.__ModuleLoader__.load({id:"dsh-api-cost",factory(require){'), 'the idle loader handshake is the first statement')
  assert.ok(text.trimEnd().endsWith('return module.exports;}});'), 'the factory returns the module exports')
  const registered: { id?: string | undefined; factory?: ((require: (name: string) => unknown) => unknown) | undefined } = {}
  const requested: string[] = []
  const seeds: Record<string, unknown> = {
    react: { createElement: () => null, Fragment: {}, useCallback: () => () => {}, useEffect: () => {}, useId: () => 'id', useLayoutEffect: () => {}, useRef: () => ({ current: null }), useState: () => [undefined, () => {}], useSyncExternalStore: () => undefined },
    'react-dom': { createPortal: (node: unknown) => node },
    'react/jsx-runtime': { Fragment: {}, jsx: () => null, jsxs: () => null },
    'react-dom/client': {},
  }
  const loader = { load: (registration: typeof registered) => { registered.id = registration.id; registered.factory = registration.factory } }
  const evaluate = new Function('window', 'document', text)
  evaluate({ __ModuleLoader__: loader }, undefined)
  assert.equal(registered.id, 'dsh-api-cost')
  assert.equal(typeof registered.factory, 'function')
  const exports = registered.factory!((name: string) => {
    requested.push(name)
    const seed = seeds[name]
    if (seed === undefined) throw new Error('unexpected module-table request: ' + name)
    return seed
  }) as { inject?: string[]; apply?: unknown }
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
  for (const name of requested) assert.ok(Object.hasOwn(seeds, name), name)
})

test('the shipped bundles stay inside the lightweight budget', () => {
  const client = readFileSync(join(root, 'dist/client.js'))
  const host = readFileSync(join(root, 'dist/index.js'))
  const clientGzip = gzipSync(client, { level: 9 }).length
  const hostGzip = gzipSync(host, { level: 9 }).length
  assert.ok(clientGzip <= CLIENT_BUDGET, `client gzip ${clientGzip} B exceeds ${CLIENT_BUDGET} B`)
  assert.ok(hostGzip <= HOST_BUDGET, `host gzip ${hostGzip} B exceeds ${HOST_BUDGET} B`)
  assert.ok(clientGzip < baseline.artifacts.client!.gzipBytes, 'the rewrite must not grow the client bundle')
  const legacyHost = baseline.artifacts.host!.gzipBytes + baseline.artifacts.pricing!.gzipBytes
  assert.ok(hostGzip < legacyHost, 'the rewrite must not grow the host bundle')
})

test('the legacy JavaScript implementation is gone, not shadowed', () => {
  for (const path of ['index.mjs', 'client.js', 'lib/pricing.mjs', 'test/host.test.mjs', 'test/client.test.mjs', 'test/pricing.test.mjs']) {
    assert.equal(existsSync(join(root, path)), false, path + ' must not ship beside the TypeScript sources')
  }
  assert.equal(existsSync(join(root, 'lib')), false)
})

test('the host artifact depends on nothing but Node builtins and its declared peer', () => {
  const text = read('dist/index.js')
  const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(match => match[1]!)
  const bare = [...new Set(specifiers.filter(name => !name.startsWith('.')))].sort()
  for (const name of bare) {
    assert.ok(name.startsWith('node:') || name === 'zod', `unexpected runtime dependency: ${name}`)
  }
  assert.deepEqual(bare, ['node:crypto', 'zod'])
})

test('the client bundle never inlines a second React or a Harness UI package', () => {
  const text = read('dist/client.js')
  for (const forbidden of ['@deepseek-ai/dsh-client-ui-', 'react-dom.development', 'ReactDOM']) {
    assert.equal(text.includes(forbidden), false, forbidden)
  }
  const required = [...text.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
  for (const name of new Set(required)) assert.ok(['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'].includes(name!), `unexpected runtime require: ${name}`)
})
