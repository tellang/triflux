#!/usr/bin/env python3
"""TFX가 만든 native attach view만 다루는 iTerm API bridge."""
import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
import time
import uuid

import iterm2


def tree(node, live_ids=None):
    if node is None:
        return None
    sid = node.get("session_id") if isinstance(node, dict) else getattr(node, "session_id", None)
    if sid is not None:
        return {"session_id": sid} if live_ids is None or sid in live_ids else None
    vertical = node["vertical"] if isinstance(node, dict) else node.vertical
    source = node["children"] if isinstance(node, dict) else node.children
    children = []
    for child in source:
        child = tree(child, live_ids)
        if child is None:
            continue
        if child.get("vertical") == vertical and "children" in child:
            children.extend(child["children"])
        else:
            children.append(child)
    if not children:
        return None
    if len(children) == 1:
        return children[0]
    return {"vertical": vertical, "children": children}


def dimensions(node, sessions):
    if "session_id" in node:
        s = sessions[node["session_id"]]
        return s["cols"], s["rows"]
    sizes = [dimensions(child, sessions) for child in node["children"]]
    if node["vertical"]:
        return sum(s[0] for s in sizes) + len(sizes) - 1, max(s[1] for s in sizes)
    return max(s[0] for s in sizes), sum(s[1] for s in sizes) + len(sizes) - 1


def leaf_ids(node):
    if "session_id" in node:
        return [node["session_id"]]
    return [sid for child in node["children"] for sid in leaf_ids(child)]


def read_state(path, project):
    if path.exists():
        state = json.loads(path.read_text())
        if state.get("project") != project:
            raise ValueError("registry_project_mismatch")
        return state
    return {"project": project, "records": {}}


def save_state(path, state):
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state))
    tmp.chmod(0o600)
    tmp.replace(path)


async def variable(session, name):
    return await session.async_get_variable(name)


async def inventory(app, request, state):
    await app.async_refresh()
    active_window = app.current_terminal_window
    active_tab = active_window.current_tab if active_window else None
    active = active_tab.current_session if active_tab else None
    result = {"project": request["project"], "leaderId": request.get("leaderId", ""),
              "focusId": active.session_id if active else None,
              "focusWindowId": active_window.window_id if active_window else None,
              "focusTabId": active_tab.tab_id if active_tab else None, "windows": []}
    for window in app.windows:
        frame = await window.async_get_frame()
        wr = {"id": window.window_id, "frame": [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height], "selectedTabId": window.current_tab.tab_id if window.current_tab else None, "tabs": []}
        for tab in window.tabs:
            tr = {"id": tab.tab_id, "selected": bool(window.current_tab and window.current_tab.tab_id == tab.tab_id), "tmux": bool(tab.tmux_connection_id), "sessions": [], "tree": tree(tab.root)}
            for session in tab.sessions:
                sid = session.session_id
                project, group, name, owner = await asyncio.gather(*[
                    variable(session, key) for key in ["user.tfx_project", "user.tfx_group", "user.tfx_session", "user.tfxLayoutOwner"]])
                record = state["records"].get(sid, {})
                owned = bool(record and owner == record.get("owner") and project == request["project"] and name == record.get("session"))
                sr = {"id": sid, "cols": session.grid_size.width, "rows": session.grid_size.height,
                      "project": project, "group": group, "owned": owned, "pinned": False}
                if owned:
                    for key in ["role", "human", "task", "cwd", "minCols", "minRows", "explicit"]:
                        sr[key] = record.get(key)
                    # 종료로 트리가 줄어든 것은 수동 이동으로 취급하지 않는다.
                    old_order = [x for x in record.get("order", []) if app.get_session_by_id(x)]
                    new_order = leaf_ids(tr["tree"])
                    moved = record.get("location") not in (None, [window.window_id, tab.tab_id])
                    reordered = set(old_order) == set(new_order) and old_order != new_order
                    old_tree = tree(record.get("tree"), set(new_order))
                    reshaped = set(old_order) == set(new_order) and old_tree not in (None, tr["tree"])
                    sr["pinned"] = bool(record.get("pinned") or moved or reordered or reshaped)
                    if sr["pinned"]:
                        record["pinned"] = True
                if request.get("leaderTty") and await variable(session, "tty") == request["leaderTty"]:
                    result["leaderId"] = sid
                tr["sessions"].append(sr)
            if tr["sessions"]:
                tr["cols"], tr["rows"] = dimensions(tr["tree"], {s["id"]: s for s in tr["sessions"]})
            else:
                tr["cols"], tr["rows"] = 0, 0
            wr["tabs"].append(tr)
        result["windows"].append(wr)
    result["fingerprint"] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def index_snapshot(snapshot):
    tabs, sessions = {}, {}
    for window in snapshot["windows"]:
        for tab in window["tabs"]:
            tabs[tab["id"]] = tab
            for session in tab["sessions"]:
                sessions[session["id"]] = session
    return tabs, sessions


