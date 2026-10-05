# -*- coding: utf-8 -*-
"""诊断脚本：用**固定域名**直连 115 /files 接口（排查 WAF/域名问题，可删）。

用法：py -u probe_list_dir.py <cookiesPath> [相对路径] [limit]
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

from apply_support import PREFERRED_DOMAIN, make_client  # noqa: E402


def list_once(client, fid, limit: int) -> dict:
    """列一层目录：显式指定 base_url，绕开 p115client 的域名轮换。"""
    return client.fs_files(
        {"cid": fid, "limit": limit, "offset": 0, "show_dir": 1},
        base_url=PREFERRED_DOMAIN,
    )


def entry_id(entry: dict):
    return entry.get("fid") or entry.get("cid")


def find_child(client, fid, name: str):
    response = list_once(client, fid, 300)
    if not response.get("state"):
        raise RuntimeError(f"列目录失败：{str(response)[:200]}")
    for entry in response.get("data") or []:
        if entry.get("n") == name:
            return entry_id(entry)
    return None


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    cookies = argv[1] if len(argv) > 1 else ""
    path = argv[2] if len(argv) > 2 else ""
    limit = int(argv[3]) if len(argv) > 3 and argv[3] else 10

    try:
        client = make_client(cookies)
        fid = 0
        for segment in [part for part in str(path).replace("\\", "/").split("/") if part]:
            fid = find_child(client, fid, segment)
            if fid is None:
                print(json.dumps({"ok": False, "message": f"路径不存在：{path}"}, ensure_ascii=False))
                return 1
        response = list_once(client, fid, limit)
        entries = response.get("data") or []
        print(json.dumps({
            "ok": bool(response.get("state")),
            "domain": PREFERRED_DOMAIN,
            "path": path or "(根)",
            "count": response.get("count"),
            "keys": sorted(entries[0].keys()) if entries else [],
            "entries": [
                {"n": entry.get("n"), "fid": entry.get("fid"), "cid": entry.get("cid"),
                 "fc": entry.get("fc"), "size": entry.get("s")}
                for entry in entries
            ],
        }, ensure_ascii=False))
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
