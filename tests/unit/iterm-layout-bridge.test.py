"""실제 사용자 창에 연결하지 않는 bridge 회귀 검사."""
import asyncio
import copy
import fcntl
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

api = types.ModuleType("iterm2")
api.capabilities = types.SimpleNamespace(check_supports_apply_layout=lambda _: None)
api.async_get_app = AsyncMock()
sys.modules["iterm2"] = api
spec = importlib.util.spec_from_file_location("layout", Path(__file__).parents[2] / "hub/team/iterm-layout.py")
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)


def pane(sid, **extra):
    return dict(id=sid, owned=True, pinned=False, cols=120, rows=40, minCols=100, minRows=28,
                group="g", **extra)


def snapshot():
    return {"project": "p", "focusId": "human", "fingerprint": "v1", "windows": [{"id": "w", "tabs": [
        {"id": "t", "tmux": False, "cols": 241, "rows": 40,
         "sessions": [pane("a"), pane("b")],
         "tree": {"vertical": True, "children": [{"session_id": "a"}, {"session_id": "b"}]}}]}]}


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "state.json"
        self.request = {"statePath": str(self.path), "project": "p", "expected": "v1"}
        self.state = {"project": "p", "records": {"a": {"owner": "secret-owner", "session": "one"}, "b": {"owner": "owner-b", "session": "two"}}}
        layout.save_state(self.path, self.state)
        self.app = types.SimpleNamespace(async_apply_layout=AsyncMock(), async_refresh=AsyncMock(), windows=[], get_session_by_id=lambda _: None)
        lock_patch = patch.object(layout, "global_lock_path", lambda: Path(self.tmp.name) / "host.lock")
        lock_patch.start()
        self.addCleanup(lock_patch.stop)
        api.async_get_app = AsyncMock(return_value=self.app)

    async def test_stale_snapshot_never_mutates(self):
        self.request["expected"] = "old"
        with patch.object(layout, "inventory", AsyncMock(return_value=snapshot())):
            result = await layout.execute(None, "reconcile", self.request)
        self.assertEqual(result["reason"], "stale_snapshot")
        self.assertFalse(result["applied"])
        self.app.async_apply_layout.assert_not_awaited()

    async def test_tmux_unowned_pinned_focused_and_explicit_never_apply(self):
        for case in ["tmux", "unowned", "pinned", "focused", "explicit"]:
            state = snapshot()
            tab = state["windows"][0]["tabs"][0]
            if case == "tmux":
                tab["tmux"] = True
            elif case == "focused":
                state["focusId"] = "a"
            elif case == "unowned":
                tab["sessions"][0]["owned"] = False
            else:
                tab["sessions"][0][case] = True
            request = dict(self.request, plan={"tabs": [{"tab_id": "t", "root": tab["tree"]}], "overflow": []})
            with self.assertRaises(ValueError):
                await layout.reconcile(self.app, request, self.state, state)
        self.app.async_apply_layout.assert_not_awaited()

    async def test_apply_rejects_missing_duplicate_or_foreign_ids_and_size(self):
        for root in [{"session_id": "a"}, {"session_id": "user"},
                     {"vertical": True, "children": [{"session_id": "a"}, {"session_id": "a"}]},
                     {"vertical": False, "children": [{"session_id": "a"}, {"session_id": "b"}]}]:
            request = dict(self.request, plan={"tabs": [{"tab_id": "t", "root": root}], "overflow": []})
            with self.assertRaises(ValueError):
                await layout.reconcile(self.app, request, self.state, snapshot())
        self.app.async_apply_layout.assert_not_awaited()

    async def test_partial_failure_is_not_reported_as_success_or_safe_retry(self):
        self.app.async_apply_layout.side_effect = RuntimeError("partial mutation")
        request = dict(self.request, plan={"tabs": [{"tab_id": "t", "root": snapshot()["windows"][0]["tabs"][0]["tree"]}], "overflow": []})
        with patch.object(layout, "inventory", AsyncMock(return_value=snapshot())):
            result = await layout.execute(None, "reconcile", request)
        self.assertTrue(result["partialPossible"])
        self.assertIsNone(result["applied"])
        self.assertFalse(result["verified"])
        self.assertNotIn("partial mutation", json.dumps(result))
        self.assertEqual(result["snapshot"], snapshot())

    async def test_verified_checks_actual_tree_size_and_focus(self):
        for case in ["ok", "tree", "size", "focus"]:
            state = snapshot()
            after = copy.deepcopy(state)
            if case == "tree":
                after["windows"][0]["tabs"][0]["tree"]["vertical"] = False
            if case == "size":
                after["windows"][0]["tabs"][0]["sessions"][0]["cols"] = 80
            if case == "focus":
                after["focusId"] = "a"
            request = dict(self.request, plan={"tabs": [{"tab_id": "t", "root": state["windows"][0]["tabs"][0]["tree"]}], "overflow": []})
            with patch.object(layout, "inventory", AsyncMock(side_effect=[state, after])), patch.object(layout, "resize_owned_tabs", AsyncMock()):
                result = await layout.reconcile(self.app, request, copy.deepcopy(self.state), state)
            self.assertTrue(result["applied"])
            self.assertEqual(result["verified"], case == "ok")

    async def test_close_uses_registry_and_owner_not_tty_or_session_label_alone(self):
        actual = snapshot()
        actual["windows"][0]["tabs"][0]["sessions"][1]["owned"] = False
        view = types.SimpleNamespace(async_close=AsyncMock())
        self.app.get_session_by_id = lambda _: view
        with patch.object(layout, "inventory", AsyncMock(return_value=actual)):
            result = await layout.execute(None, "close", dict(self.request, session="one", sessionId="a"))
        self.assertEqual(result["closedIds"], ["a"])
        view.async_close.assert_awaited_once_with(force=True)
        view.async_close.reset_mock()
        with patch.object(layout, "inventory", AsyncMock(return_value=actual)):
            result = await layout.execute(None, "close", dict(self.request, session="two", sessionId="b"))
        self.assertEqual(result["closedIds"], [])
        view.async_close.assert_not_awaited()

    async def test_inventory_owner_manual_moves_and_read_only_dimensions(self):
        a = types.SimpleNamespace(session_id="a", grid_size=types.SimpleNamespace(width=241, height=80))
        values = {"user.tfx_project": "p", "user.tfx_group": "g", "user.tfx_session": "one", "user.tfxLayoutOwner": "secret-owner"}
        a.async_get_variable = AsyncMock(side_effect=lambda key: values.get(key))
        root = types.SimpleNamespace(vertical=True, children=[a])
        tab = types.SimpleNamespace(tab_id="t", tmux_connection_id="", root=root, sessions=[a], current_session=a)
        frame = types.SimpleNamespace(origin=types.SimpleNamespace(x=0, y=0), size=types.SimpleNamespace(width=1400, height=1000))
        window = types.SimpleNamespace(window_id="w", tabs=[tab], current_tab=tab, async_get_frame=AsyncMock(return_value=frame))
        app = types.SimpleNamespace(windows=[window], current_terminal_window=window, async_refresh=AsyncMock(), get_session_by_id=lambda sid: a if sid == "a" else None)
        state = copy.deepcopy(self.state)
        state["records"]["a"].update(location=["old-window", "old-tab"])
        result = await layout.inventory(app, self.request, state)
        actual = result["windows"][0]["tabs"][0]
        self.assertFalse(actual["tmux"])
        self.assertTrue(actual["sessions"][0]["owned"])
        self.assertTrue(actual["sessions"][0]["pinned"])
        self.assertEqual((actual["cols"], actual["rows"]), (241, 80))
        self.assertNotIn("secret-owner", json.dumps(result))
        state["records"]["a"].pop("pinned", None)
        layout.save_state(self.path, state)
        with patch.object(api, "async_get_app", AsyncMock(return_value=app)):
            await layout.execute(None, "inventory", self.request)
            self.assertTrue(layout.read_state(self.path, "p")["records"]["a"]["pinned"])
            # 원래 위치로 돌아와도 명시 reset 전까지 pin을 유지한다.
            saved = layout.read_state(self.path, "p")
            saved["records"]["a"]["location"] = ["w", "t"]
            layout.save_state(self.path, saved)
            again = await layout.execute(None, "inventory", self.request)
            self.assertTrue(again["snapshot"]["windows"][0]["tabs"][0]["sessions"][0]["pinned"])
            reset = await layout.execute(None, "inventory", dict(self.request, resetPins=True))
            self.assertFalse(reset["snapshot"]["windows"][0]["tabs"][0]["sessions"][0]["pinned"])
        values["user.tfxLayoutOwner"] = "forged"
        result = await layout.inventory(app, self.request, self.state)
        self.assertFalse(result["windows"][0]["tabs"][0]["sessions"][0]["owned"])

    async def test_normal_close_collapses_tree_without_pinning_survivors(self):
        a = types.SimpleNamespace(session_id="a", grid_size=types.SimpleNamespace(width=120, height=40))
        b = types.SimpleNamespace(session_id="b", grid_size=types.SimpleNamespace(width=120, height=40))
        for view, owner, name in [(a, "secret-owner", "one"), (b, "owner-b", "two")]:
            values = {"user.tfx_project": "p", "user.tfx_group": "g", "user.tfx_session": name, "user.tfxLayoutOwner": owner}
            view.async_get_variable = AsyncMock(side_effect=lambda key, data=values: data.get(key))
        old = {"vertical": True, "children": [{"session_id": "a"}, {"vertical": False, "children": [{"session_id": "b"}, {"session_id": "closed"}]}]}
        frame = types.SimpleNamespace(origin=types.SimpleNamespace(x=0, y=0), size=types.SimpleNamespace(width=1400, height=1000))
        for manual_reshape in [False, True]:
            root = types.SimpleNamespace(vertical=not manual_reshape, children=[a, b])
            tab = types.SimpleNamespace(tab_id="t", tmux_connection_id="", root=root, sessions=[a, b], current_session=a)
            window = types.SimpleNamespace(window_id="w", tabs=[tab], current_tab=tab, async_get_frame=AsyncMock(return_value=frame))
            app = types.SimpleNamespace(windows=[window], current_terminal_window=window, async_refresh=AsyncMock(), get_session_by_id=lambda sid: {"a": a, "b": b}.get(sid))
            state = copy.deepcopy(self.state)
            for record in state["records"].values():
                record.update(location=["w", "t"], order=["a", "b", "closed"], tree=old)
            actual = await layout.inventory(app, self.request, state)
            self.assertEqual([v["pinned"] for v in actual["windows"][0]["tabs"][0]["sessions"]], [manual_reshape, manual_reshape])

    async def test_new_tab_resets_custom_command_and_uses_inactive_creation(self):
        profile = types.SimpleNamespace(set_name=lambda _: None, set_allow_title_setting=lambda _: None,
                                         set_use_custom_command=lambda value: self.assertEqual(value, "No"))
        session = types.SimpleNamespace(session_id="created", async_activate=AsyncMock(), async_set_variable=AsyncMock(), async_set_profile_properties=AsyncMock())
        tab = types.SimpleNamespace(current_session=session, async_set_variable=AsyncMock(), async_set_title=AsyncMock())
        session.tab = tab
        window = types.SimpleNamespace(async_create_tab=AsyncMock(return_value=tab))
        self.app.get_window_by_id = lambda _: window
        request = dict(self.request, session="worker 'quoted'", tmuxPath=sys.executable,
                       candidate={"kind": "tab", "windowId": "w"},
                       input={"mode": "auto", "group": "g", "role": "worker", "human": "unknown", "minCols": 100, "minRows": 28})
        after = snapshot()
        after["windows"][0]["tabs"][0]["sessions"].append(pane("created"))
        with patch.object(api, "LocalWriteOnlyProfile", lambda: profile, create=True), patch.object(layout, "inventory", AsyncMock(return_value=after)):
            result = await layout.open_view(self.app, None, request, self.state, snapshot())
        self.assertTrue(result["verified"])
        session.async_activate.assert_not_awaited()
        self.assertFalse(window.async_create_tab.call_args.kwargs["select"])
        self.assertIn("attach-session", window.async_create_tab.call_args.kwargs["command"])
        session.async_set_profile_properties.assert_awaited_once_with(profile)
        self.assertIn("created", layout.read_state(self.path, "p")["records"])

    async def test_preferred_sizes_preserve_total_grid_and_only_resize_declared_ids(self):
        root = {"vertical": True, "children": [{"session_id": "a"}, {"session_id": "b"}]}
        sizes = layout.preferred_sizes(root, 242, 40)
        self.assertEqual(sizes, {"a": (121, 40), "b": (120, 40)})
        a, b = types.SimpleNamespace(session_id="a"), types.SimpleNamespace(session_id="b")
        tab = types.SimpleNamespace(tab_id="t", sessions=[a, b], async_update_layout=AsyncMock())
        app = types.SimpleNamespace(async_refresh=AsyncMock(), windows=[types.SimpleNamespace(tabs=[tab], current_tab=None)])
        with patch.object(api, "Size", lambda width, height: (width, height), create=True):
            await layout.resize_owned_tabs(app, {"tabs": [{"tab_id": "t", "root": root}]}, {"t": (242, 40)})
        self.assertEqual(a.preferred_size, (121, 40))
        tab.async_update_layout.assert_awaited_once()
        tab.sessions.append(types.SimpleNamespace(session_id="user"))
        tab.async_update_layout.reset_mock()
        with patch.object(api, "Size", lambda width, height: (width, height), create=True), self.assertRaises(ValueError):
            await layout.resize_owned_tabs(app, {"tabs": [{"tab_id": "t", "root": root}]}, {"t": (242, 40)})
        tab.async_update_layout.assert_not_awaited()

    async def test_selected_tab_other_pane_and_new_window_are_rejected_without_mutation(self):
        state = snapshot()
        state["windows"][0]["tabs"][0]["selected"] = True
        for candidate in [{"kind": "split", "tabId": "t", "sessionId": "b", "vertical": True}, {"kind": "window"}]:
            request = dict(self.request, candidate=candidate, session="new", tmuxPath=sys.executable,
                           input={"mode": "auto", "group": "g", "minCols": 80, "minRows": 20})
            with self.assertRaises(ValueError):
                await layout.open_view(self.app, None, request, self.state, state)
        plan = {"tabs": [{"tab_id": "t", "root": state["windows"][0]["tabs"][0]["tree"]}], "overflow": []}
        with self.assertRaises(ValueError):
            await layout.reconcile(self.app, dict(self.request, plan=plan), self.state, state)
        self.app.async_apply_layout.assert_not_awaited()

    async def test_compact_inactive_split_keeps_focus_without_activation(self):
        before = snapshot()
        source = before["windows"][0]["tabs"][0]
        source.update(cols=121, rows=10, sessions=[dict(pane("a"), cols=121, rows=10, minCols=60, minRows=10)], tree={"session_id": "a"})
        after = copy.deepcopy(before)
        source_after = after["windows"][0]["tabs"][0]
        source_after["tree"] = {"vertical": True, "children": [{"session_id": "a"}, {"session_id": "created"}]}
        source_after["sessions"] = [dict(pane(sid), cols=60, rows=10, minCols=60, minRows=10) for sid in ["a", "created"]]
        created = types.SimpleNamespace(session_id="created", async_activate=AsyncMock())
        target = types.SimpleNamespace(async_split_pane=AsyncMock(return_value=created))
        self.app.get_session_by_id = lambda _: target
        self.app.windows = [types.SimpleNamespace(current_tab=types.SimpleNamespace(tab_id="human-tab"))]
        self.state["records"]["created"] = {"session": "new"}
        profile = types.SimpleNamespace(set_use_custom_command=lambda _: None, set_command=lambda _: None)
        request = dict(self.request, session="new", tmuxPath=sys.executable,
                       candidate={"kind": "split", "tabId": "t", "sessionId": "a", "vertical": True},
                       input={"mode": "auto", "group": "g", "minCols": 60, "minRows": 10})
        with patch.object(api, "LocalWriteOnlyProfile", lambda: profile, create=True), patch.object(layout, "mark", AsyncMock()), patch.object(layout, "inventory", AsyncMock(return_value=after)):
            result = await layout.open_view(self.app, None, request, self.state, before)
        self.assertTrue(result["verified"])
        self.assertTrue(result["focus"]["preserved"])
        created.async_activate.assert_not_awaited()
        target.async_split_pane.assert_awaited_once()

    async def test_unexpected_manual_move_during_apply_keeps_persistent_pin(self):
        before = snapshot()
        after = snapshot()
        after["windows"][0]["tabs"][0].update(tree={"session_id": "a"}, sessions=[pane("a")])
        after["windows"][0]["tabs"].append({"id": "manual-tab", "tmux": False, "sessions": [pane("b")], "tree": {"session_id": "b"}})
        state = copy.deepcopy(self.state)
        reads = 0
        async def read(*_):
            nonlocal reads
            reads += 1
            if reads == 1:
                return before
            state["records"]["b"]["pinned"] = True
            return after
        request = dict(self.request, plan={"tabs": [{"tab_id": "t", "root": before["windows"][0]["tabs"][0]["tree"]}], "overflow": []})
        with patch.object(layout, "inventory", read), patch.object(layout, "resize_owned_tabs", AsyncMock()):
            result = await layout.reconcile(self.app, request, state, before)
        self.assertFalse(result["verified"])
        self.assertTrue(layout.read_state(self.path, "p")["records"]["b"]["pinned"])

    async def test_explicit_focus_activates_only_the_requested_created_view(self):
        created = types.SimpleNamespace(session_id="created", async_activate=AsyncMock())
        window = types.SimpleNamespace(async_create_tab=AsyncMock(return_value=types.SimpleNamespace(current_session=created)))
        self.app.get_window_by_id = lambda _: window
        self.state["records"]["created"] = {"session": "new"}
        request = dict(self.request, session="new", tmuxPath=sys.executable,
                       candidate={"kind": "tab", "windowId": "w"},
                       input={"mode": "tab", "group": "g", "focusPolicy": "focus", "minCols": 80, "minRows": 20})
        after = snapshot()
        after["focusId"] = "created"
        after["windows"][0]["tabs"][0]["sessions"].append(pane("created"))
        with patch.object(layout, "mark", AsyncMock()), patch.object(layout, "inventory", AsyncMock(return_value=after)):
            result = await layout.open_view(self.app, None, request, self.state, snapshot())
        created.async_activate.assert_awaited_once_with(select_tab=True, order_window_front=True)
        self.assertFalse(window.async_create_tab.call_args.kwargs["select"])
        self.assertEqual(result["focus"]["requested"], "focus")
        self.assertEqual(result["focus"]["effective"], "focus")
        self.assertTrue(result["focus"]["transitioned"])
        self.assertTrue(result["verified"])

    async def test_overflow_creates_inactive_tab_and_excludes_selected_tab_from_spec(self):
        state = snapshot()
        after = snapshot()
        source = after["windows"][0]["tabs"][0]
        source["sessions"] = [pane("a")]
        source["tree"] = {"session_id": "a"}
        after["windows"][0]["tabs"].append({"id": "new-tab", "tmux": False, "cols": 241, "rows": 40,
                                            "sessions": [pane("b")], "tree": {"session_id": "b"}})
        created_tab = types.SimpleNamespace(tab_id="new-tab", current_session=types.SimpleNamespace(session_id="placeholder"))
        window = types.SimpleNamespace(current_tab=types.SimpleNamespace(tab_id="human-tab"),
                                       tabs=[types.SimpleNamespace(tab_id="t"), created_tab],
                                       async_create_tab=AsyncMock(return_value=created_tab))
        self.app.windows = [window]
        self.app.get_window_by_id = lambda _: window
        plan = {"tabs": [{"tab_id": "t", "root": {"session_id": "a"}}],
                "overflow": [{"sessionId": "b", "windowId": "w", "sourceTabId": "t"}]}
        with patch.object(layout, "inventory", AsyncMock(side_effect=[state, after])):
            result = await layout.reconcile(self.app, dict(self.request, plan=plan), self.state, state)
        self.assertTrue(result["verified"])
        self.assertFalse(window.async_create_tab.call_args.kwargs["select"])
        spec = self.app.async_apply_layout.call_args.args[0]
        self.assertEqual({entry["tab_id"] for entry in spec["tabs"]}, {"t", "new-tab"})
        self.assertEqual(spec["close_sessions"], ["placeholder"])
        self.assertNotIn("human-tab", json.dumps(spec))

    async def test_human_tab_switch_immediately_before_apply_aborts_without_restore(self):
        state = snapshot()
        tab = types.SimpleNamespace(tab_id="t")
        self.app.windows = [types.SimpleNamespace(current_tab=tab)]
        request = dict(self.request, plan={"tabs": [{"tab_id": "t", "root": state["windows"][0]["tabs"][0]["tree"]}], "overflow": []})
        with patch.object(layout, "inventory", AsyncMock(return_value=state)), self.assertRaisesRegex(ValueError, "selected_tab_protected"):
            await layout.reconcile(self.app, request, self.state, state)
        self.app.async_apply_layout.assert_not_awaited()

    async def test_compact_contract_accepts_60_by_10_and_rejects_smaller(self):
        sessions = {"a": dict(pane("a"), minCols=60, minRows=10)}
        self.assertEqual(layout.validate_tree({"session_id": "a"}, 60, 10, sessions), {"a"})
        for cols, rows in [(59, 10), (60, 9)]:
            with self.assertRaises(ValueError):
                layout.validate_tree({"session_id": "a"}, cols, rows, sessions)

    async def test_global_lock_serializes_projects_and_refreshes_after_wait(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def read(_app, request, _state):
            calls.append(request["project"])
            if request["project"] == "p":
                entered.set()
                await release.wait()
                return snapshot()
            return dict(snapshot(), fingerprint="after_other_project")
        with patch.object(layout, "inventory", read):
            first = asyncio.create_task(layout.execute(None, "inventory", self.request))
            await entered.wait()
            other = dict(self.request, project="q", statePath=str(self.path.parent / "q.json"))
            second = asyncio.create_task(layout.execute(None, "reconcile", other))
            await asyncio.sleep(0.01)
            self.assertEqual(calls, ["p"])
            release.set()
            await first
            result = await second
        self.assertEqual(calls, ["p", "q"])
        self.assertEqual(result["reason"], "stale_snapshot")
        self.assertEqual(result["snapshot"]["fingerprint"], "after_other_project")
        self.app.async_apply_layout.assert_not_awaited()

    async def test_watcher_duplicate_and_no_managed_views_exit_without_reconcile(self):
        with self.path.with_suffix(".watch.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            api.async_get_app.reset_mock()
            await layout.watch(None, self.request)
            api.async_get_app.assert_not_awaited()

        class Monitor:
            def __init__(self, _):
                self.first = True
            async def __aenter__(self):
                return self
            async def __aexit__(self, *_):
                pass
            async def async_get(self):
                if self.first:
                    self.first = False
                    return
                await asyncio.Event().wait()

        actual_sleep = asyncio.sleep
        async def immediate(_):
            await actual_sleep(0)

        with patch.object(api, "LayoutChangeMonitor", Monitor, create=True), patch.object(api, "SessionTerminationMonitor", Monitor, create=True), patch.object(layout, "inventory", AsyncMock(return_value={"windows": []})), patch.object(layout.asyncio, "sleep", immediate), patch.object(layout.asyncio, "create_subprocess_exec", AsyncMock()) as launch:
            await asyncio.wait_for(layout.watch(None, self.request), 1)
            launch.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
