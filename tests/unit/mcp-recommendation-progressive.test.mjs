import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";

test("Progressive recommendations overlap while pane dispatch order stays stable", async (t) => {
  const key = `__mcpProgressive${process.pid}`;
  const state = { started: [], pending: [], released: false, commands: [] };
  globalThis[key] = state;
  const recommendationModule = `
    export { formatMcpRecommendation } from ${JSON.stringify(new URL("../../hub/lib/mcp-recommendations.mjs", import.meta.url).href)};
    export function recommendMcp(input) {
      const state = globalThis[${JSON.stringify(key)}];
      state.started.push(input.task);
      const value = { cli:'claude', status:'recommended', applied:false,
        recommendations:[{id:input.task,source:{id:'local',url:'file:///fixture'},confidence:.96,installationStatus:'unknown'}] };
      return state.released ? Promise.resolve(value) : new Promise(resolve => state.pending.push(() => resolve(value)));
    }
  `;
  const psmuxModule = `
    const state = globalThis[${JSON.stringify(key)}];
    export const createPsmuxSession = sessionName => ({sessionName,panes:[]});
    export const psmuxExec = () => 'fixture:0.1';
    export const dispatchCommand = (_session,_pane,command) => { state.commands.push(command); return {}; };
    export const startCapture = () => {};
    export const killPsmuxSession = () => {};
    export const capturePsmuxPane = () => '';
    export const psmuxSessionExists = () => true;
    export const waitForCompletion = () => {};
  `;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith("headless.mjs?mcp-progressive")) {
        const source =
          specifier === "../lib/mcp-recommendations.mjs"
            ? recommendationModule
            : specifier === "./psmux.mjs"
              ? psmuxModule
              : null;
        if (source)
          return {
            url: `data:text/javascript,${encodeURIComponent(source)}`,
            shortCircuit: true,
          };
      }
      return next(specifier, context);
    },
  });
  t.after(() => {
    hook.deregister();
    delete globalThis[key];
  });
  const { runHeadless, headlessResultsIndexPath } = await import(
    "../../hub/team/headless.mjs?mcp-progressive"
  );
  const session = `mcp-progressive-${process.pid}`;
  t.after(() => {
    rmSync(headlessResultsIndexPath(session), { force: true });
    for (const command of state.commands) {
      const file = command.match(/(\/[^\s'"]*prompt-[a-f0-9-]+\.txt)/i)?.[1];
      if (file) rmSync(file, { force: true });
    }
  });
  const pending = runHeadless(
    session,
    ["first", "second", "third"].map((prompt) => ({ cli: "claude", prompt })),
    {
      _deps: { applyTrifluxTheme() {}, awaitAll: () => [] },
    },
  );
  try {
    assert.deepEqual([...state.started], ["first", "second", "third"]);
    assert.equal(state.commands.length, 0);
  } finally {
    state.released = true;
    for (const resolve of state.pending.toReversed()) resolve();
    const result = await pending;
    result.sessionOwnership.release();
  }
  assert.equal(state.commands.length, 3);
  for (const [index, id] of ["first", "second", "third"].entries()) {
    const file = state.commands[index].match(
      /(\/[^\s'"]*prompt-[a-f0-9-]+\.txt)/i,
    )?.[1];
    assert.ok(readFileSync(file, "utf8").includes(`"id":"${id}"`));
  }
});
