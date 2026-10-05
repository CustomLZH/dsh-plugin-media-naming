# -*- coding: utf-8 -*-
"""apply_115.py 与 login_115.py 共用的网盘操作支撑。

只放「与具体命令行无关」的东西：客户端构造、条目字段兼容、路径解析、
目录创建、带退避的重试、状态与回滚文件的读写，以及「计划 → 操作序列」的纯函数。

**只读与写入的边界在这里划清**：`_ok()` 逐次校验接口返回的 state；
所有写操作都经由 `_with_retry()`，失败即抛错、不吞异常。
"""
from __future__ import annotations

import json
import platform
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# 必须在导入任何第三方网络库之前执行：本机 platform.system() 会经 COM 查询 WMI
# 且永不返回，导致 urllib3 / 网盘客户端在「导入阶段」就卡死。
platform.system = lambda: "Windows"                      # noqa: E731
platform.win32_ver = lambda *a, **k: ("", "", "", "")    # noqa: E731
platform.uname = lambda: ("Windows", "", "", "", "")     # noqa: E731

ROOT_FID = 0
COOLDOWN_SECONDS = 0.4
MAX_ATTEMPTS = 3

# p115client 默认在 6 个域名间轮换（cycle(...).__next__），第 2 个请求就会轮到
# `http://web.api.115.com`——该域名会被阿里云 WAF 拦截（405 / Tengine + acw_tc）。
# 因此这里把域名固定到实测可用的主域名，并给每次列目录之间加最小间隔。
PREFERRED_DOMAIN = "https://webapi.115.com"
REQUEST_INTERVAL_SECONDS = 0.35


def patch_domains() -> None:
    """把 p115client 的域名轮换固定到可用域名。"""
    try:
        from p115client.tool import fs_files as fs_files_tool

        fs_files_tool.get_webapi_origin = lambda: PREFERRED_DOMAIN
    except Exception:  # noqa: BLE001 - 库结构变化时不影响主流程
        pass


class ApplyError(RuntimeError):
    """执行失败；消息面向使用者与 Agent。"""


# ---------------- 计划 → 操作序列（纯函数，可离线测试） ----------------

def split_path(path: str) -> tuple[list[str], str]:
    parts = [part for part in str(path).replace("\\", "/").split("/") if part]
    if not parts:
        return [], ""
    return parts[:-1], parts[-1]


def plan_operations(items: list) -> list:
    """把计划条目转成「需要做什么」的清单，不涉及网络。

    关键区分两种「目录不同」：
    - **作品目录改名**（父路径一致、只有最后一段不同）：文件**不需要移动**，
      原地改名即可——最后改目录名时会带着它们一起走；
    - **真正换目录**（父路径或层级变了，例如补 `Season 01` 子目录）：才需要移动。
    """
    operations = []
    for item in items:
        if item.get("status") != "CHANGED":
            continue
        current_path = item.get("currentPath") or ""
        proposed_path = item.get("proposedPath") or ""
        if not current_path or not proposed_path:
            continue
        current_dirs, current_name = split_path(current_path)
        proposed_dirs, proposed_name = split_path(proposed_path)

        # 作品目录改名：层级相同、父路径一致，仅作品目录名不同
        workdir_renamed = (
            len(current_dirs) == len(proposed_dirs) > 0
            and current_dirs[:-1] == proposed_dirs[:-1]
            and current_dirs[-1] != proposed_dirs[-1]
        )
        needs_move = current_dirs != proposed_dirs and not workdir_renamed

        operations.append({
            "currentPath": current_path,
            "proposedPath": proposed_path,
            "currentDirs": current_dirs,
            "proposedDirs": proposed_dirs,
            "currentName": current_name,
            "proposedName": proposed_name,
            "workdirRenamed": workdir_renamed,
            "needsMove": needs_move,
            "needsMkdir": needs_move,
            "needsRename": current_name != proposed_name,
        })
    return operations


def key_of(operation: dict) -> str:
    return f"{operation['currentPath']} -> {operation['proposedPath']}"


def plan_directory_operations(directories: list) -> list:
    """把「作品目录名调整」转成操作清单；同样不涉及网络。

    目录改名放在文件操作**之后**执行：先用旧目录路径改完文件，最后改目录名，
    这样整个目录树一起改名，不会中途路径失效。
    """
    operations = []
    for entry in directories or []:
        if entry.get("status") != "CHANGED":
            continue
        current_path = entry.get("currentPath") or ""
        proposed_path = entry.get("proposedPath") or ""
        if not current_path or not proposed_path or current_path == proposed_path:
            continue
        parent_dirs, current_name = split_path(current_path)
        _, proposed_name = split_path(proposed_path)
        if not current_name or not proposed_name or current_name == proposed_name:
            continue
        operations.append({
            "currentPath": current_path,
            "proposedPath": proposed_path,
            "parentDirs": parent_dirs,
            "currentName": current_name,
            "proposedName": proposed_name,
        })
    return operations


# ---------------- 状态与回滚 ----------------

def load_json(path: Path, default: dict) -> dict:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def save_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


