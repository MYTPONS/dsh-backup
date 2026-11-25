# dsh-backup

**DSH 专属工具** · [English](#english)

给不受版本控制、又无法重建的文件提供**一个备份仓库**和**一条保留期规则**，替代散落的 `*.bak`、项目内临时 `backups/` 和 HOME 顶层备份目录。

这不是通用云备份，也不是版本控制。它是 DSH 的能力：让 Agent 在改动系统配置、profile、无 VCS 的核心文件之前，知道应该把快照放在哪里、留多久、怎么查、怎么清。

## 为什么需要它

普通 Agent 常把备份做成三件事：

- 在源文件旁边生成 `file.bak`、`file.bak2`；
- 在项目里随手建 `backups/`；
- 把旧副本移进回收站，然后永远不清理。

结果是没有统一来源、没有保留期，也没有可信的恢复入口。

`dsh-backup` 把规则收敛为：

```text
~/.local/share/backups/<YYYY-MM>/<原绝对路径>@<YYYYMMDD-HHMMSS>
```

- 按原路径重建目录，恢复时知道文件从哪里来；
- 按月份分区，过期清理可以按整月处理；
- 时间戳后缀，同名多次快照不覆盖；
- 每次工具调用自动执行一次过期清理。

## 安装

需要 DSH（DeepSeek Harness）和 Node.js 20+。

```bash
git clone https://github.com/MYTPONS/dsh-backup.git
```

从本地目录作为 DSH bundle 安装：

1. 打开 DSH 的 **Plugins** 页面；
2. 选择 **Add plugin**，指向本仓库目录；
3. 启用 `backup` 行；
4. 新开一个会话，确认工具列表出现 `backup`。

也可以在已安装 `dsh` CLI 的 profile 中安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-backup
```

安装后重启或重新加载对应 profile。工具名是 `backup`。

## 工具操作

| `op` | 作用 |
|---|---|
| `put` | 快照指定普通文件；内容未变时跳过 |
| `adopt` | 把旧备份目录或文件移入统一仓库，保留原路径和文件年龄 |
| `list` | 列出快照，可按 `olderThanDays` 过滤 |
| `prune` | 删除超过保留期的快照 |
| `trash-empty` | 清理超过保留期的回收站条目 |
| `stats` | 按月统计快照数量和体积 |

示例：

```json
{
  "op": "put",
  "paths": ["/etc/example/config.yml", "/home/user/.config/example/profile.json"]
}
```

恢复时直接按 `list` 输出中的快照路径取回文件。`put` 只接受普通文件；目录请用 `adopt` 或逐个文件快照。

## 配置

`cordis.patch.yml` 中的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `~/.local/share/backups` | 统一备份仓库根目录 |
| `keepDays` | `30` | 快照保留天数，至少 1 |
| `trashKeepDays` | `30` | 回收站清理天数，至少 1 |
| `maxFileMb` | `50` | 单文件大小上限；超过时用 `force: true` |
| `autoPrune` | `true` | 每次调用前自动清理过期快照 |

## 设计边界

- **不是 VCS**：代码和可编辑文档应优先 commit；`put` 只兜底既不在 VCS 又无法重建的文件。
- **不是云备份**：不负责异地复制、加密托管或灾难恢复。
- **不是回收站替代**：`trash-empty` 只处理 DSH/用户明确交给它的回收站保留期。
- **过期项可真删**：保留期就是契约；用户数据保护不应变成永久堆积。
- **不跟随目录**：`put` 只快照普通文件，避免无边界递归。
- **adopt 是搬家**：`adopt` 会移动原文件；先看 `dryRun` 输出，再执行真实搬移。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` 执行语法检查和完整单元测试。测试只使用临时目录，不触碰真实 HOME、备份仓库或回收站。

## License

MIT。见 [LICENSE](LICENSE)。

---

## English

**DSH-exclusive tool.**

`dsh-backup` gives DSH one self-pruning snapshot store for files that are neither version-controlled nor reproducible. It is not a general backup product and not a replacement for Git.

Quick start:

```bash
git clone https://github.com/MYTPONS/dsh-backup.git
# Install the repository directory from DSH Plugins > Add plugin,
# or: dsh plugin --profile web add /absolute/path/to/dsh-backup
```

Run `pnpm verify` for syntax checks and unit tests.
