# -*- coding: utf-8 -*-
"""诊断脚本：打印 /files 接口的原始响应（排查列举不全 / 字段判定，可删）。

用法：py -u probe_raw.py <cookiesPath> [相对路径] [limit]
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

    cookies = argv[1] if len(argv) > 1 else ""
    path = argv[2] if len(argv) > 2 else ""
    limit = int(argv[3]) if len(argv) > 3 and argv[3] else 50

    try:
        client = make_client(cookies)
        # path 以 search: 开头时按关键字全盘搜索（用于确认条目落到哪里）
        if path.startswith("search:"):
            keyword = path[len("search:"):]
            response = client.fs_search(
                {"search_value": keyword, "limit": limit, "offset": 0},
                base_url=PREFERRED_DOMAIN,
            )
            data = response.get("data") or []
            print(json.dumps({
                "ok": response.get("state"),
                "keyword": keyword,
                "count": response.get("count"),
                "returned": len(data),
                "entries": [
                    {"n": entry.get("n"), "cid": entry.get("cid"), "fid": entry.get("fid"),
                     "fc": entry.get("fc"), "pid": entry.get("pid"), "path": entry.get("path")}
                    for entry in data
                ],
            }, ensure_ascii=False, indent=2))
            return 0
        # path 是纯数字时直接当作 cid/目录 id 使用，便于绕过路径解析排查
        if path.isdigit():
            fid = path
        else:
            fid = resolve_fid(client, path) if path else 0
        if fid is None:
            print(json.dumps({"ok": False, "message": f"路径不存在：{path}"}, ensure_ascii=False))
            return 1

        response = client.fs_files(
            {"cid": fid, "limit": limit, "offset": 0, "show_dir": 1},
            base_url=PREFERRED_DOMAIN,
        )
        data = response.get("data") or []
        print(json.dumps({
            "ok": response.get("state"),
            "path": path,
            "dirPathFromResponse": response.get("path"),
            "fid": fid,
            "count": response.get("count"),
            "fileCount": response.get("file_count"),
            "folderCount": response.get("folder_count"),
            "sysCount": response.get("sys_count"),
            "limit": response.get("limit"),
            "pageSize": response.get("page_size"),
            "offset": response.get("offset"),
            "cur": response.get("cur"),
            "order": response.get("order"),
            "returned": len(data),
            "entries": [
                {"n": entry.get("n"), "cid": entry.get("cid"), "pid": entry.get("pid"),
                 "fc": entry.get("fc"), "fid": entry.get("fid"), "f": entry.get("f")}
                for entry in data[:6]
            ],
        }, ensure_ascii=False, indent=2))
    except Exception as error:  # noqa: BLE001
        payload = {"ok": False, "code": type(error).__name__, "message": str(error)}
        response = getattr(error, "response", None)
        if response is not None:
            payload["status"] = getattr(response, "status_code", None)
            payload["url"] = getattr(response, "url", "")
        print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
