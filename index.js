import { adopt, expandHome, formatBytes, list, prune, put, stats, trashEmpty } from './lib/store.js'

export const name = 'backup'

export const inject = ['tools']

const OPS = ['put', 'list', 'prune', 'adopt', 'trash-empty', 'stats']

const DESCRIPTION = [
	'Keep one snapshot store for files that are neither under version control nor reproducible, and delete what has expired.',
	'Git-tracked files and build output need no snapshot: commit or regenerate them instead.',
	"put snapshots the given paths and skips unchanged content; adopt moves an existing backup directory or file into the store, keeping each file's original path and age; list shows snapshots, optionally only those older than olderThanDays; prune deletes snapshots past the retention; trash-empty deletes trash entries past their own retention; stats reports count and size per month.",
	'Every op prunes expired snapshots first unless autoPrune is off.',
].join(' ')

const DEFAULTS = {
	root: '~/.local/share/backups',
	keepDays: 30,
	trashKeepDays: 30,
	maxFileMb: 50,
	autoPrune: true,
}

const MAX_ENTRIES = 20

function clipped(entries, render) {
	const shown = entries.slice(0, MAX_ENTRIES).map(render)
	if (entries.length > MAX_ENTRIES) shown.push(`... ${entries.length - MAX_ENTRIES} more`)
	return shown
}

function resolveSettings(config) {
	const raw = config !== null && typeof config === 'object' ? config : {}
	const natural = (value, fallback, min) => (Number.isInteger(value) && value >= min ? value : fallback)
	return {
		root: typeof raw.root === 'string' && raw.root.length > 0 ? raw.root : DEFAULTS.root,
		keepDays: natural(raw.keepDays, DEFAULTS.keepDays, 1),
		trashKeepDays: natural(raw.trashKeepDays, DEFAULTS.trashKeepDays, 1),
		maxFileMb: natural(raw.maxFileMb, DEFAULTS.maxFileMb, 1),
		autoPrune: raw.autoPrune !== false,
	}
}

function summarizePut(results) {
	const saved = results.filter((result) => result.snapshot)
	const skipped = results.filter((result) => result.skipped)
	const lines = saved.map((result) => `snapshot ${result.snapshot} (${formatBytes(result.size)})`)
	lines.push(...clipped(skipped, (result) => `skipped ${result.source}: ${result.skipped}`))
	return { saved, text: lines.length === 0 ? 'nothing to snapshot' : lines.join('\n') }
}

function requirePaths(args) {
	if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('backup op=put needs paths: one absolute path per file')
	return args.paths.map((path) => expandHome(path))
}

function keepDaysFor(settings, args, field) {
	const value = Number.isInteger(args.keepDays) ? args.keepDays : settings[field]
	if (!Number.isInteger(value) || value < 1) throw new Error('backup: keepDays must be an integer of at least 1')
	return value
}

