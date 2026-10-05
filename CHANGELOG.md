# 更新日志

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-05

首个公开版本。

### 新增

- **命名引擎**（规则包驱动，换包即换口径）
  - 解析片名 / 年份 / 季 / 集 / 版本 / 分P；中文优先、技术标签清理、发布组剥离
  - 五态状态机：`CHANGED` / `SKIP` / `CONFLICT` / `UNKNOWN` / `OUT_OF_SCOPE`
  - 目录名本身也纳入计划：该路径的目录名 + 其下视频文件
  - `Season XX` 子目录可选（`seasonFolder` 开关）

- **双存储后端**（按路径自动路由，无需手动选择）
  - **115 网盘**：扫码登录、只读扫描、改名 / 移动 / 建目录、断点续跑
  - **本机 / NAS(UNC、映射盘) / Linux**：纯 Node 实现，不依赖 Python

- **12 个工具**
  - 主路径：`media_naming_quick`（出审核清单）→ `media_naming_apply`（执行 + 自动复验）
  - 精细控制：`plan` / `review` / `check` / `scan` / `verify` / `parse` / `rules` / `examples` / `flow` / `config`
  - 前置条件（凭据、Python、根目录、规则包、计划落盘路径）全部内化，调用方只需给路径

- **安全设计**
  - 两道闸门：用户确认（`confirm=true`）+ 计划干净（无冲突 / 未知）
  - 目标名被占用即拒绝，绝不覆盖
  - 目录改名零移动；逐条写 `apply-state.json` 可断点续跑；`rollback.json` 可整批改回
  - 更严的顺序：**先改作品目录名，再补 Season 子目录并搬文件**（避免撞名）

- **规则包与样例**
  - `rules/cn-media/`：目录映射、模板、口径、标签表、排除项
  - `examples.json`：12 条样例，其中 5 条来自真实网盘的踩坑回归

- **测试**（184 项，`npm test` 一键跑）
  - 引擎与样例、本地/NAS 后端、计划落盘、工具注册与闸门、schema 校验、动作推导、字段判据

### 修复

- 115 条目字段误用：文件条目的 `cid` 是**父目录** id，真正的 id 在 `fid`（用 `fc` 区分类型）
- p115client 域名轮换撞上被 WAF 拦截的备用域名：固定可用域名并加请求间隔
- 中文片名在目录名里而文件名是外文时，改为以目录名为准
- 目录改名与补 Season 子目录的执行顺序（先改目录名，再搬文件）
- 工具返回值含 `undefined` 导致的「无损 JSON」校验失败

[0.1.0]: https://github.com/CustomLZH/dsh-plugin-media-naming/releases/tag/v0.1.0
