import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_ROOT = '~/.local/share/backups'
export const TRASH_ROOT = '~/.local/share/Trash'

const INDEX_FILE = 'index.json'
const DAY = 86_400_000

export function expandHome(value) {
	if (typeof value !== 'string' || value.trim().length === 0) throw new Error('backup: expected a non-empty path')
	const path = value.trim()
	if (path === '~') return homedir()
	if (path.startsWith('~/')) return join(homedir(), path.slice(2))
	return isAbsolute(path) ? path : resolve(process.cwd(), path)
}

function pad(value) {
	return String(value).padStart(2, '0')
}

export function monthKey(date) {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

export function stamp(date) {
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function isInside(parent, child) {
	const rel = relative(parent, child)
	return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

function snapshotTarget(root, source, date, ordinal = 0) {
	const rel = source.replace(/^[/\\]+/, '')
	const suffix = ordinal === 0 ? '' : `-${ordinal}`
	return join(root, monthKey(date), `${rel}@${stamp(date)}${suffix}`)
}

function hashOf(buffer) {
	return createHash('sha256').update(buffer).digest('hex')
}

async function walkFiles(dir, out = []) {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) await walkFiles(path, out)
		else if (entry.isFile() && entry.name !== INDEX_FILE && !entry.name.startsWith(`.${INDEX_FILE}`)) out.push(path)
	}
	return out
}

async function removeEmptyDirs(dir, keepRoot = false) {
	let entries
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		return
	}
	for (const entry of entries) if (entry.isDirectory()) await removeEmptyDirs(join(dir, entry.name))
	if (keepRoot) return
	try {
		await rmdir(dir)
	} catch {}
}

async function readIndex(root) {
	try {
		const parsed = JSON.parse(await readFile(join(root, INDEX_FILE), 'utf8'))
		if (parsed && typeof parsed === 'object' && parsed.files) return parsed
	} catch {}
	return { version: 1, files: {} }
}

