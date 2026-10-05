# -*- coding: utf-8 -*-
"""诊断脚本：逐个测试 115 的接口域名，定位 WAF 拦截（排查用，可删）。

用法：py -u probe_domains.py <cookiesPath> [cid]
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

from apply_support import make_client  # noqa: E402

# 影视资源 目录的 fid（用于测试子目录列举）
DEFAULT_CID = "3364145441594670745"

DOMAINS = [
    "https://webapi.115.com",
    "https://web.api.115.com",
    "https://115.com",
    "https://proapi.115.com",
    "https://anxia.com",
]


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    cookies = argv[1] if len(argv) > 1 else ""
    cid = argv[2] if len(argv) > 2 and argv[2] else DEFAULT_CID
    results = []
    try:
        client = make_client(cookies)
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"ok": False, "message": f"构造客户端失败：{error}"}, ensure_ascii=False))
        return 1

    for domain in DOMAINS:
        entry = {"domain": domain}
        try:
            response = client.fs_files({"cid": cid, "limit": 1, "show_dir": 1}, base_url=domain)
            entry["ok"] = bool(response.get("state"))
            entry["state"] = response.get("state")
            entry["error"] = str(response.get("error") or "")[:120]
            entry["items"] = len(response.get("data") or [])
        except Exception as error:  # noqa: BLE001
            entry["ok"] = False
            entry["error"] = f"{type(error).__name__}: {error}"
        results.append(entry)

    print(json.dumps({"ok": True, "cid": cid, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
