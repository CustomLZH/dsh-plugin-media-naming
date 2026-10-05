# -*- coding: utf-8 -*-
"""网盘只读扫描（media-naming 的可选能力）。

设计约束：
- 只调用只读接口列目录，绝不调用 rename / move / delete / mkdir；
- **不预设任何本机路径，也不预设目录结构**：凭据、根目录名、要扫描的节目目录
  全部由调用方给出；
- **path 必填**：使用者要处理的是他指定的那一个节目目录，不允许扫根或整库；
- 所有请求固定走可用域名（`apply_support.PREFERRED_DOMAIN`）并带最小间隔，
  因为 p115client 默认的域名轮换会撞上被 WAF 拦截的备用域名。
"""
from __future__ import annotations

import json
import platform
import sys
from pathlib import Path

# 必须在导入任何第三方网络库之前执行：本机 platform.system() 会经 COM 查询 WMI
# 且永不返回，导致 urllib3 / 网盘客户端在「导入阶段」就卡死。
platform.system = lambda: "Windows"                      # noqa: E731
platform.win32_ver = lambda *a, **k: ("", "", "", "")    # noqa: E731
platform.uname = lambda: ("Windows", "", "", "", "")     # noqa: E731

sys.path.insert(0, str(Path(__file__).resolve().parent))

from apply_support import (  # noqa: E402
    entry_id,
    entry_is_dir,
    entry_name,
    list_children,
    make_client,
    resolve_fid,
)

DEFAULT_ROOT = "影视资源"
MAX_DEPTH = 3
VIDEO_EXTS = {
    ".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv",
    ".ts", ".m2ts", ".m4v", ".rmvb", ".webm",
}


class ScanError(RuntimeError):
    """扫描失败；消息面向使用者与 Agent。"""


def _walk(client, fid, path: str, depth: int, state: dict) -> None:
    if depth < 0 or state["truncated"]:
        return
    for entry in list_children(client, fid):
        if state["truncated"]:
            return
        name = entry_name(entry)
        if not name:
            continue
        if entry_is_dir(entry):
            _walk(client, entry_id(entry), f"{path}/{name}", depth - 1, state)
            continue
        state["scanned"] += 1
        state["existingByDir"].setdefault(path, []).append(name)
        if Path(name).suffix.lower() in VIDEO_EXTS:
            state["files"].append(f"{path}/{name}")
        if state["scanned"] >= state["limit"]:
            state["truncated"] = True
            return


def scan(cookies_path: str = "", path: str = "", root: str = DEFAULT_ROOT, limit: int = 500) -> dict:
    """只读扫描使用者指定的那个路径，返回其下的视频文件清单与已有文件名。

    - 目录名与层级**不预设**：整库、一个节目目录、只有一个视频的目录都可以；
    - `root` 只是**可选的默认根名**：若 `path` 里已经带了根名（或使用者用的是别的根名），
      这里逐个候选去试、取第一个能解析到的，绝不会拼出「双前缀」；
    - 返回值不含凭据内容，也不含凭据路径。
    """
    if not path:
        raise ScanError("缺少 path：请给出要处理的那个路径（目录可以是任意层级）")

    parts = [part for part in str(path).replace("\\", "/").split("/") if part]
    candidates: list = []
    if root and parts and parts[0] == root:
        candidates.append(parts)
    if root:
        candidates.append([root, *parts])
    candidates.append(parts)

    client = make_client(cookies_path)
    fid, full_path, tried = None, "", []
    for segments in candidates:
        candidate = "/".join(segments)
        if not candidate or candidate in tried:
            continue
        tried.append(candidate)
        fid = resolve_fid(client, candidate)
        if fid is not None:
            full_path = candidate
            break
    if fid is None:
        raise ScanError(f"网盘路径不存在：试过 {'、'.join(tried)}；请核对路径是否写对")

    state = {
        "limit": max(1, int(limit)),
        "scanned": 0,
        "truncated": False,
        "files": [],
        "existingByDir": {},
    }
    _walk(client, fid, full_path, MAX_DEPTH, state)
    return {
        "rootPath": full_path,
        "files": state["files"],
        "existingByDir": state["existingByDir"],
        "scanned": state["scanned"],
        "truncated": state["truncated"],
        "writable": False,
    }


def main(argv: list) -> int:
    """命令行入口：argv = [cookiesPath, path, root?, limit?]。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    args = argv[1:]
    try:
        data = scan(
            cookies_path=args[0] if len(args) > 0 else "",
            path=args[1] if len(args) > 1 else "",
            root=args[2] if len(args) > 2 and args[2] else DEFAULT_ROOT,
            limit=int(args[3]) if len(args) > 3 and args[3] else 500,
        )
        payload = {"ok": True, "data": data}
    except Exception as error:  # noqa: BLE001 - 桥接层必须把失败翻译成 JSON
        payload = {"ok": False, "error": {"code": type(error).__name__, "message": str(error)}}
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
