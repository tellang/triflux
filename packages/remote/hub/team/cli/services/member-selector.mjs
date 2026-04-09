export function resolveMember(state, selector) {
  const members = state?.members || [];
  if (!selector) return null;

  const direct = members.find(
    (member) =>
      member.name === selector ||
      member.role === selector ||
      member.agentId === selector,
  );
  if (direct) return direct;

  const workerAlias = /^worker-(\d+)$/i.exec(selector);
  if (workerAlias) {
    const index = parseInt(workerAlias[1], 10) - 1;
    const workers = members.filter((member) => member.role === "worker");
    if (index >= 0 && index < workers.length) return workers[index];
  }

  const numeric = parseInt(selector, 10);
  if (!Number.isNaN(numeric)) {
    const byPane = members.find(
      (member) =>
        member.pane?.endsWith(`.${numeric}`) ||
        member.pane?.endsWith(`:${numeric}`),
    );
    if (byPane) return byPane;
    if (numeric >= 1 && numeric <= members.length) return members[numeric - 1];
  }

  return null;
}

export function toAgentId(cli, target) {
  const suffix = String(target).split(/[:.]/).pop();
  return `${cli}-${suffix}`;
}