def require_owned_tab(tab, focus, protect_focus=False):
    if not tab or tab["tmux"]:
        raise ValueError("tmux_integration_or_missing_tab")
    if not tab["sessions"] or any(not s["owned"] or s["pinned"] for s in tab["sessions"]):
        raise ValueError("unowned_or_manually_moved_pane")
    if protect_focus and any(s["id"] == focus or s.get("explicit") for s in tab["sessions"]):
        raise ValueError("focused_or_explicit_pane")


def validate_tree(node, cols, rows, sessions, seen=None, parent=None):
    if seen is None:
        seen = set()
    if "session_id" in node:
        sid = node["session_id"]
        if sid in seen or sid not in sessions or not sessions[sid]["owned"]:
            raise ValueError("unowned_or_duplicate_id")
        seen.add(sid)
        s = sessions[sid]
        if cols < (s.get("minCols") or 80) or rows < (s.get("minRows") or 20):
            raise ValueError("unreadable_layout")
        return seen
    vertical, children = node.get("vertical"), node.get("children", [])
    if not isinstance(vertical, bool) or vertical == parent or len(children) < 2:
        raise ValueError("invalid_split_tree")
    count = len(children)
    for child in children:
        validate_tree(child, (cols - count + 1) // count if vertical else cols,
                      rows if vertical else (rows - count + 1) // count, sessions, seen, vertical)
    return seen


def remember_positions(snapshot, state):
    for window in snapshot["windows"]:
        for tab in window["tabs"]:
            for s in tab["sessions"]:
                if s["owned"]:
                    state["records"][s["id"]].update(location=[window["id"], tab["id"]], order=leaf_ids(tab["tree"]), tree=tab["tree"])
    live = {s["id"] for w in snapshot["windows"] for t in w["tabs"] for s in t["sessions"]}
    state["records"] = {sid: record for sid, record in state["records"].items() if sid in live}


async def mark(session, request, state):
    data = request["input"]
    owner = uuid.uuid4().hex
    record = {key: data.get(key) for key in ["role", "human", "task", "cwd", "minCols", "minRows", "taskInformation", "focusPolicy"]}
    record.update(owner=owner, session=request["session"], explicit=data["mode"] != "auto")
    # 최초 생성 직후 등록해 후속 API 실패에도 재시도가 중복 view를 만들지 않게 한다.
    state["records"][session.session_id] = record
    save_state(Path(request["statePath"]), state)
    for key, value in {"user.tfxLayoutOwner": owner, "user.tfx_project": request["project"],
                       "user.tfx_group": data["group"], "user.tfx_session": request["session"]}.items():
        await session.async_set_variable(key, value)
    profile = iterm2.LocalWriteOnlyProfile()
    profile.set_name(data.get("name") or request["session"])
    profile.set_allow_title_setting(False)
    profile.set_use_custom_command("No")
    await session.async_set_profile_properties(profile)
    await session.tab.async_set_variable("user.tfxLiveGroup", data.get("titleGroup") or data["group"])
    await session.tab.async_set_title(r"\(user.tfxLiveGroup)")


def selected_tab(snapshot, tab):
    return (tab.get("selected") or snapshot.get("focusTabId") == tab["id"] or
            any(s["id"] == snapshot.get("focusId") for s in tab["sessions"]))


def focus_identity(snapshot):
    return tuple(snapshot.get(key) for key in ["focusWindowId", "focusTabId", "focusId"])


def input_workspace(snapshot):
    return {window["id"]: {
        "frame": window.get("frame"),
        "selectedTabs": {tab["id"]: {s["id"]: [s["cols"], s["rows"]] for s in tab["sessions"]}
                         for tab in window["tabs"] if selected_tab(snapshot, tab)},
    } for window in snapshot["windows"]}


async def require_inactive_live(app, tab_ids):
    # API 호출 직전 사람이 선택한 탭도 제외한다. 복원으로 사용자 전환을 덮지 않는다.
    await app.async_refresh()
    for window in app.windows:
        selected = window.current_tab
        if selected and selected.tab_id in tab_ids:
            raise ValueError("selected_tab_protected")


async def open_view(app, connection, request, state, snapshot):
    tabs, sessions = index_snapshot(snapshot)
    c, data = request["candidate"], request["input"]
    focus = data.get("focusPolicy", "preserve") == "focus"
    if c["kind"] == "window" and not focus:
        raise ValueError("focus_preserve_forbids_window")
    if not os.path.isabs(request["tmuxPath"]) or not os.access(request["tmuxPath"], os.X_OK):
        raise ValueError("invalid_tmux_path")
    if not request["session"] or any(ord(ch) < 32 for ch in request["session"]):
        raise ValueError("invalid_session_name")
    duplicate = next((sid for sid, record in state["records"].items()
                      if record["session"] == request["session"] and sessions.get(sid, {}).get("owned")), None)
    if duplicate:
        existing = sessions[duplicate]
        if focus:
            await app.get_session_by_id(duplicate).async_activate(select_tab=True, order_window_front=True)
        after = await inventory(app, request, state)
        verified = existing["cols"] >= data["minCols"] and existing["rows"] >= data["minRows"] and (focus or input_workspace(after) == input_workspace(snapshot))
        return {"ok": True, "sessionId": duplicate, "applied": False, "verified": verified, "reason": "existing_view",
                "focus": {"requested": "focus" if focus else "preserve", "effective": "focus" if focus and after["focusId"] == duplicate else "preserve",
                          "transitioned": focus_identity(after) != focus_identity(snapshot), "reason": "existing_view"}}
    command = shlex.join([request["tmuxPath"], "attach-session", "-t", "=" + request["session"]])
    if c["kind"] == "split":
        tab = tabs.get(c["tabId"])
        require_owned_tab(tab, snapshot["focusId"])
        if not focus and selected_tab(snapshot, tab):
            raise ValueError("selected_tab_protected")
        target = sessions.get(c["sessionId"])
        if not target or target not in tab["sessions"] or (not focus and target["id"] == snapshot["focusId"]) or target.get("human") == "high" or target.get("role") in ("lead", "communication"):
            raise ValueError("focused_or_missing_target")
        if any(s["group"] != data["group"] for s in tab["sessions"]):
            raise ValueError("group_mismatch")
        width = (target["cols"] - 1) // 2 if c["vertical"] else target["cols"]
        height = target["rows"] if c["vertical"] else (target["rows"] - 1) // 2
        if width < max(data["minCols"], target.get("minCols") or 80) or height < max(data["minRows"], target.get("minRows") or 20):
            raise ValueError("split_no_longer_fits")
        profile = iterm2.LocalWriteOnlyProfile()
        profile.set_use_custom_command("Yes")
        profile.set_command(command)
        if not focus:
            await require_inactive_live(app, {c["tabId"]})
        created = await app.get_session_by_id(c["sessionId"]).async_split_pane(vertical=c["vertical"], profile_customizations=profile)
    elif c["kind"] == "tab":
        window = app.get_window_by_id(c["windowId"])
        if not window:
            raise ValueError("window_disappeared")
        created_tab = await window.async_create_tab(command=command, select=False)
        created = created_tab.current_session
    elif c["kind"] == "window":
        created_window = await iterm2.Window.async_create(connection, command=command)
        created = created_window.current_tab.current_session
    else:
        raise ValueError("unsupported_candidate")
    await mark(created, request, state)
    if focus:
        await created.async_activate(select_tab=True, order_window_front=True)
    after = await inventory(app, request, state)
    remember_positions(after, state)
    save_state(Path(request["statePath"]), state)
    actual = index_snapshot(after)[1].get(created.session_id)
    verified = bool(actual and actual["owned"] and actual["cols"] >= data["minCols"] and actual["rows"] >= data["minRows"]
                    and (after["focusId"] == created.session_id if focus else focus_identity(after) == focus_identity(snapshot) and input_workspace(after) == input_workspace(snapshot)))
    return {"ok": True, "applied": True, "verified": verified, "sessionId": created.session_id,
            "split": c["kind"] == "split", "titleApplied": True, "actual": actual,
            "workspacePreserved": input_workspace(after) == input_workspace(snapshot),
            "focus": {"requested": "focus" if focus else "preserve",
                      "preserved": focus_identity(after) == focus_identity(snapshot),
                      "before": focus_identity(snapshot), "after": focus_identity(after),
                      "effective": "focus" if focus and after["focusId"] == created.session_id else "preserve",
                      "transitioned": focus_identity(after) != focus_identity(snapshot),
                      "reason": "explicit_focus" if focus else "inactive_tab_only" if focus_identity(after) == focus_identity(snapshot) else "focus_changed_during_apply"},
            "reason": "applied" if verified else "focus_changed_or_screen_below_readability_minimum"}


async def reconcile(app, request, state, snapshot):
    plan = request["plan"]
    tabs, sessions = index_snapshot(snapshot)
    sources = {entry["sourceTabId"] for entry in plan["overflow"]} | {entry["tab_id"] for entry in plan["tabs"]}
    for tid in sources:
        require_owned_tab(tabs.get(tid), snapshot["focusId"], protect_focus=True)
        if selected_tab(snapshot, tabs[tid]):
            raise ValueError("selected_tab_protected")
    planned_ids = set()
    for entry in plan["tabs"]:
        ids = validate_tree(entry["root"], tabs[entry["tab_id"]]["cols"], tabs[entry["tab_id"]]["rows"], sessions)
        if planned_ids & ids:
            raise ValueError("duplicate_plan_id")
        planned_ids.update(ids)
    for entry in plan["overflow"]:
        sid = entry["sessionId"]
        if sid not in sessions or not sessions[sid]["owned"] or sid in planned_ids:
            raise ValueError("invalid_overflow_id")
        if sid not in leaf_ids(tabs[entry["sourceTabId"]]["tree"]):
            raise ValueError("overflow_source_mismatch")
        planned_ids.add(sid)
    # 영향을 받는 탭의 모든 세션을 반드시 포함한다.
    expected_ids = {s["id"] for tid in sources for s in tabs[tid]["sessions"]}
    if planned_ids != expected_ids:
        raise ValueError("unaccounted_sessions")
    spec = {"tabs": list(plan["tabs"])}
    placeholders = []
    desired_windows = {tab["id"]: window["id"] for window in snapshot["windows"] for tab in window["tabs"]}
    for entry in plan["overflow"]:
        window = app.get_window_by_id(entry["windowId"])
        if not window or not any(t.tab_id == entry["sourceTabId"] for t in window.tabs):
            raise ValueError("overflow_window_mismatch")
        # 새 탭의 임시 셸 ID는 직접 만든 직후에만 닫기 목록에 넣는다.
        await require_inactive_live(app, sources)
        tab = await window.async_create_tab(command="/bin/sleep 30", select=False)
        placeholder = tab.current_session
        placeholders.append(placeholder.session_id)
        # 비활성 새 탭은 아직 bounds가 0일 수 있어 기존 창 안에서 초기화한다.
        # native split은 창 frame을 바꾸지 않고 현재 window bounds에 맞춘다.
        profile = iterm2.LocalWriteOnlyProfile()
        profile.set_use_custom_command("Yes")
        profile.set_command("/bin/sleep 30")
        await require_inactive_live(app, {tab.tab_id})
        spacer = await placeholder.async_split_pane(vertical=True, profile_customizations=profile)
        placeholders.append(spacer.session_id)
        desired_windows[tab.tab_id] = entry["windowId"]
        spec["tabs"].append({"tab_id": tab.tab_id, "root": {"session_id": entry["sessionId"]}})
    if placeholders:
        spec["close_sessions"] = placeholders
    # placeholder 생성 중 바뀐 소유권/수동 이동도 적용 전에 재확인한다.
    current = await inventory(app, request, state)
    current_tabs, _ = index_snapshot(current)
    for tid in sources:
        require_owned_tab(current_tabs.get(tid), current["focusId"], protect_focus=True)
        if current_tabs[tid]["tree"] != tabs[tid]["tree"]:
            raise ValueError("source_changed_during_apply")
    if focus_identity(current) != focus_identity(snapshot) or input_workspace(current) != input_workspace(snapshot):
        raise ValueError("input_workspace_changed_during_apply")
    current_sessions = index_snapshot(current)[1]
    for entry in plan["tabs"]:
        actual_tab = current_tabs[entry["tab_id"]]
        validate_tree(entry["root"], actual_tab["cols"], actual_tab["rows"], current_sessions)
    await require_inactive_live(app, {entry["tab_id"] for entry in spec["tabs"]})
    await app.async_apply_layout(spec)
    after = await inventory(app, request, state)
    # 예상한 자기 적용만 흡수한다. 동시에 일어난 수동 이동 pin은 지우지 않는다.
    after_tabs, _ = index_snapshot(after)
    actual_windows = {tab["id"]: window["id"] for window in after["windows"] for tab in window["tabs"]}
    for entry in spec["tabs"]:
        tid = entry["tab_id"]
        if (after_tabs.get(tid, {}).get("tree") == entry["root"] and
                actual_windows.get(tid) == desired_windows.get(tid)):
            for sid in leaf_ids(entry["root"]):
                state["records"][sid].pop("pinned", None)
    remember_positions(after, state)
    save_state(Path(request["statePath"]), state)
    actual_tabs, actual_sessions = index_snapshot(after)
    verified = all(actual_tabs.get(t["tab_id"], {}).get("tree") == t["root"] for t in spec["tabs"])
    verified = verified and all(actual_sessions.get(sid, {}).get("owned")
                                and actual_sessions[sid]["cols"] >= (actual_sessions[sid].get("minCols") or 80)
                                and actual_sessions[sid]["rows"] >= (actual_sessions[sid].get("minRows") or 20) for sid in planned_ids)
    verified = verified and focus_identity(after) == focus_identity(snapshot) and input_workspace(after) == input_workspace(snapshot)
    return {"ok": True, "applied": True, "verified": bool(verified), "plan": plan,
            "workspacePreserved": input_workspace(after) == input_workspace(snapshot),
            "focus": {"requested": "preserve", "effective": "preserve",
                      "transitioned": focus_identity(after) != focus_identity(snapshot),
                      "preserved": focus_identity(after) == focus_identity(snapshot),
                      "before": focus_identity(snapshot), "after": focus_identity(after),
                      "reason": "inactive_tab_only" if focus_identity(after) == focus_identity(snapshot) else "focus_changed_during_apply"}}


def global_lock_path():
    # TMPDIR가 다른 프로젝트도 같은 host/iTerm mutation lock을 공유한다.
    directory = Path("/tmp") / f"triflux-{os.getuid()}"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid():
        raise ValueError("unsafe_global_lock_directory")
    directory.chmod(0o700)
    return directory / "iterm-layout-mutation.lock"


@contextlib.asynccontextmanager
async def state_locks(path):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with global_lock_path().open("a") as host, path.with_suffix(".lock").open("a") as project:
        held = []
        try:
            for lock in (host, project):
                while True:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        held.append(lock)
                        break
                    except BlockingIOError:
                        await asyncio.sleep(0.03)
            yield
        finally:
            for lock in reversed(held):
                fcntl.flock(lock, fcntl.LOCK_UN)


async def locked_snapshot(app, request):
    path = Path(request["statePath"])
    async with state_locks(path):
        state = read_state(path, request["project"])
        snapshot = await inventory(app, request, state)
        save_state(path, state)
        return snapshot


async def execute(connection, action, request):
    path = Path(request["statePath"])
    async with state_locks(path):
        state = read_state(path, request["project"])
        app = await iterm2.async_get_app(connection)
        # lock 대기 뒤에만 inventory를 읽어 이전 프로젝트 적용을 반영한다.
        snapshot = await inventory(app, request, state)
        if action == "inventory" and request.get("resetPins"):
            for record in state["records"].values():
                record.pop("pinned", None)
            remember_positions(snapshot, state)
            snapshot = await inventory(app, request, state)
        save_state(path, state)
        if action == "inventory":
            last_path = path.with_suffix(".last.json")
            last = json.loads(last_path.read_text()) if last_path.exists() else None
            return {"ok": True, "snapshot": snapshot, "lastReconcile": last}
        if action not in ("open", "reconcile", "close"):
            raise ValueError("unsupported_action")
        if action != "close" and request.get("expected") != snapshot["fingerprint"]:
            return {"ok": False, "reason": "stale_snapshot", "applied": False, "verified": False, "snapshot": snapshot}
        try:
            if action == "close":
                targets = [s for s in index_snapshot(snapshot)[1].values() if s["owned"]
                           and state["records"].get(s["id"], {}).get("session") == request["session"]
                           and (not request.get("sessionId") or s["id"] == request["sessionId"])]
                for s in targets:
                    await app.get_session_by_id(s["id"]).async_close(force=True)
                    state["records"].pop(s["id"], None)
                save_state(path, state)
                return {"ok": True, "applied": bool(targets), "verified": True, "closedIds": [s["id"] for s in targets]}
            iterm2.capabilities.check_supports_apply_layout(connection)
            if action == "open":
                return await open_view(app, connection, request, state, snapshot)
            return await reconcile(app, request, state, snapshot)
        except Exception as error:
            # rollback이 없으므로 실제 inventory를 포함하고 중복 UI 생성을 재시도하지 않는다.
            after, inventory_error = None, None
            try:
                after = await inventory(app, request, state)
            except Exception as refresh_error:
                inventory_error = type(refresh_error).__name__
            save_state(path, state)
            return {"ok": False, "reason": str(error) if type(error) is ValueError else type(error).__name__,
                    "applied": None, "verified": False, "partialPossible": True,
                    "snapshot": after, "inventoryError": inventory_error}


async def watch(connection, request):
    path = Path(request["statePath"])
    with path.with_suffix(".watch.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        app = await iterm2.async_get_app(connection)
        wake = asyncio.Event()

        async def pump(monitor):
            while True:
                await monitor.async_get()
                wake.set()

        async with iterm2.LayoutChangeMonitor(connection) as layout, iterm2.SessionTerminationMonitor(connection) as termination:
            tasks = [asyncio.create_task(pump(layout)), asyncio.create_task(pump(termination))]
            previous = None
            try:
                while True:
                    with contextlib.suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(wake.wait(), 15)
                    # 이벤트 폭주를 한 번으로 합치고 자기 적용 결과는 fingerprint로 거른다.
                    await asyncio.sleep(0.7)
                    wake.clear()
                    snapshot = await locked_snapshot(app, request)
                    if not any(s["owned"] for w in snapshot["windows"] for t in w["tabs"] for s in t["sessions"]):
                        return
                    if snapshot["fingerprint"] == previous:
                        continue
                    payload = {"action": "reconcile", "project": {"key": request["project"]}, "statePath": str(path)}
                    # 동일 TMPDIR/project가 동일 registry를 선택한다. 원래 statePath는 테스트에서도 보존한다.
                    process = await asyncio.create_subprocess_exec(request["node"], request["module"], json.dumps(payload),
                                                                   stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                    try:
                        stdout, _ = await asyncio.wait_for(process.communicate(), 25)
                        report = json.loads(stdout)
                    except (asyncio.TimeoutError, ValueError):
                        if process.returncode is None:
                            process.kill()
                        await process.wait()
                        report = {"ok": False, "reason": "watch_reconcile_failed"}
                    async with state_locks(path):
                        save_state(path.with_suffix(".last.json"), {"at": time.time(), "result": report})
                    previous = (await locked_snapshot(app, request))["fingerprint"]
            finally:
                for task in tasks:
                    task.cancel()


if __name__ == "__main__":
    action, payload = sys.argv[1:]
    request = json.loads(payload)

    async def main(connection):
        try:
            if action == "watch":
                await watch(connection, request)
            else:
                print(json.dumps(await execute(connection, action, request)))
        except Exception as error:
            result = {"ok": False, "reason": str(error) if type(error) is ValueError else type(error).__name__, "applied": False, "verified": False}
            if action == "watch":
                async with state_locks(Path(request["statePath"])):
                    save_state(Path(request["statePath"]).with_suffix(".last.json"), {"at": time.time(), "result": result})
            else:
                print(json.dumps(result))

    iterm2.run_until_complete(main)
