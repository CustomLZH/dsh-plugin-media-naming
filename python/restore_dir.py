# -*- coding: utf-8 -*-
"""把「被误移动 / 改名的目录」恢复原位（一次性修复工具）。

背景：早期版本的 `entry_id` 误把文件条目的 `cid`（父目录 id）当成文件 id，
一次误操作会把整个作品目录移动并改名（数据本身不丢，只是位置和名字错了）。
本脚本按目录 id 把它移回父目录、并改回原名。

用法：py -u restore_dir.py <cookiesPath> <目录id> <父目录相对路径> <原名>
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

from apply_support import PREFERRED_DOMAIN, make_client, resolve_fid  # noqa: E402


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    if len(argv) < 5:
        print("用法：py -u restore_dir.py <cookiesPath> <目录id> <父目录相对路径> <原名>")
        return 1

    cookies, directory_id, parent_path, original_name = argv[1], argv[2], argv[3], argv[4]
    client = make_client(cookies)
    parent_fid = resolve_fid(client, parent_path)
    if parent_fid is None:
        print(json.dumps({"ok": False, "message": f"父目录不存在：{parent_path}"}, ensure_ascii=False))
        return 1

    result: dict = {"ok": True, "directoryId": directory_id, "parentFid": parent_fid}
    try:
        move_response = client.fs_move(directory_id, pid=parent_fid, base_url=PREFERRED_DOMAIN)
        result["moved"] = bool(move_response.get("state"))
        result["moveRaw"] = str(move_response.get("error") or move_response)[:160]

        rename_response = client.fs_rename((directory_id, original_name), base_url=PREFERRED_DOMAIN)
        result["renamed"] = bool(rename_response.get("state"))
        result["renameRaw"] = str(rename_response.get("error") or rename_response)[:160]
    except Exception as error:  # noqa: BLE001
        result["ok"] = False
        result["message"] = f"{type(error).__name__}: {error}"

    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