# ---------------- 网盘访问 ----------------

def _field(item: Any, *names: str, default: Any = None) -> Any:
    """兼容 dict 与对象两种条目形态。"""
    if isinstance(item, dict):
        for name in names:
            if item.get(name) is not None:
                return item[name]
        return default
    for name in names:
        value = getattr(item, name, None)
        if value is not None:
            return value
    return default


def make_client(cookies_path: str):
    """从纯文本 Cookie 文件或 JSON 凭据构造客户端。"""
    patch_domains()
    from p115client import P115Client

    if not cookies_path:
        raise ApplyError("缺少凭据路径：请先扫码登录（login_115.py）或在配置里填 cookiesPath")
    path = Path(cookies_path)
    if not path.is_file():
        raise ApplyError(f"凭据文件不存在：{path}")
    raw = path.read_text(encoding="utf-8").strip()
    if not raw:
        raise ApplyError(f"凭据文件为空：{path}")
    return P115Client(json.loads(raw)) if raw.startswith("{") else P115Client(raw)


def is_ok(response: Any) -> bool:
    """网盘接口可能 HTTP 成功但 state=False，必须逐次校验。"""
    return isinstance(response, dict) and response.get("state") is True


def with_retry(action, describe: str, log=print) -> Any:
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        last = action()
        if is_ok(last):
            return last
        log(f"    重试 {attempt}/{MAX_ATTEMPTS}：{describe} -> {str(last)[:160]}")
        time.sleep(2 * attempt + COOLDOWN_SECONDS)
    raise ApplyError(f"{describe} 连续 {MAX_ATTEMPTS} 次失败：{str(last)[:200]}")


def list_children(client, fid, limit: int = 1150) -> list:
    """列一层目录：固定域名 + 分页 + 最小请求间隔。

    刻意不用 `P115FileSystem`：它内部的列目录工具在 6 个域名间轮换
    （`cycle(...).__next__`），第 2 个请求就是被 WAF 拦的 `http://web.api.115.com`。
    """
    entries: list = []
    offset = 0
    while True:
        time.sleep(REQUEST_INTERVAL_SECONDS)
        response = client.fs_files(
            {"cid": fid, "limit": limit, "offset": offset, "show_dir": 1},
            base_url=PREFERRED_DOMAIN,
        )
        if not is_ok(response):
            raise ApplyError(f"列出目录失败（cid={fid}）：{str(response.get('error') or response)[:200]}")
        batch = response.get("data") or []
        entries.extend(batch)
        total = int(response.get("count") or 0)
        offset += len(batch)
        if not batch or offset >= total:
            return entries


def entry_name(entry: dict) -> str:
    return str(entry.get("n") or "")


def entry_is_dir(entry: dict) -> bool:
    """115 的条目用 `fc` 区分：**1 = 文件，0 = 目录**。"""
    fc = entry.get("fc")
    if isinstance(fc, (int, str)) and not isinstance(fc, bool):
        try:
            return int(fc) == 0
        except (TypeError, ValueError):
            pass
    # 退化判据：文件的 fid 有值，目录没有
    return not entry.get("fid")


def entry_id(entry: dict) -> Optional[str]:
    """条目**自己的** id：目录取 `cid`，文件取 `fid`。

    ⚠️ 文件条目的 `cid` 是**父目录**的 id，绝不能当文件 id 使用。
    早期版本写成 `cid or fid`，导致「移动/改名整个目录」——务必保持这个判据。
    """
    value = entry.get("cid") if entry_is_dir(entry) else entry.get("fid")
    if not value:
        value = entry.get("fid") or entry.get("cid")
    return str(value) if value else None


def find_child(client, fid, name: str) -> Optional[dict]:
    for entry in list_children(client, fid):
        if entry_name(entry) == name:
            return entry
    return None


def resolve_fid(client, path: str) -> Optional[str]:
    """按路径逐层进入，返回目标文件 / 目录的 id。"""
    parts = [part for part in str(path).replace("\\", "/").split("/") if part]
    current = str(ROOT_FID)
    for segment in parts:
        entry = find_child(client, current, segment)
        if entry is None:
            return None
        current = entry_id(entry)
        if current is None:
            return None
    return current


def ensure_dir(client, segments: list, log=print) -> Optional[str]:
    """逐层确保目录存在（不存在才创建），返回最终 id。"""
    current = str(ROOT_FID)
    for segment in segments:
        entry = find_child(client, current, segment)
        if entry is not None:
            current = entry_id(entry)
            continue
        with_retry(lambda: client.fs_mkdir(segment, pid=current, base_url=PREFERRED_DOMAIN),
                   f"创建目录 {segment}", log)
        entry = find_child(client, current, segment)
        if entry is None:
            raise ApplyError(f"创建目录后仍找不到：{segment}")
        current = entry_id(entry)
    return current


def work_paths(plan_path: Path, work_dir: str) -> tuple[Path, Path]:
    """决定 state.json 与 rollback.json 的落点。"""
    base = Path(work_dir) if work_dir else plan_path.resolve().parent
    return base / "apply-state.json", base / "rollback.json"
