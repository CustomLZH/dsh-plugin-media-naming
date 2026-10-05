# -*- coding: utf-8 -*-
"""按计划执行改名 / 移动（media-naming 提供的**执行方法**）。

可由 Agent 直接调用（工具会先校验计划），也可由使用者手动运行。

用法：
    py -u apply_115.py --plan plan.json --explain                    # 离线解释，不联网
    py -u apply_115.py --plan plan.json --cookies c.txt              # dry-run（默认）
    py -u apply_115.py --plan plan.json --cookies c.txt --apply      # 真正执行
    py -u apply_115.py --plan plan.json --cookies c.txt --apply --json   # 结构化回执（给 Agent 读）
    py -u apply_115.py --cookies c.txt --rollback --json             # 按回滚清单改回

安全闸门（无论如何调用都生效）：
- 默认 dry-run，必须显式 `--apply` 才写入；
- 计划里 conflict / unknown 非 0 → 直接拒绝（退出码 2）；
- 目标名已被占用 → 跳过并报错，**绝不覆盖**；
- 逐条写 state，中断可断点续跑；逐条写 rollback，可整批改回；
- 逐条冷却 + 指数退避重试。

退出码：0 成功、1 参数或环境问题、2 计划不干净、3 执行中断。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from apply_support import (  # noqa: E402
    ApplyError,
    COOLDOWN_SECONDS,
    ensure_dir,
    find_child,
    is_ok,
    key_of,
    load_json,
    make_client,
    now_iso,
    PREFERRED_DOMAIN,
    entry_id,
    plan_directory_operations,
    plan_operations,
    resolve_fid,
    save_json,
    with_retry,
    work_paths,
)

EXIT_OK, EXIT_USAGE, EXIT_DIRTY, EXIT_INTERRUPTED = 0, 1, 2, 3


def _text_log(message: str) -> None:
    print(message, flush=True)


def _json_log(message: str) -> None:
    """JSON 模式下日志走 stderr，避免污染 stdout 的结果。"""
    print(message, file=sys.stderr, flush=True)


def _load_plan(plan_path: str) -> dict:
    path = Path(plan_path)
    if not path.is_file():
        raise ApplyError(f"计划文件不存在：{path}")
    return json.loads(path.read_text(encoding="utf-8"))


def execute(args, log=_text_log) -> tuple[dict, int]:
    plan = _load_plan(args.plan)
    operations = plan_operations(plan.get("items", []))
    summary = plan.get("summary", {})

    log(f"计划：{plan.get('planId', '?')}｜范围：{plan.get('scope', {})}")
    log(f"条目：变更 {summary.get('changed', len(operations))}、跳过 {summary.get('skip', 0)}、"
        f"冲突 {summary.get('conflict', 0)}、未知 {summary.get('unknown', 0)}")

    if summary.get("conflict", 0) or summary.get("unknown", 0):
        message = "计划里仍有冲突或未知条目：请先处理它们，本脚本拒绝执行。"
        log(f"⛔ {message}")
        return {"ok": False, "reason": "dirty-plan", "message": message, "planId": plan.get("planId")}, EXIT_DIRTY

    log(f"将执行的操作：{len(operations)} 条")
    for operation in operations:
        actions = []
        if operation["needsMkdir"]:
            actions.append(f"建目录 {operation['proposedDirs'][-1]}")
        if operation["needsMove"]:
            actions.append("移动")
        if operation["needsRename"]:
            actions.append(f"改名 -> {operation['proposedName']}")
        log(f"  · {operation['currentPath']}\n      {' / '.join(actions) or '无需操作'}")

    if args.explain:
        log("（--explain 模式：不联网、不写入任何内容）")
        return {"ok": True, "explain": True, "operations": len(operations), "planId": plan.get("planId")}, EXIT_OK

    if not operations:
        return {"ok": True, "executed": 0, "message": "没有需要执行的操作", "planId": plan.get("planId")}, EXIT_OK

    client = make_client(args.cookies)
    # 直接用 client + 固定域名：P115FileSystem 内部的列目录工具会在 6 个域名间轮换，
    # 第 2 个就是被 WAF 拦截的 http://web.api.115.com（详见 apply_support 的说明）。
    file_system = client
    state_path, rollback_path = work_paths(Path(args.plan), args.work_dir)

    state = load_json(state_path, {"done": [], "failed": []})
    done = set(state.get("done", []))
    rollback = load_json(rollback_path, {"createdAt": now_iso(), "items": []})

    if args.apply:
        log(f">> 执行中（state：{state_path}；回滚清单：{rollback_path}）")
    else:
        log(">> DRY-RUN：不会写入任何内容。确认无误后加 --apply 再运行一次。")

    # ① **先改作品目录名**：之后文件的源路径按映射更新即可。
    #    反过来的顺序会死锁——补 Season 时先建了目标作品目录，再改原目录名就会撞名。
    renamed_dirs: dict = {}
    directory_done = 0
    for directory_op in plan_directory_operations(plan.get("directories", [])):
        label = key_of(directory_op)
        log(f"\n[目录] {directory_op['currentPath']}")
        if label in done:
            log("    已完成，跳过（断点续跑）")
            continue
        parent_fid = resolve_fid(file_system, "/".join(directory_op["parentDirs"]))
        if parent_fid is None:
            log("    ✗ 找不到父目录")
            state.setdefault("failed", []).append({"key": label, "reason": "parent-not-found"})
            save_json(state_path, state)
            continue
        entry = find_child(file_system, parent_fid, directory_op["currentName"])
        if entry is None:
            log("    ✗ 找不到该目录（可能已改名）")
            state.setdefault("failed", []).append({"key": label, "reason": "directory-not-found"})
            save_json(state_path, state)
            continue

        # 目标目录名已被占用就绝不改名：115 撞名时会加 (1) 后缀，甚至把源目录吞掉
        occupied = find_child(file_system, parent_fid, directory_op["proposedName"])
        if occupied is not None and entry_id(occupied) != entry_id(entry):
            log(f"    ✗ 目标目录名已被占用，跳过（绝不覆盖）：{directory_op['proposedName']}")
            state.setdefault("failed", []).append({"key": label, "reason": "target-occupied"})
            save_json(state_path, state)
            continue

        if not args.apply:
            log(f"    · 将改名为：{directory_op['proposedName']}")
            continue

        directory_fid = entry_id(entry)
        try:
            with_retry(lambda: client.fs_rename((directory_fid, directory_op["proposedName"]), base_url=PREFERRED_DOMAIN),
                       f"目录改名 {directory_op['currentName']}", log)
        except ApplyError as error:
            log(f"    ✗ {error}")
            state.setdefault("failed", []).append({"key": label, "reason": str(error)[:200]})
            save_json(state_path, state)
            continue

        renamed_dirs[directory_op["currentPath"]] = directory_op["proposedPath"]
        directory_done += 1
        done.add(label)
        state["done"] = sorted(done)
        save_json(state_path, state)
        rollback["items"].append({
            "from": directory_op["proposedPath"],
            "to": directory_op["currentPath"],
            "fid": str(directory_fid),
            "at": now_iso(),
            "kind": "directory",
        })
        save_json(rollback_path, rollback)
        log("    ✓ 完成")
        time.sleep(COOLDOWN_SECONDS)

    def remap_path(path: str) -> str:
        """作品目录改名后，把文件的原路径换算到新位置。"""
        for before, after in renamed_dirs.items():
            if path == before:
                return after
            if path.startswith(before + "/"):
                return after + path[len(before):]
        return path

    # ② 再处理文件：源路径按 ① 的映射更新
    executed, skipped = 0, 0
    for index, operation in enumerate(operations, start=1):
        label = key_of(operation)
        log(f"\n[{index}/{len(operations)}] {operation['currentPath']}")
        if label in done:
            log("    已完成，跳过（断点续跑）")
            skipped += 1
            continue

        # 作品目录可能已在 ① 里改名：把源路径换算到新位置再定位
        source_fid = resolve_fid(file_system, remap_path(operation["currentPath"]))
        if source_fid is None:
            log("    ✗ 找不到源文件（可能已改名或移动）")
            state.setdefault("failed", []).append({"key": label, "reason": "source-not-found"})
            save_json(state_path, state)
            continue

        target_dir_fid = None
        if operation["needsMkdir"]:
            target_dir_fid = ensure_dir(client, operation["proposedDirs"], log)
        elif operation["needsMove"]:
            target_dir_fid = resolve_fid(file_system, "/".join(operation["proposedDirs"]))
            if target_dir_fid is None:
                log("    ✗ 目标目录不存在")
                state.setdefault("failed", []).append({"key": label, "reason": "target-dir-missing"})
                save_json(state_path, state)
                continue

        if target_dir_fid is not None:
            occupied = find_child(file_system, target_dir_fid, operation["proposedName"])
            if occupied is not None and entry_id(occupied) != source_fid:
                log(f"    ✗ 目标名已被占用，跳过（绝不覆盖）：{operation['proposedName']}")
                state.setdefault("failed", []).append({"key": label, "reason": "target-occupied"})
                save_json(state_path, state)
                continue

        if not args.apply:
            log("    · 将执行：" + (" 移动" if operation["needsMove"] else "")
                + (" 改名" if operation["needsRename"] else ""))
            continue

        try:
            if operation["needsMove"] and target_dir_fid is not None:
                with_retry(lambda: client.fs_move(source_fid, pid=target_dir_fid, base_url=PREFERRED_DOMAIN),
                           f"移动 {operation['currentName']}", log)
            if operation["needsRename"]:
                with_retry(lambda: client.fs_rename((source_fid, operation["proposedName"]), base_url=PREFERRED_DOMAIN),
                           f"改名 {operation['currentName']}", log)
        except ApplyError as error:
            log(f"    ✗ {error}")
            state.setdefault("failed", []).append({"key": label, "reason": str(error)[:200]})
            save_json(state_path, state)
            log("    ⛔ 已停止：排查后重新运行即可从断点续跑。")
            return {
                "ok": False, "reason": "interrupted", "message": str(error)[:200],
                "planId": plan.get("planId"), "executed": executed,
                "statePath": str(state_path), "rollbackPath": str(rollback_path),
            }, EXIT_INTERRUPTED

        executed += 1
        done.add(label)
        state["done"] = sorted(done)
        save_json(state_path, state)
        rollback["items"].append({
            "from": operation["proposedPath"],
            "to": operation["currentPath"],
            "fid": str(source_fid),
            "at": now_iso(),
        })
        save_json(rollback_path, rollback)
        log("    ✓ 完成")
        time.sleep(COOLDOWN_SECONDS)

    log(f"\n结束：文件 {executed} 条、目录 {directory_done} 个；跳过 {skipped} 条，累计完成 {len(done)} 条")
    return {
        "ok": True,
        "planId": plan.get("planId"),
        "dryRun": not args.apply,
        "executed": executed,
        "directoriesExecuted": directory_done,
        "skipped": skipped,
        "failed": state.get("failed", []),
        "total": len(done),
        "statePath": str(state_path),
        "rollbackPath": str(rollback_path),
    }, EXIT_OK


def rollback(args, log=_text_log) -> tuple[dict, int]:
    """按 rollback.json 把改过的名字/位置改回去。"""
    plan = _load_plan(args.plan) if args.plan else {}
    state_path, rollback_path = work_paths(Path(args.plan) if args.plan else Path.cwd(), args.work_dir)
    rollback = load_json(rollback_path, {"items": []})
    items = list(rollback.get("items", []))
    if not items:
        return {"ok": False, "reason": "no-rollback", "message": f"没有回滚记录：{rollback_path}"}, EXIT_USAGE

    log(f"回滚清单：{rollback_path}（{len(items)} 条）")
    if args.explain or not args.apply:
        for item in items:
            log(f"  · {item['from']}  ->  {item['to']}")
        log(">> DRY-RUN：不会写入任何内容。确认无误后加 --apply 再运行一次。")
        return {"ok": True, "dryRun": True, "rollback": len(items)}, EXIT_OK

    client = make_client(args.cookies)
    file_system = client

    restored, failed = 0, []
    for index, item in enumerate(reversed(items), start=1):
        source = item.get("from") or ""
        target = item.get("to") or ""
        log(f"\n[{index}/{len(items)}] {source}  ->  {target}")
        if not source or not target:
            failed.append({"item": item, "reason": "invalid-record"})
            continue
        fid = resolve_fid(file_system, source)
        if fid is None:
            log("    ✗ 找不到当前文件，可能已被再次改动")
            failed.append({"item": item, "reason": "source-not-found"})
            continue
        target_dirs, target_name = source.rsplit("/", 1)[0], target.rsplit("/", 1)[-1]
        target_dir_fid = resolve_fid(file_system, target_dirs) if target_dirs else None
        try:
            if target_dir_fid is not None and "/".join(source.rsplit("/", 1)[:-1]) != target_dirs:
                with_retry(lambda: client.fs_move(fid, pid=target_dir_fid, base_url=PREFERRED_DOMAIN),
                           f"移回 {target_name}", log)
            if source.rsplit("/", 1)[-1] != target_name:
                with_retry(lambda: client.fs_rename((fid, target_name), base_url=PREFERRED_DOMAIN),
                           f"改回 {target_name}", log)
        except ApplyError as error:
            log(f"    ✗ {error}")
            failed.append({"item": item, "reason": str(error)[:200]})
            continue
        restored += 1
        log("    ✓ 已恢复")
        time.sleep(COOLDOWN_SECONDS)

    log(f"\n回滚结束：恢复 {restored} 条，失败 {len(failed)} 条")
    return {"ok": len(failed) == 0, "restored": restored, "failed": failed, "rollbackPath": str(rollback_path)}, EXIT_OK


def main(argv: list) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    parser = argparse.ArgumentParser(description="按 media-naming 的计划执行改名 / 移动（默认 dry-run）")
    parser.add_argument("--plan", default="", help="计划 JSON 路径（--rollback 时可省略）")
    parser.add_argument("--cookies", default="", help="凭据文件路径；--explain 不需要")
    parser.add_argument("--apply", action="store_true", help="真正写入；不加则只做 dry-run")
    parser.add_argument("--explain", action="store_true", help="离线解释计划，不联网不写入")
    parser.add_argument("--rollback", action="store_true", help="按回滚清单改回")
    parser.add_argument("--json", action="store_true", help="以 JSON 输出结果（日志走 stderr）")
    parser.add_argument("--work-dir", default="", help="state / rollback 的目录，默认与计划同目录")
    args = parser.parse_args(argv[1:])

    log = _json_log if args.json else _text_log
    try:
        if args.rollback:
            payload, code = rollback(args, log)
        else:
            if not args.plan:
                raise ApplyError("缺少 --plan（除非使用 --rollback）")
            if not args.explain and not args.cookies:
                raise ApplyError("缺少 --cookies：dry-run 与执行都需要凭据（只想看计划请加 --explain）")
            payload, code = execute(args, log)
    except (ApplyError, FileNotFoundError, json.JSONDecodeError) as error:
        payload, code = {"ok": False, "reason": "error", "message": str(error)}, EXIT_USAGE
    except Exception as error:  # noqa: BLE001 - 统一翻译成结构化回执
        payload, code = {"ok": False, "reason": type(error).__name__, "message": str(error)}, EXIT_USAGE

    if args.json:
        print(json.dumps({"exitCode": code, **payload}, ensure_ascii=False))
    elif not payload.get("ok"):
        print(f"失败：{payload.get('message')}")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
