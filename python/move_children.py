# -*- coding: utf-8 -*-
"""把源目录下的**文件**移动到目标目录（只移动文件，不删除任何东西）。

用法：py -u move_children.py <cookiesPath> <源目录：id或相对路径> <目标目录：id或相对路径>
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
    entry_id,
    entry_is_dir,
    entry_name,
    list_children,
    make_client,
    resolve_fid,
)


def resolve_any(client, value: str):
    """纯数字当作 id，否则按相对路径解析。"""
    return value if value.isdigit() else resolve_fid(client, value)


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    if len(argv) < 4:
        print("用法：py -u move_children.py <cookiesPath> <源目录> <目标目录>")
        return 1

    cookies, source_arg, target_arg = argv[1], argv[2], argv[3]
    client = make_client(cookies)
    source_fid = resolve_any(client, source_arg)
    target_fid = resolve_any(client, target_arg)
    if source_fid is None or target_fid is None:
        print(json.dumps({"ok": False, "message": "源目录或目标目录不存在"}, ensure_ascii=False))
        return 1

    moved, skipped, failed = [], [], []
    for entry in list_children(client, source_fid):
        name = entry_name(entry)
        if entry_is_dir(entry):
            skipped.append({"name": name, "reason": "是子目录，未处理"})
            continue
        try:
            response = client.fs_move(entry_id(entry), pid=target_fid, base_url=PREFERRED_DOMAIN)
            if response.get("state"):
                moved.append(name)
            else:
                failed.append({"name": name, "reason": str(response.get("error"))[:120]})
        except Exception as error:  # noqa: BLE001
            failed.append({"name": name, "reason": f"{type(error).__name__}: {error}"})

    print(json.dumps({
        "ok": not failed, "source": source_fid, "target": target_fid,
        "moved": moved, "skipped": skipped, "failed": failed,
    }, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
