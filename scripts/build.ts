import { build } from 'esbuild'
import ts from 'typescript'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'dist')
// Only this generator's own, verified output directory may be replaced.
if (dirname(out) !== root || basename(out) !== 'dist' || (existsSync(out) && lstatSync(out).isSymbolicLink())) throw new Error('Unsafe build output path')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
// Explicit declaration options: the repo tsconfig keeps `noEmit` on for editors,
// so the build composes the emit face itself instead of mutating that contract.
const srcDir = join(root, 'src')
const sources: string[] = []
for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && /\.tsx?$/.test(entry.name)) sources.push(join(entry.parentPath, entry.name))
}
const emitOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.ReactJSX, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.esnext.disposable.d.ts'],
  types: ['node', 'react', 'react-dom'], strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
  skipLibCheck: true, declaration: true, emitDeclarationOnly: true, allowImportingTsExtensions: true,
  rootDir: srcDir, outDir: join(out, 'types'), newLine: ts.NewLineKind.LineFeed,
}
const program = ts.createProgram(sources, emitOptions)
const diagnostics = ts.getPreEmitDiagnostics(program)
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  process.exitCode = 1
} else {
  console.log('Build output:', out)
  rmSync(out, { force: true, recursive: true })
  mkdirSync(out, { recursive: true })
  const base = { absWorkingDir: root, bundle: true, minify: true, target: 'es2022', legalComments: 'none' as const, sourcemap: false }
  const host = await build({ ...base, entryPoints: ['src/host/index.ts'], outfile: join(out, 'index.js'), platform: 'node', format: 'esm', packages: 'external', metafile: true })
  const client = await build({ ...base, entryPoints: ['src/client/index.ts'], outfile: join(out, 'client.js'), platform: 'browser', format: 'cjs', jsx: 'automatic', external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'], metafile: true,
    banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){var module={exports:{}};` },
    footer: { js: 'return module.exports;}});' },
  })
  const unexpected = Object.values(client.metafile.outputs).flatMap(output => output.imports).filter(item => item.external && !['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'].includes(item.path))
  if (unexpected.length) throw new Error('Forbidden client runtime dependency: ' + JSON.stringify(unexpected))
  const emitted = program.emit()
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('Declaration emission failed')
  // Declarations keep the source's `.ts` specifiers; published types must resolve as JS.
  let rewritten = 0
  for (const file of readdirSync(join(out, 'types'), { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.d.ts')) continue
    const path = join(file.parentPath, file.name)
    const text = readFileSync(path, 'utf8')
    const next = text.replace(/(from\s+['"]|import\(['"])(\.{1,2}\/[^'"]+)\.tsx?(['"])/g, (_match, lead: string, specifier: string, quote: string) => `${lead}${specifier}.js${quote}`)
    if (next !== text) { writeFileSync(path, next); rewritten += 1 }
  }
  console.log(`Declarations: ${rewritten} files rewritten to .js specifiers`)
  writeFileSync(join(out, 'build-meta.json'), JSON.stringify({ hostInputs: Object.keys(host.metafile.inputs), clientInputs: Object.keys(client.metafile.inputs), clientExternal: Object.values(client.metafile.outputs).flatMap(output => output.imports).filter(item => item.external).map(item => item.path) }, null, 2) + '\n')
  console.log('Built ESM host, lazy-factory client and TypeScript declarations.')
}
