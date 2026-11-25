# Changelog

## 1.0.0 - 2026-11-26

- Published as a DSH-exclusive plugin.
- Added public packaging metadata, bilingual README, license, and a no-network test suite.
- Hardened `adopt` against moving the backup root into itself.
- Added an injectable trash root for isolated tests.
- Made `maxFileMb` default safe when the store API is used directly.
- Removed the empty source directory after adopting a backup tree.
