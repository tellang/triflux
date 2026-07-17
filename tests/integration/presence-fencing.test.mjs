import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import { createRouter } from "../../hub/router.mjs";
import { createStore } from "../../hub/store.mjs";
import {
  createMemoryStore,
  createStoreAdapter,
} from "../../hub/store-adapter.mjs";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

const tempDirs = [];

function makeStore() {
  const dir = join(tmpdir(), `tfx-presence-fence-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return createStore(join(dir, "hub.db"));
}

function registration(agentId = "fenced-agent", heartbeat_ttl_ms = 600_000) {
  return {
    agent_id: agentId,
    cli: "codex",
    capabilities: ["code"],
    topics: [],
    heartbeat_ttl_ms,
  };
}

afterEach(() => {
  mock.restoreAll();
  while (tempDirs.length)
    rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("presence fencing", { skip: SQLITE_SKIP }, () => {
  it("late A deregister leaves B online and reports a stale owner", () => {
    const store = makeStore();
    const router = createRouter(store);
    try {
      const first = router.registerAgent(registration()).data;
      const second = router.registerAgent(registration()).data;

      const result = router.transitionAgentStatus(
        "fenced-agent",
        "offline",
        first.presence_generation,
      );

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "STALE_PRESENCE_OWNER");
      assert.equal(store.getAgent("fenced-agent").status, "online");
      assert.equal(
        store.getAgent("fenced-agent").presence_generation,
        second.presence_generation,
      );
    } finally {
      router.stopSweeper();
      store.close();
    }
  });

  it("fake-clock lifecycle interleavings are deterministic and fenced", () => {
    const operations = ["registerB", "heartbeatA", "deregisterA", "sweep"];
    const permutations = (items) =>
      items.length < 2
        ? [items]
        : items.flatMap((item, index) =>
            permutations([
              ...items.slice(0, index),
              ...items.slice(index + 1),
            ]).map((tail) => [item, ...tail]),
          );

    for (const order of permutations(operations)) {
      let now = 1_000;
      mock.method(Date, "now", () => now);
      const store = makeStore();
      const router = createRouter(store);
      try {
        const first = router.registerAgent(
          registration("fenced-agent", 60_000),
        ).data;
        now += 60_001;
        let second = null;

        for (const operation of order) {
          if (operation === "registerB") {
            second = router.registerAgent(registration()).data;
          } else if (operation === "heartbeatA") {
            assert.equal(
              router.refreshAgentLease(
                "fenced-agent",
                60_000,
                first.presence_generation,
              ).data.effective.updated,
              second === null,
            );
          } else if (operation === "deregisterA") {
            assert.equal(
              router.transitionAgentStatus(
                "fenced-agent",
                "offline",
                first.presence_generation,
              ).ok,
              second === null,
            );
          } else {
            store.sweepStaleAgents();
          }
        }

        const persisted = store.getAgent("fenced-agent");
        assert.notEqual(second, null);
        assert.equal(persisted.presence_generation, second.presence_generation);
        assert.equal(persisted.status, "online");
      } finally {
        router.stopSweeper();
        store.close();
        mock.restoreAll();
      }
    }
  });

  it("generation 없는 legacy heartbeat와 status 전이는 통과하고, 제공 시에는 fencing한다", () => {
    const store = makeStore();
    const router = createRouter(store);
    try {
      const first = router.registerAgent(registration()).data;
      assert.equal(router.refreshAgentLease("fenced-agent", 60_000).ok, true);
      assert.equal(router.updateAgentStatus("fenced-agent", "offline"), true);

      const second = router.registerAgent(registration()).data;
      const stale = router.refreshAgentLease(
        "fenced-agent",
        60_000,
        first.presence_generation,
      );
      assert.equal(stale.ok, false);
      assert.equal(stale.error.code, "STALE_PRESENCE_OWNER");
      assert.equal(
        router.updateAgentStatus(
          "fenced-agent",
          "offline",
          first.presence_generation,
        ),
        false,
      );
      assert.equal(
        store.getAgent("fenced-agent").presence_generation,
        second.presence_generation,
      );
      assert.equal(store.getAgent("fenced-agent").status, "online");
    } finally {
      router.stopSweeper();
      store.close();
    }
  });

  it("SQLite와 memory store는 opt-in fencing 및 stale sweep 결과가 같다", () => {
    let now = 1_000;
    mock.method(Date, "now", () => now);
    const summarize = (store) => {
      const first = store.registerAgent(registration("equivalent-agent", 100));
      const legacyHeartbeat = store.refreshLease("equivalent-agent", 100);
      const second = store.registerAgent(registration("equivalent-agent", 100));
      const staleHeartbeat = store.refreshLease(
        "equivalent-agent",
        100,
        first.presence_generation,
      );
      const legacyStatus = store.updateAgentStatus(
        "equivalent-agent",
        "offline",
      );
      const fencedStatus = store.updateAgentStatus(
        "equivalent-agent",
        "offline",
        first.presence_generation,
      );

      store.registerAgent(registration("sweep-agent", 100));
      now += 101;
      const stale = store.sweepStaleAgents();
      now += 300_001;
      const offline = store.sweepStaleAgents();
      return {
        firstGeneration: first.presence_generation,
        secondGeneration: second.presence_generation,
        legacyHeartbeat: legacyHeartbeat.effective.updated,
        staleHeartbeat: staleHeartbeat.effective.updated,
        legacyStatus,
        fencedStatus,
        stale,
        offline,
      };
    };

    const sqlite = makeStore();
    const memory = createMemoryStore();
    try {
      const sqliteResult = summarize(sqlite);
      now = 1_000;
      const memoryResult = summarize(memory);
      assert.deepEqual(memoryResult, sqliteResult);
    } finally {
      sqlite.close();
      memory.close();
    }
  });

  it("rejects a stale caller after a hub restart", () => {
    const store = makeStore();
    const firstHub = createRouter(store);
    try {
      const registered = firstHub.registerAgent(registration()).data;
      const secondHub = createRouter(store);
      try {
        const status = secondHub.getStatus("hub", {
          hub_instance_id: registered.hub_instance_id,
          store_fingerprint: registered.store_fingerprint,
        });
        assert.equal(status.ok, false);
        assert.equal(status.error.code, "STALE_HUB_INSTANCE");

        const heartbeat = secondHub.refreshAgentLease(
          "fenced-agent",
          60_000,
          registered.presence_generation,
          {
            hub_instance_id: registered.hub_instance_id,
            store_fingerprint: registered.store_fingerprint,
          },
        );
        assert.equal(heartbeat.ok, false);
        assert.equal(heartbeat.error.code, "STALE_HUB_INSTANCE");
      } finally {
        secondHub.stopSweeper();
      }
    } finally {
      firstHub.stopSweeper();
      store.close();
    }
  });
});

describe("control-plane durable store gate", () => {
  it("does not disguise a SQLite loader fault as memory-backed CTO registration", async () => {
    const store = await createStoreAdapter("/definitely-unavailable/hub.db", {
      loadDatabase: async () => {
        throw new Error("fault injection");
      },
    });
    const router = createRouter(store);
    try {
      const result = router.registerAgent({
        ...registration("cto-control-plane"),
        capabilities: ["cto"],
        metadata: { role: "cto" },
      });
      assert.equal(store.type, "memory");
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "CONTROL_PLANE_STORE_DEGRADED");
      assert.equal(store.getAgent("cto-control-plane"), null);
    } finally {
      router.stopSweeper();
      store.close();
    }
  });
});