export function apply(ctx, config) {
	const settings = resolveSettings(config)

	async function autoPrune() {
		if (!settings.autoPrune) return 0
		return (await prune({ root: settings.root, keepDays: settings.keepDays })).length
	}

	ctx.tools.register({
		name: 'backup',
		description: DESCRIPTION,
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['op'],
			properties: {
				op: {
					type: 'string',
					enum: OPS,
					description: 'put | list | prune | adopt | trash-empty | stats',
				},
				paths: {
					type: 'array',
					items: { type: 'string' },
					description: 'put only: absolute files to snapshot. A directory needs adopt instead.',
				},
				dir: {
					type: 'string',
					description: 'adopt only: the existing backup directory or file to move into the store.',
				},
				olderThanDays: {
					type: 'integer',
					minimum: 1,
					description: 'list only: keep only snapshots at least this many days old.',
				},
				keepDays: {
					type: 'integer',
					minimum: 1,
					description: 'prune and trash-empty only: override the configured retention for this call.',
				},
				force: {
					type: 'boolean',
					description: 'put only: snapshot files above the size cap.',
				},
				dryRun: {
					type: 'boolean',
					description: 'prune, trash-empty and adopt: report what would move or disappear without doing it.',
				},
			},
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				required: ['summary', 'changed', 'pruned'],
				properties: {
					summary: { type: 'string' },
					changed: { type: 'integer' },
					pruned: { type: 'integer' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.summary }],
		},
		execute: async (args) => {
			const op = args.op
			const dryRun = args.dryRun === true
			const pruned = op === 'prune' && dryRun ? 0 : await autoPrune()

			if (op === 'put') {
				const results = await put({
					root: settings.root,
					paths: requirePaths(args),
					force: args.force === true,
					maxFileMb: settings.maxFileMb,
				})
				const { saved, text } = summarizePut(results)
				return { summary: text, changed: saved.length, pruned }
			}

			if (op === 'adopt') {
				if (typeof args.dir !== 'string' || args.dir.length === 0) throw new Error('backup op=adopt needs dir: the backup directory to move in')
				const moved = await adopt({ root: settings.root, dir: args.dir, dryRun })
				const lines = moved.length === 0
					? ['nothing to move']
					: [
						`${dryRun ? 'would move' : 'moved'} ${moved.length} file${moved.length === 1 ? '' : 's'} into the store`,
						...clipped(moved, (entry) => `${entry.from} -> ${entry.to}`),
					]
				return { summary: lines.join('\n'), changed: moved.length, pruned }
			}

			if (op === 'list') {
				const entries = await list({ root: settings.root, olderThanDays: args.olderThanDays })
				const lines = entries.length === 0
					? ['no snapshots']
					: [
						`${formatBytes(entries.reduce((sum, entry) => sum + entry.size, 0))} in ${entries.length} snapshot${entries.length === 1 ? '' : 's'}`,
						...clipped(entries, (entry) => `${entry.at.slice(0, 16).replace('T', ' ')}  ${formatBytes(entry.size).padStart(9)}  ${entry.snapshot}`),
					]
				return { summary: lines.join('\n'), changed: 0, pruned }
			}

			if (op === 'prune') {
				const keepDays = keepDaysFor(settings, args, 'keepDays')
				const removed = await prune({ root: settings.root, keepDays, dryRun })
				const lines = removed.length === 0
					? [`no snapshots older than ${keepDays} days`]
					: [`${dryRun ? 'would delete' : 'deleted'} ${removed.length} snapshot${removed.length === 1 ? '' : 's'} older than ${keepDays} days`, ...clipped(removed, (path) => path)]
				return { summary: lines.join('\n'), changed: removed.length, pruned: dryRun ? 0 : removed.length }
			}

			if (op === 'trash-empty') {
				const keepDays = keepDaysFor(settings, args, 'trashKeepDays')
				const removed = await trashEmpty({ keepDays, dryRun })
				const lines = removed.length === 0
					? [`no trash entries older than ${keepDays} days`]
					: [`${dryRun ? 'would delete' : 'deleted'} ${removed.length} trash entr${removed.length === 1 ? 'y' : 'ies'} older than ${keepDays} days`, ...clipped(removed, (entry) => entry)]
				return { summary: lines.join('\n'), changed: removed.length, pruned }
			}

			if (op === 'stats') {
				const result = await stats({ root: settings.root })
				const lines = result.total === 0
					? [`no snapshots under ${expandHome(settings.root)}`]
					: [
						`${result.total} snapshot${result.total === 1 ? '' : 's'}, ${formatBytes(result.bytes)}`,
						...result.months.map((month) => `${month.month}  ${String(month.count).padStart(4)}  ${formatBytes(month.bytes)}`),
					]
				return { summary: lines.join('\n'), changed: 0, pruned }
			}

			throw new Error(`backup: unknown op ${JSON.stringify(op)}; expected one of ${OPS.join(', ')}`)
		},
	})
}
