import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, stat, utimes, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import {
  adopt,
  expandHome,
  formatBytes,
  list,
  monthKey,
  prune,
  put,
  stats,
  stamp,
  trashEmpty,
} from '../lib/store.js'

async function tempRoot(name) {
  return await mkdtemp(join(tmpdir(), `dsh-backup-${name}-`))
}

test('formatting helpers are stable', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5)
  assert.equal(monthKey(date), '2026-01')
  assert.equal(stamp(date), '20260102-030405')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(expandHome('~'), process.env.HOME)
  assert.equal(expandHome('~/config'), join(process.env.HOME, 'config'))
})

test('put snapshots files and skips unchanged content', async () => {
  const root = await tempRoot('put')
  const sourceDir = await tempRoot('source')
  const source = join(sourceDir, 'config.yml')
  try {
    await writeFile(source, 'version: 1\n')
    const first = await put({ root, paths: [source], maxFileMb: 1 })
    assert.equal(first.length, 1)
    assert.ok(first[0].snapshot)
    assert.equal(await readFile(first[0].snapshot, 'utf8'), 'version: 1\n')

    const second = await put({ root, paths: [source], maxFileMb: 1 })
    assert.equal(second[0].skipped, 'unchanged')

    await writeFile(source, 'version: 2\n')
    const third = await put({ root, paths: [source], maxFileMb: 1 })
    assert.ok(third[0].snapshot)
    assert.notEqual(third[0].snapshot, first[0].snapshot)
    assert.equal(await readFile(third[0].snapshot, 'utf8'), 'version: 2\n')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})

test('put rejects files already inside the backup root', async () => {
  const root = await tempRoot('inside')
  const source = join(root, 'nested', 'file.txt')
  try {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(source, 'inside\n')
    const result = await put({ root, paths: [source], maxFileMb: 1 })
    assert.equal(result[0].skipped, 'already inside the backup root')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('adopt moves an existing tree and preserves its age', async () => {
  const root = await tempRoot('adopt-root')
  const oldDir = await tempRoot('adopt-old')
  const oldFile = join(oldDir, 'nested', 'old.bak')
  const oldTime = new Date('2025-01-02T03:04:05Z')
  try {
    await mkdir(join(oldDir, 'nested'), { recursive: true })
    await writeFile(oldFile, 'old backup\n')
    await utimes(oldFile, oldTime, oldTime)
    const moved = await adopt({ root, dir: oldDir })
    assert.equal(moved.length, 1)
    assert.equal(existsSync(oldFile), false)
    assert.equal(existsSync(oldDir), false)
    assert.equal(await readFile(moved[0].to, 'utf8'), 'old backup\n')
    assert.ok(Math.abs((await stat(moved[0].to)).mtimeMs - oldTime.getTime()) < 2000)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(oldDir, { recursive: true, force: true })
  }
})

test('adopt refuses to move the backup root into itself', async () => {
  const root = await tempRoot('adopt-self')
  try {
    await writeFile(join(root, 'file.txt'), 'x')
    await assert.rejects(() => adopt({ root, dir: root }), /cannot adopt/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('list and prune operate on retention windows', async () => {
  const root = await tempRoot('prune')
  const sourceDir = await tempRoot('prune-source')
  const source = join(sourceDir, 'config.txt')
  try {
    await writeFile(source, 'retention\n')
    const saved = await put({ root, paths: [source], maxFileMb: 1 })
    const old = new Date('2024-01-01T00:00:00Z')
    await utimes(saved[0].snapshot, old, old)

    const visible = await list({ root, olderThanDays: 30 })
    assert.equal(visible.length, 1)

    const dry = await prune({ root, keepDays: 30, dryRun: true })
    assert.equal(dry.length, 1)
    assert.equal(existsSync(saved[0].snapshot), true)

    const removed = await prune({ root, keepDays: 30 })
    assert.equal(removed.length, 1)
    assert.equal(existsSync(saved[0].snapshot), false)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})

test('trash-empty uses the supplied trash root and supports dry-run', async () => {
  const trashRoot = await tempRoot('trash')
  const filesDir = join(trashRoot, 'files')
  const infoDir = join(trashRoot, 'info')
  const oldPath = join(filesDir, 'old-item')
  const newPath = join(filesDir, 'new-item')
  const oldInfo = join(infoDir, 'old-item.trashinfo')
  const newInfo = join(infoDir, 'new-item.trashinfo')
  const old = new Date('2024-01-01T00:00:00Z')
  try {
    await mkdir(filesDir, { recursive: true })
    await mkdir(infoDir, { recursive: true })
    await writeFile(oldPath, 'old')
    await writeFile(newPath, 'new')
    await writeFile(oldInfo, 'old')
    await writeFile(newInfo, 'new')
    await utimes(oldPath, old, old)
    await utimes(oldInfo, old, old)

    const dry = await trashEmpty({ keepDays: 30, dryRun: true, trashRoot })
    assert.deepEqual(dry, ['old-item'])
    assert.equal(existsSync(oldPath), true)

    const removed = await trashEmpty({ keepDays: 30, trashRoot })
    assert.deepEqual(removed, ['old-item'])
    assert.equal(existsSync(oldPath), false)
    assert.equal(existsSync(newPath), true)
  } finally {
    await rm(trashRoot, { recursive: true, force: true })
  }
})

test('stats counts snapshots by month', async () => {
  const root = await tempRoot('stats')
  const sourceDir = await tempRoot('stats-source')
  try {
    const first = join(sourceDir, 'a.txt')
    const second = join(sourceDir, 'b.txt')
    await writeFile(first, 'a')
    await writeFile(second, 'bb')
    await put({ root, paths: [first, second], maxFileMb: 1 })
    const result = await stats({ root })
    assert.equal(result.total, 2)
    assert.equal(result.bytes, 3)
    assert.equal(result.months.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})

test('apply registers the DSH backup tool and executes an operation', async () => {
  const root = await tempRoot('plugin')
  const sourceDir = await tempRoot('plugin-source')
  const source = join(sourceDir, 'profile.json')
  const registered = []
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
  }
  try {
    await writeFile(source, '{"ok":true}\n')
    apply(ctx, { root, autoPrune: false, maxFileMb: 1 })
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'backup')
    const result = await registered[0].execute({ op: 'put', paths: [source] })
    assert.equal(result.changed, 1)
    assert.equal(result.pruned, 0)
    assert.match(result.summary, /snapshot/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(sourceDir, { recursive: true, force: true })
  }
})
