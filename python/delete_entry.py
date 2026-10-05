# -*- coding: utf-8 -*-
"""删除网盘上的一个条目（**进回收站，可恢复**）。

安全设计：默认拒绝删除非空目录，必须先看到内容再决定。

用法：
    py -u delete_entry.py <cookiesPath> <id或相对路径>              # 只预览要删什么
    py -u delete_entry.py <cookiesPath> <id或相对路径> --confirm     # 确认删除（仅空目录）
    py -u delete_entry.py <cookiesPath> <id或相对路径> --confirm --force  # 连内容一起删
"""
from __future__ import annotations

import json
import platform
import sys
from pathlib import Path

platform.system = lambda: "Windows"                      # noqa: E731
platform.win32_ver = lambda *a, **k: ("", "", "", "")    # noqa: E731
platform.uname = lambda: ("Windows", "", "", "", "")     # noqa: E731

sys.path.insert(0, str(Path(__file__).resolve().parent))

from apply_support import (  # noqa: E402
    PREFERRED_DOMAIN,
    entry_name,
    list_children,
    make_client,
    resolve_fid,
)


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    if len(argv) < 3:
        print("用法：py -u delete_entry.py <cookiesPath> <id或相对路径> [--confirm] [--force]")
        return 1

    cookies, target = argv[1], argv[2]
    confirmed = "--confirm" in argv
    force = "--force" in argv

    try:
        client = make_client(cookies)
        fid = target if target.isdigit() else resolve_fid(client, target)
        if fid is None:
            emit({"ok": False, "message": f"目标不存在：{target}"})
            return 1

        children = list_children(client, fid)
        names = [entry_name(entry) for entry in children]

        if not confirmed:
            emit({
                "ok": False, "reason": "need-confirm", "target": target, "id": fid,
                "childCount": len(children), "children": names[:20],
                "hint": "确认无误后加 --confirm；删的是非空目录时还需 --force",
            })
            return 1

        if children and not force:
            emit({
                "ok": False, "reason": "not-empty",
                "message": "目标非空，拒绝删除以免误伤内容；确认要连内容一起删再加 --force",
                "childCount": len(children), "children": names[:20],
            })
            return 1

        response = client.fs_delete(fid, base_url=PREFERRED_DOMAIN)
        emit({
            "ok": bool(response.get("state")), "deletedId": fid,
            "childCount": len(children), "raw": str(response.get("error") or response)[:200],
        })
        return 0
    except Exception as error:  # noqa: BLE001
        emit({"ok": False, "code": type(error).__name__, "message": str(error)})
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
