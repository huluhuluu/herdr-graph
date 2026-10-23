# Session Graph

[English](README.md) · [简体中文](README.zh-CN.md)

在 [Herdr](https://herdr.dev) 中浏览和改名本地 Codex、Claude Code 与 DST 会话。

![Session Graph：会话关系图、分叉轮次、来源时间与所选分支](docs/assets/session-graph.png)

*使用演示数据渲染当前界面，不含私人会话内容。*

- 按目录或时间浏览历史，筛选 Codex、Claude Code 和 DST 会话，包含 Codex 归档记录。
- 查看完整会话族、分叉轮次和详细提问树。
- 搜索完整问答，高亮命中内容，并在阅读栏中滚动查看。
- 实时查看会话公开进展，过滤工具和思考内容，并可切回完整输出。
- 原生会话改名；在打开插件的 agent 窗格中恢复或分叉。

浏览过程只读；改名和分叉使用 agent 原生存储。不同 agent 的能力差异见[当前限制](#当前限制)。

## 常用操作速查

安装后，从 agent 窗格按 **Ctrl+B**，松开后按 **g**（默认绑定）。代码更新后请关闭旧图弹窗再打开。

| 目的 | 按键 |
| --- | --- |
| 当前会话／全部历史 | `c`／`s` |
| 完整输出 ↔ 实时进展 | `m` |
| 恢复跟随最新进展 | `Tab` 聚焦正文，再按 `G` |
| 向前／向后阅读进展 | `PgUp`／`PgDn`，窗口边缘自动加载相邻页 |
| 会话族／详细轮次树 | `f`／`d` |
| 返回／关闭 | `Backspace` 或 `Esc`／`q` |

**[完整使用手册](docs/USAGE.zh-CN.md)** 说明焦点、全部按键、进展状态、历史分页、原生 agent 差异和排查方法。[English guide](docs/USAGE.md) 提供对应英文说明。

## 环境要求

- [Herdr](https://herdr.dev/docs/install/) **0.9.0+**、**Node.js 18+**，均需位于 Herdr 进程的 `PATH` 中。
- Git，用于克隆和更新项目。
- 本地 Codex、Claude Code 或 DST 会话文件。DST 压缩历史需要内置 Zstandard 支持：**Node.js 22.15+（22.x）或 24+**（[Node.js 文档](https://nodejs.org/download/release/v22.22.0/docs/api/zlib.html#zlibzstddecompresssyncbuffer-options)）。
- 恢复或分叉需要安装相应 agent CLI；Codex、DST 原生改名也需要已安装的 CLI。Claude 改名使用本地标题文件。
- 交互式终端，建议 **100 列以上**。普通对话双栏需要 72 列，Family／进展双栏需要 96 列；窄窗口 Family／进展提供全宽阅读。

| 平台 | 状态 |
| --- | --- |
| Windows | 已验证运行 |
| Linux | 已在 Ubuntu 22.04 原生验证 |
| macOS | manifest 已声明，已检查源码，尚未验证实际运行 |

| Agent | 会话记录位置 |
| --- | --- |
| Codex | `$CODEX_HOME/sessions` 与 `$CODEX_HOME/archived_sessions`；默认根目录为 `~/.codex` |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects`；默认根目录为 `~/.claude` |
| DST / DeepSeek Harness | `$DSH_HOME/sessions`；默认根目录为 `~/.dsh` |

Windows 下的 `~` 指 `%USERPROFILE%`。会话文件必须在运行插件的机器上可访问。

安装器将自定义的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和 `DSH_HOME` 保存到本插件的 `session-roots.json`，因此 Herdr 启动时未继承这些变量也能检索历史。插件进程的环境变量优先。需要更换已保存路径时，设置变量后重新执行 `install`。其他 agent 需要实现适配器，目前没有通用会话解析器。

打开弹窗时会固定这些已解析的目录，避免窗格启动时 shell profile 改写变量、将扫描导向其他目录。

## 安装

先启动 Herdr，再克隆仓库并运行安装脚本。

### Linux / macOS

```sh
git clone https://github.com/huluhuluu/herdr-graph.git
cd herdr-graph
sh ./install.sh install
```

### Windows（PowerShell）

```powershell
git clone https://github.com/huluhuluu/herdr-graph.git
cd herdr-graph
powershell -ExecutionPolicy Bypass -File .\install.ps1 install
```

安装器通过 `herdr plugin link` 注册当前仓库，并添加快捷键托管块。请保留仓库目录。无需 `npm install`、构建、管理员权限，也不会修改 Herdr 源码。

已有托管快捷键会被保留。修改配置前校验 UTF-8 TOML 并备份，重载失败时恢复原配置；若期间有其他进程修改，则保留这些修改并报错。安装命令加上 `--no-keys` 可跳过配置修改，之后使用下方 CLI 命令打开界面。

模板使用 `prefix+g` 打开界面，`prefix+shift+g` 配置快捷键。如果这些键已被使用，请先调整 [config.example.toml](config.example.toml)；较新的 Herdr 版本也将它们用于内置操作。

## 更新、清理与卸载

在仓库目录中使用同一个安装脚本维护项目：

```sh
sh ./install.sh --help
sh ./install.sh update
sh ./install.sh clean
sh ./install.sh uninstall
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 --help
powershell -ExecutionPolicy Bypass -File .\install.ps1 update
powershell -ExecutionPolicy Bypass -File .\install.ps1 clean
powershell -ExecutionPolicy Bypass -File .\install.ps1 uninstall
```

| 命令 | 行为 |
| --- | --- |
| `install`（默认） | 注册并启用当前仓库；没有托管块时添加快捷键 |
| `install --no-keys` | 注册并启用当前仓库，不修改 Herdr 配置 |
| `update` | 执行 `git pull --ff-only`，刷新注册、清理解析缓存；保留快捷键和启用状态 |
| `clean` | 仅删除本插件的解析缓存与缓存临时文件 |
| `uninstall` | 移除本插件的快捷键托管块、取消注册并清理解析缓存；保留仓库 |
| `setup-keys` | 显式使用 `config.example.toml` 替换托管快捷键 |
| `remove-keys` | 仅移除快捷键托管块 |
| `--help` | 查看命令和选项 |

更新、清理前请关闭图窗格。更新要求 Git 工作区干净、当前分支设有上游；存在本地修改或分支分歧时会报错并保留这些改动。更新后重新打开图。安装、更新和卸载需要 Herdr 服务正在运行。

清理不会删除 agent 会话、其他插件、仓库文件或配置备份。`HERDR_PLUGIN_STATE_DIR` 可覆盖缓存目录；默认使用 Herdr 在 `XDG_STATE_HOME` / `~/.local/state` 或 Windows `%LOCALAPPDATA%` 下的状态目录。清理也涵盖旧版直接运行 CLI 时的缓存位置。

## 使用

1. 在 Herdr 中聚焦 agent 窗格，或直接打开插件浏览已保存的历史。
2. 按 `prefix+g`。使用 Herdr 默认前缀时，先按 **Ctrl+B**，松开后按 **G**，不按 Shift。
3. 按 `s` 查看按目录分组的历史，按 `Enter` 展开目录，再选择会话阅读。`a` 筛选 agent，`v` 切换时间列表，`o` 反转排序，`/` 搜索。当前会话 ID 缺失时会自动显示历史。
4. 用 `j/k` 移动，按 `Tab` 聚焦并滚动正文。在任意浏览页按 `c`，直接阅读原调用窗格当前会话的最新已保存轮次。在普通对话轮次上按 `Enter` 聚焦正在运行的会话。`n` 恢复、`F` 分叉，具体 agent 差异见下文。
5. 按 `R` 改名，使用 **Ctrl+U** 清空原名称，输入后按 `Enter` 保存；`Esc` 取消。
6. 按 `f` 打开 **Family**，再用 `d` 切换会话结构和详细轮次树。分支标注来源 `[turn N]`，选中轮次后阅读完整问答。`T` 切换时间，`h/l` 折叠分支。
7. 按 `Backspace` 或 `Esc` 返回上一页，保留该页的选中项、筛选、折叠和滚动位置。首页按 `Esc` 关闭，浏览时在任意页面按 `q` 关闭。搜索或改名时，`Esc` 取消编辑。

在已保存会话或对话轮次上按 `m` 查看实时进展。完整输出仍为默认方式，详见[实时会话进展](#实时会话进展)。

也可以在 agent 窗格的 shell 中执行：

```sh
herdr plugin action invoke open --plugin huluhlu.session-graph
```

| 按键 | 操作 |
| --- | --- |
| `j` / `k`、`↓` / `↑` | 切换节点；内容栏聚焦时滚动正文 |
| `g` / `G`、`Home` / `End` | 第一个 / 最后一个节点；正文聚焦时跳到顶部 / 底部 |
| `h` / `l`、`←` / `→` | 折叠 / 展开目录或分支；展开有分叉标记的节点会打开完整分支 |
| `Tab` / `Shift+Tab` | 切换树与详情焦点并保留位置；窄窗口 Family／进展使用全宽阅读 |
| `PgUp` / `PgDn` | 对聚焦的树翻页；正文滚动 10 行；进展边缘加载相邻历史 |
| `Enter` | 目录：展开／折叠；会话：打开；Family 轮次：聚焦正文；普通轮次：跳转；聚焦的进展正文：返回完整 |
| `s` | 显示所有已保存的会话 |
| `c` | 打开 / 刷新原调用窗格的当前对话，选中最新已保存轮次；不受搜索和历史筛选影响 |
| `m` | 切换完整输出 / 实时进展；分别保留阅读位置 |
| `p` | 进展视图：全部公开助手文字 / 仅明确分类的进展 |
| `r` | 刷新所选会话阅读内容；完整输出刷新时保留所选轮次 |
| `f` | 打开共同祖先下的完整会话族；重复按下仍停留在该页 |
| `d` | 切换 Family 结构图 / 详细对话树；在其他页面使用会先打开 Family |
| `b` | `f` 的兼容别名 |
| `T`（`Shift+T`） | 收起 / 展开关系图时间；保留轮次与连线 |
| `a` | 循环筛选 agent：All → Codex → Claude → DST → All |
| `v` | 切换目录分组 / 时间列表 |
| `o` | 切换最新 / 最早优先 |
| `R` | 改名所选会话；`Ctrl+U` 清空输入 |
| `n` | 在当前 Codex / Claude 窗格恢复；打开 DST 原生历史选择器 |
| `F`（`Shift+F`） | 分叉完整的已保存 Codex 会话并切换；分支当前 Claude 会话；DST 不支持 |
| `t` | 切换范围：session → lineage → 所有历史会话 |
| `/` | 图中搜索元数据或完整问答；聚焦的进展正文搜索已加载窗口；空输入清除搜索 |
| `K` / `?` | 快捷键配置说明 / 帮助；帮助中用 `j/k` 或 `PgUp/PgDn` 滚动 |
| `Backspace` | 返回上一页；编辑时删除一个字符 |
| `Esc` | 取消搜索 / 改名或关闭帮助；浏览时返回上一页，首页则关闭 |
| `q` | 在任意浏览页面关闭 |
| `Ctrl+C` | 在任何模式下关闭，包括搜索、改名和加载中 |

### 搜索与阅读

搜索后自动选中第一个实际命中项，用黄色高亮关键词，并将正文定位到命中处。Family 保留祖先行作为上下文。按 `Tab` 聚焦 **Content**，再用 `↑/↓` 或 `j/k` 滚动、`PgUp/PgDn` 翻页、`Home/End` 跳到顶部或底部。切换焦点保留阅读位置；`Ctrl+U` 清空搜索或改名输入。

历史默认展开当前窗格的目录。`v` 切换为平铺时间列表，`o` 反转按会话文件修改时间排序的顺序。agent 筛选可与搜索、排序组合使用。日期采用 UTC。

会话总数按各 agent 的原生 ID 去重，包含 Codex 归档记录。扫描批次会合并已打开页面发现的会话。无法读取的会话保留为带错误信息的条目，不会中断其他文件的扫描；Codex 名称索引不可用时，会退回读取会话元数据。

`[current]` 标记打开插件的 agent 窗格的当前会话，浏览其他会话时也不会改变。标记直接显示在图中节点上，不放在顶部或底部：在对话和历史行中，它以绿色显示在紫色 branch/forks 徽标旁，选中行也保留各自颜色。实心圆点标记其对话轮次。按 `c` 阅读或刷新该会话的已保存记录，按 `Backspace` 返回上一页。优先使用 Herdr 的 `agent_session.value`；缺失时，每批扫描结果到达后，立即按 agent、目录、完整终端会话标题进行唯一精确匹配，扫描期间即可显示标记；后续发现同名歧义时撤销标记。仍无法识别或有歧义时，`c` 会说明原因并保留当前页面。

### 实时会话进展

在历史、Family 或对话树中选中会话，按 `m` 打开进展阅读。公开助手消息按简短的用户问题分组，保留时间和来源明确提供的进展／答复类型；工具调用、工具结果、思考块和注入上下文被过滤。类型未知的文字显示为 **Assistant**，`p` 仅筛选能够明确分类的进展。在聚焦的进展正文中按 `Enter` 返回完整输出。

现有后台 Worker 约每 2 秒检查所选会话，只读取追加的 JSONL 记录或 DST 完整压缩帧。agent 将文字写入磁盘后才能显示，尚未保存的流式文字无法读取。完整输出保留现有格式，从发生更新的进展视图切回时会补齐最新内容；更新中或失败时有明确标注。

停在底部时自动跟随新消息；向上滚动或搜索后暂停跟随，并显示新消息数量，按 `G` 回到最新。`c` 使用相同阅读方式打开原调用窗格的当前会话；原窗格切换原生会话不会暗中替换正在阅读的对象。`r` 重新校验所选日志。切换阅读方式或返回保存页面会保留阅读位置。

可见窗口最多保留 400 条消息；在边缘继续上翻／下翻加载相邻历史，`g` 请求最早消息，`G` 加载最新消息。旧书签按具体消息恢复对应窗口。正文中的 `/` 只搜索已加载窗口。少于 96 列时 `Tab` 切换树和全宽正文。文件变化、无法读取或记录超限会明确提示，并保留最后成功的内容；限制与状态含义见[使用手册](docs/USAGE.zh-CN.md#实时进展)。

### 会话族与分支

`f` 显示共同祖先及其全部后代，包括同级分支。结构图每个会话占一行，右侧列出分支新增轮次，并概括继承历史；`d` 显示详细对话树，共有历史只展示一次，切换视图时保留所选会话。在会话标题上按 `Enter` 阅读完整历史，在详细轮次上按 `Enter` 聚焦正文。窄窗口 Family 用 `Tab` 打开全宽阅读，再按一次返回树。

![使用演示问答渲染的 Family 详细对话树](docs/assets/session-family-detail.png)

连线依据原生父会话 ID。`[turn N]` 按直属父会话的完整对话编号，时间取自该来源轮次，不代表分叉创建时间或文件修改时间。父会话缺失时仍显示对应节点；`[loading…]`、`[turn ?]` 和读取错误分别表示加载中、位置未知和解析失败。`T` 的时间显隐设置跨页面保留，`Backspace` / `Esc` 返回上一页。

启动时先加载当前对话，再逐步显示当前目录和其他历史；Family 先显示结构，后台解析后补充分叉详情。加载中仍可切页和关闭。

### 恢复与分叉

使用 `n` / `F` 前，从空闲且输入框为空的 agent 窗格打开插件；所选会话必须属于同类型 agent，切换使用这个已有窗格。已上报在其他窗格运行的会话会拒绝重复恢复；可打开其普通对话页，在轮次上按 `Enter` 聚焦它。

Codex 分叉通过原生 App Server `thread/fork` 复制完整的已保存对话，再向当前 Codex 进程发送 `/resume <new ID>`；选中较早轮次只改变预览。Claude 的 `n` 使用 `/resume <ID>`，`F` 使用 `/branch`，要求所选会话就是 Herdr 上报的当前会话。DST 的 `n` 打开 `/resume`，需在原生选择器中选择会话，暂不支持按 ID 直接切换或通过插件分叉。

### 原生改名

| Agent | 名称保存方式 |
| --- | --- |
| Codex | 官方 App Server `thread/name/set`，显示在原生会话历史中 |
| Claude Code | 原生 `custom-title` 记录与 `custom-title.json` 标题文件 |
| DST | 通过已安装的持久化组件写入原生 `session/title` 事件 |

改名不会触发模型对话或替换聊天消息。运行中的客户端可能需要重新打开或恢复会话才能刷新显示名称。DST 会拒绝修改正在被写入进程占用的会话，请先关闭对应 agent 再改名。旧版 DST 文件可浏览，改名需要按会话分目录的 generation 存储结构。

![使用演示数据渲染的目录分组与所选分支的固定关系预览](docs/assets/session-history.png)

## 配置快捷键

修改 Herdr 配置中 `# session-graph begin` … `# session-graph end` 之间的托管块：

| 平台 | 默认配置路径 |
| --- | --- |
| Linux / macOS | `~/.config/herdr/config.toml` |
| Windows | `%APPDATA%\herdr\config.toml` |

`HERDR_CONFIG_PATH` 可覆盖配置文件，`XDG_CONFIG_HOME` 可覆盖默认配置目录。修改后执行：

```sh
herdr server reload-config
```

建议直接修改已安装的托管块，保持 Git 工作区干净以便更新。如需用 `config.example.toml` 替换托管块，执行：

```sh
node src/install.js setup-keys
```

`node src/install.js remove-keys` 仅移除托管快捷键。两个操作也可以通过安装脚本执行。`K` 仅显示说明，不会修改快捷键。

## 当前限制

- **分支记录：** 跨会话关系仅来自原生父会话或分叉元数据，不按话题相似度推断。缺失的分叉位置会标注，缺失的父会话正文无法重建。all 仍是会话目录，`f` 打开会话族的关系页。
- **分叉：** Codex 复制已保存的会话历史，不会从所选轮次精确分叉。插件提交切换命令，原生恢复错误会显示在 agent 窗格。Claude 分支需要 CLI 支持 `/branch`，并且当前会话 ID 已知。
- **Codex 分叉耗时：** 冷启动初始化与元数据操作各有 60 秒上限；原生 CLI 缓慢或宿主负载过高仍可能超时。分叉只提交一次，超时后再次操作前请先检查原生历史。
- **刷新与布局：** 进展跟随所选已保存日志，无法读取 agent 尚未保存的文字。完整输出通过 `c`／`r` 或从已更新进展切回时刷新。少于 72 列时隐藏普通完整输出正文，Family 和进展提供全宽阅读。进展冷启动会先流式扫描一次所选文件，再发布初始窗口。

没有历史时，先检查上方 agent 存储路径；使用自定义根目录时，从已设置相应变量的 shell 重新运行安装器。无法直接打开当前会话或跳转到运行窗格时，检查 `herdr pane list` 和 [Herdr 集成](https://herdr.dev/docs/integrations/)，这两项操作依赖 `agent_session.value`。

## 开发

```sh
npm test
npm run bench
```

测试涵盖历史、分支树、搜索、窗格切换、原生改名 / 分叉和管理脚本。Codex/DST 原生测试使用临时 agent 根目录，未安装 CLI 时跳过。`bench` 分别读取本地 Codex 和 Claude 最大的三份会话记录，在临时缓存目录中比较冷 / 热加载并报告命中情况，不改动已有会话和插件缓存。

模块结构与待修问题见[开发说明](docs/DEVELOPMENT.md)。修改命令、支持状态、限制或预览图时，请同步更新两份 README。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [完整使用手册](docs/USAGE.zh-CN.md) · [English guide](docs/USAGE.md) | 功能细节、按键索引、常用路径和排查 |
| [开发说明](docs/DEVELOPMENT.md) | 模块、数据契约、后台更新、缓存及验证方式 |