async function writeIndex(root, index) {
	const target = join(root, INDEX_FILE)
	const temp = join(root, `.${INDEX_FILE}.${process.pid}.tmp`)
	await mkdir(root, { recursive: true })
	await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`)
	await rename(temp, target)
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export { formatBytes }

export async function put(options) {
	const root = expandHome(options.root)
	const maxFileMb = Number.isFinite(options.maxFileMb) ? options.maxFileMb : 50
	const maxBytes = maxFileMb * 1024 * 1024
	const now = new Date()
	await mkdir(root, { recursive: true })
	const index = await readIndex(root)
	const results = []
	for (const raw of options.paths) {
		const source = expandHome(raw)
		if (source === root || isInside(root, source)) {
			results.push({ source, skipped: 'already inside the backup root' })
			continue
		}
		const info = await stat(source).catch(() => null)
		if (info === null) {
			results.push({ source, skipped: 'not found' })
			continue
		}
		if (!info.isFile()) {
			results.push({ source, skipped: 'not a regular file' })
			continue
		}
		if (!options.force && info.size > maxBytes) {
			results.push({ source, skipped: `larger than ${maxFileMb} MB` })
			continue
		}
		const hash = hashOf(await readFile(source))
		const known = index.files[source]
		if (known && known.hash === hash && known.snapshot && existsSync(known.snapshot)) {
			results.push({ source, skipped: 'unchanged' })
			continue
		}
		let target = snapshotTarget(root, source, now)
		for (let ordinal = 1; existsSync(target); ordinal++) target = snapshotTarget(root, source, now, ordinal)
		await mkdir(dirname(target), { recursive: true })
		await copyFile(source, target)
		index.files[source] = { hash, size: info.size, at: now.toISOString(), snapshot: target }
		results.push({ source, snapshot: target, size: info.size })
	}
	await writeIndex(root, index)
	return results
}

export async function prune(options) {
	const root = expandHome(options.root)
	if (!existsSync(root)) return []
	const cutoff = Date.now() - options.keepDays * DAY
	const removed = []
	for (const file of await walkFiles(root)) {
		const info = await stat(file).catch(() => null)
		if (info === null || info.mtimeMs >= cutoff) continue
		removed.push(file)
		if (options.dryRun) continue
		await unlink(file).catch(() => {})
	}
	if (options.dryRun) return removed
	await removeEmptyDirs(root, true)
	const index = await readIndex(root)
	for (const [source, record] of Object.entries(index.files)) if (!record.snapshot || !existsSync(record.snapshot)) delete index.files[source]
	await writeIndex(root, index)
	return removed
}

export async function list(options) {
	const root = expandHome(options.root)
	const cutoff = typeof options.olderThanDays === 'number' ? Date.now() - options.olderThanDays * DAY : null
	const entries = []
	for (const file of await walkFiles(root)) {
		const info = await stat(file).catch(() => null)
		if (info === null) continue
		if (cutoff !== null && info.mtimeMs >= cutoff) continue
		entries.push({ snapshot: file, size: info.size, at: info.mtime.toISOString() })
	}
	entries.sort((left, right) => left.at.localeCompare(right.at))
	return entries
}

export async function adopt(options) {
	const root = expandHome(options.root)
	const source = expandHome(options.dir)
	if (source === root || isInside(root, source)) throw new Error('backup: cannot adopt the backup root into itself')
	const info = await stat(source).catch(() => null)
	if (info === null) throw new Error(`backup: ${source} does not exist`)
	const files = info.isDirectory() ? await walkFiles(source) : [source]
	await mkdir(root, { recursive: true })
	const moved = []
	for (const file of files) {
		const fileInfo = await stat(file).catch(() => null)
		if (fileInfo === null) continue
		let target = snapshotTarget(root, file, new Date(fileInfo.mtimeMs))
		for (let ordinal = 1; existsSync(target); ordinal++) target = snapshotTarget(root, file, new Date(fileInfo.mtimeMs), ordinal)
		if (options.dryRun) {
			moved.push({ from: file, to: target, size: fileInfo.size })
			continue
		}
		await mkdir(dirname(target), { recursive: true })
		try {
			await rename(file, target)
		} catch {
			await copyFile(file, target)
			await unlink(file)
		}
		moved.push({ from: file, to: target, size: fileInfo.size })
	}
	if (!options.dryRun && info.isDirectory()) await removeEmptyDirs(source, false)
	return moved
}

export async function trashEmpty(options) {
	const cutoff = Date.now() - options.keepDays * DAY
	const trashRoot = typeof options.trashRoot === 'string' && options.trashRoot ? options.trashRoot : TRASH_ROOT
	const filesDir = join(expandHome(trashRoot), 'files')
	const infoDir = join(expandHome(trashRoot), 'info')
	const removed = []
	let names = []
	try {
		names = await readdir(filesDir)
	} catch {
		return removed
	}
	for (const name of names) {
		const path = join(filesDir, name)
		const infoPath = join(infoDir, `${name}.trashinfo`)
		const info = await lstat(path).catch(() => null)
		if (info === null) continue
		const meta = await lstat(infoPath).catch(() => null)
		const when = Math.max(info.mtimeMs, meta === null ? 0 : meta.mtimeMs)
		if (when >= cutoff) continue
		removed.push(name)
		if (options.dryRun) continue
		await rm(path, { recursive: true, force: true }).catch(() => {})
		await unlink(infoPath).catch(() => {})
	}
	return removed
}

export async function stats(options) {
	const root = expandHome(options.root)
	const months = new Map()
	let total = 0
	let bytes = 0
	for (const file of await walkFiles(root)) {
		const info = await stat(file).catch(() => null)
		if (info === null) continue
		const month = relative(root, file).split(sep)[0]
		const entry = months.get(month) ?? { count: 0, bytes: 0 }
		entry.count += 1
		entry.bytes += info.size
		months.set(month, entry)
		total += 1
		bytes += info.size
	}
	return {
		total,
		bytes,
		months: [...months.entries()]
			.map(([month, value]) => ({ month, ...value }))
			.sort((left, right) => left.month.localeCompare(right.month)),
	}
}
