#!/usr/bin/env node
// wt-cli.mjs — wt-manager CLI wrapper for Claude Code
// safety-guard가 wt.exe 직접 호출을 차단하므로 이 스크립트를 경유한다.
import { createWtManager } from "../hub/team/wt-manager.mjs";

const [action, ...rest] = process.argv.slice(2);
if (!action) {
  console.error(
    "Usage: node scripts/wt-cli.mjs <action> [json-opts]\n" +
      "Actions: create-tab, split-pane, layout, list, close, close-stale, rename",
  );
  process.exit(1);
}

const opts = rest.length ? JSON.parse(rest.join(" ")) : {};
const wt = createWtManager();

switch (action) {
  case "create-tab": {
    const r = await wt.createTab(opts);
    console.log(JSON.stringify(r));
    break;
  }
  case "split-pane": {
    await wt.splitPane(opts);
    console.log(JSON.stringify({ success: true }));
    break;
  }
  case "layout": {
    const panes = Array.isArray(opts) ? opts : opts.panes;
    const r = await wt.applySplitLayout(panes);
    console.log(JSON.stringify(r || { success: true }));
    break;
  }
  case "list": {
    console.log(JSON.stringify(wt.listTabs()));
    break;
  }
  case "close": {
    await wt.closeTab(opts.title);
    console.log(JSON.stringify({ success: true }));
    break;
  }
  case "close-stale": {
    const closed = await wt.closeStale(opts);
    console.log(JSON.stringify({ success: true, closed }));
    break;
  }
  case "rename": {
    const r = wt.renameTab(opts);
    console.log(JSON.stringify(r));
    break;
  }
  default:
    console.error(`Unknown action: ${action}`);
    process.exit(1);
}
