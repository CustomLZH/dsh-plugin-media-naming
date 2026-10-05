# dsh-plugin-media-naming（媒体库统一命名）

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-184%20checks-brightgreen.svg)](#验证)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue.svg)](package.json)

DSH 插件 · Bundle 行 ID `media-naming` · 包名 `dsh-plugin-media-naming`

## 一句话说明

你说「整理这个路径」，它把**这个目录名**和**目录下的视频文件名**规范成媒体服务器能正确识别的形式——
只处理你指定的那个路径，不碰别的地方。

支持两种数据位置，**按路径自动判断，不用你选**：

| 位置 | 例子 |
| --- | --- |
| **115 网盘** | `影视资源/电视剧/某剧 (2026)` |
| **本机 / NAS 挂载 / Linux** | `G:\Media\电视剧\某剧 (2026)`、`\\NAS\media\电视剧\某剧 (2026)`、`/mnt/media/电视剧/某剧 (2026)` |

## 安装

**前置条件**

| 依赖 | 是否必需 | 说明 |
| --- | --- | --- |
| DSH | 必需 | 插件宿主 |
| Node.js ≥ 18 | 必需 | 插件本体与本地后端都是 JS |
| Python ≥ 3.10 + `p115client` | **仅 115 网盘需要** | 只处理本机 / NAS 文件时**完全不需要 Python** |

**安装步骤**

1. 把仓库放到任意目录：`git clone https://github.com/<你的用户名>/dsh-plugin-media-naming.git`
2. 在 DSH 的插件管理里把它作为 bundle 安装并启用（`plugin_manager` 的 `install_bundle` → `set_bundle` → `set_plugin`）
3. **重启 DSH** 让插件加载（插件代码有模块缓存，之后改动代码同样需要重启）

**装完自检**（不需要网盘、不会碰你的真实文件）

```powershell
npm test                           # 一键跑全部 9 套测试
node test/local-storage-test.mjs   # 只跑本地/NAS 后端（在系统临时目录里跑）
```

## 怎么用（两句话）

```
① 一次性：扫码登录                py -u python/login_115.py    ← 只用 115 时才需要
② "整理 影视资源/电视剧/某剧 (2026)"   →   media_naming_quick   →  审核清单
   "整理 \\NAS\media\电视剧\某剧 (2026)"  →   同上（自动识别为本地/NAS）
③ "可以"                          →   media_naming_apply   →  执行 + 自动复验
```

**②③ 各一次调用，零前置条件**：凭据、Python 解释器、根目录、规则包、计划落盘路径
全部由插件自动处理；调用方只需要说出**那一个节目目录**。

**②里那句话就是"选择"，插件绝不会自己挑目录。** 例如：

> 整理 电视剧/某剧 (2026)

> 整理 电影/某影片 (2025)

> 看看 动漫/某番剧 (2018) 命名有没有问题

## 处理范围：由你指定，插件不预设

- **目录名与层级都随你**：整库、一个节目目录、甚至只有一个视频的目录都可以；
- **路径写法也随你**：带根名（`影视资源/电视剧/某剧 (2026)`）或不带（`电视剧/某剧 (2026)`）都行；
  `rootPrefix` 只是可改的**默认根名**，不是必须的前缀——网盘根目录叫别的名字也能直接用；
- 处理两样东西：**该路径自身的目录名** + **其下的视频文件名**；
- `Season XX` 这类结构目录不动，但其中的文件会一起处理；
- **绝不擅自扩大到你没指定的目录**；你没说清时先问。

## 分工

| 角色 | 负责 |
| --- | --- |
| **插件** | 给规则、给样例、算计划、判对错、执行 |
| **Agent** | 按流程编排，把审核清单交给你，确认后执行，执行后复验 |
| **你** | **指定目录 + 审核点头** |

## 首次准备：扫码登录

```powershell
py -u python/login_115.py                 # 终端显示二维码，115 手机 App 扫码确认
py -u python/login_115.py --png qr.png    # 生成二维码图片（Agent 展示给你扫时用）
py -u python/login_115.py --self-check    # 只检查环境，不联网
```

扫码拿到的是完整账号 cookie，与手工复制的权限相同；成功后自动写入
`$DSH_HOME/media-naming/config.json` 与凭据文件。

## 审核清单长什么样

```
## 审核清单：影视资源/电影/某影片 (2025)
文件：共 1 条 ｜ 变更 0 ｜ 跳过 1 ｜ 冲突 0 ｜ 未知 0 ｜ 超范围 0
目录：1 个（待改 0 个）

### 影视资源/电影/某影片 (2025)（1 条）

| # | 现在 | 改为 | 依据 |
| --- | --- | --- | --- |
| 1 | 某影片 (2025).mkv | 某影片 (2025).mkv | 已符合规范 |

### 结论：✅ 可以进入执行
```

有目录名要改时会多一张表：

```
### 目录名也要改

| 现在 | 改为 | 影响文件 |
| --- | --- | --- |
| 某影片 2025 2160p | 某影片 (2025) | 1 |
```

## 十二个工具

主路径只有两个，其余用于精细控制：

| 工具 | 关键参数 | 用途 | 性质 |
| --- | --- | --- | --- |
| **`media_naming_quick`** | `target`（**唯一必填**） | **首选入口**：扫 + 算 + 落盘 + 审核清单，一次返回 | 只读 |
| **`media_naming_apply`** | `confirm`（路径可省） | 执行计划 / 回滚；执行后**自动复验** | **写** |
| `media_naming_config` | — | 配置位置、取值来源、缺什么 | 只读 |
| `media_naming_flow` | `step` | 作业流程与每步通过条件 | 只读 |
| `media_naming_check` | `step` / `planPath` | 判定某一步是否通过 | 只读 |
| `media_naming_review` | `planPath` / `paths` | 给你看的审核清单 | 只读 |
| `media_naming_rules` | `pack` | 当前规则包全文 | 只读 |
| `media_naming_examples` | `id` / `kind` | 规范样例，照着模仿 | 只读 |
| `media_naming_parse` | `path` | 解析单条路径 | 只读 |
| `media_naming_plan` | `target`（**必填**） | 出这个路径的 dry-run 计划 | 只读 |
| `media_naming_verify` | `candidatePath` | 校验一条路径 | 只读 |
| `media_naming_scan` | `path`（**必填**） | 扫描指定路径 | 只读 |

## 执行的两道闸门

1. **用户确认**：`confirm: true`（Agent 必须先把审核清单给你看过）；
2. **计划干净**：`conflict = 0`、`unknown = 0`、无重复目标。

执行顺序：**先改作品目录名，再处理文件**（补 `Season` 子目录时源路径按映射更新）。
每条写 `apply-state.json`（可断点续跑）与 `rollback.json`（传 `rollback: true` 可整批改回）。

## 规则包（可换、可扩展）

```text
rules/
├── registry.json        # 有哪些规则包、默认用哪个
└── cn-media/
    ├── rules.json       # rootPrefix / libraries / excluded / videoExtensions / cleanup / templates / policies
    └── examples.json    # 配套样例集（12 条，含实测踩坑的回归用例）
```

`libraries` 是**映射**而不是白名单：`{ "match": "我的剧集", "mediaType": "tv" }`——路径中任一段命中即生效。
换规则：新建 `rules/<id>/` 并登记，或调用时传 `rulePackPath`。

## 验证

```powershell
npm test                           # 一键跑下面全部 9 套（缺 Python 时自动跳过 2 套）
node test/local-storage-test.mjs   # 33 项：本地/NAS 后端（扫描、计划、零移动、补 Season、占用保护、后端路由）
node test/quick-flow-test.mjs      #  9 项：计划自动落盘 + 最近计划 + 免路径调用（离线）
node test/engine-test.mjs          # 17 项：样例 + 通用性 + 目录名规范化
node test/plugin-smoke.mjs         # 42 项：12 个工具、流程、校验、审核视图、执行闸门
node test/schema-check.mjs         # 50 项：用 DSH 自己的断言校验工具 schema
node test/apply-explain-test.mjs   # 10 项：操作推导与安全闸门（离线）
node test/login-selfcheck-test.mjs #  6 项：扫码登录脚本环境自检（不联网）
py -u test/entry-id-test.py        #  6 项：115 条目 id 字段判定（锁死实测字段语义）
py -u test/operation-plan-test.py  # 11 项：目录改名 vs 换目录的动作判定
```

## 维护与诊断脚本（`python/`）

| 脚本 | 用途 | 写盘 |
| --- | --- | --- |
| `login_115.py` | 扫码登录；写入凭据与配置 | 是（本地） |
| `scan_115.py` | 只读扫描使用者指定的那个路径 | 否 |
| `apply_115.py` | 执行 / `--explain` 演练 / `--rollback` 回滚 | 是（网盘） |
| `probe_list_dir.py` | 诊断：列某一层目录 | 否 |
| `probe_raw.py` | 诊断：原始响应 / `search:关键字` 全盘搜索 / 纯数字按 id 查 | 否 |
| `probe_domains.py` | 诊断：逐个测 115 接口域名的可用性 | 否 |
| `restore_dir.py` | 修复：把被误移动/改名的目录移回原位并改回原名 | 是（网盘） |
| `move_children.py` | 运维：把某目录下的**文件**移到另一个目录 | 是（网盘） |
| `delete_entry.py` | 运维：删除条目（默认只允许删空目录，进回收站可恢复） | 是（网盘） |

## 踩坑记录（都来自实测）

1. **115 的条目字段与直觉相反**——文件条目的 `cid` 是**父目录** id，文件自己的 id 在 `fid`；
   目录条目反过来（`cid` 是自己）。两者都用 `fc` 区分：**1 = 文件，0 = 目录**。
   把 `cid` 当文件 id 用会把**整个目录**移动并改名（`test/entry-id-test.py` 锁死了这个判据）。
2. **p115client 每请求轮换域名**（`cycle(...).__next__`），第 2 个就是被阿里云 WAF 拦的
   `http://web.api.115.com`（`Tengine` + `acw_tc` / HTTP 405）。必须固定域名并加请求间隔。
3. **中文片名可能在目录名里**（文件名是 `Show.Name.S01E01…`，中文名却在目录名上）：
   文件名无中文而作品目录名有中文时，以目录名为准。
4. **改名撞名时 115 不合并，而是自动加 `(1)` 后缀**，于是同一层会出现两个同名目录；
   目录改名务必确认目标名不存在。
5. **PowerShell 捕获子进程输出会带 BOM**；写 JSON 中间文件要显式用无 BOM 的 UTF-8。
6. **「目录改名」不等于「文件换目录」**：作品目录改名时，文件应**原地改名**，最后改目录名即可
   （零移动、零新建）；只有补 `Season` 子目录或跨库才需要移动。把两者混为一谈会白白搬运整个
   目录，还会让「改目录名」撞上刚建的同名目录——115 撞名时不合并，而是加 `(1)`，或把空源目录吞掉。
7. **「补 Season」必须排在「作品目录改名」之后**：先改作品目录名，再在新目录里建 `Season XX`、
   搬文件（源路径按映射更新）；反过来会先创建目标作品目录，随后改目录名必然撞名。

## 边界

- 只读工具无副作用；唯一写操作经 `media_naming_apply`，必须过两道闸门；
- 凭据只判存在/非空/字段名，**不回显、不落任何产物**；
- 只处理规则包里声明的视频文件，字幕 / NFO / 海报不动；
- 仓库内不含任何真实站点域名或作品名，样例均为中性示例数据。
