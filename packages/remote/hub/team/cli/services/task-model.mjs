export function buildTasks(subtasks, workers) {
  return subtasks.map((subtask, index) => ({
    id: `T${index + 1}`,
    title: subtask,
    owner: workers[index]?.name || null,
    status: "pending",
    depends_on: index === 0 ? [] : [`T${index}`],
  }));
}

export function normalizeTaskStatus(action) {
  const value = String(action || "").toLowerCase();
  if (value === "done" || value === "complete" || value === "completed") return "completed";
  if (value === "progress" || value === "in-progress" || value === "in_progress") return "in_progress";
  if (value === "pending") return "pending";
  return null;
}

export function updateTaskStatus(tasks = [], taskId, nextStatus) {
  const normalizedId = String(taskId || "").toUpperCase();
  const target = tasks.find((task) => String(task.id).toUpperCase() === normalizedId);
  if (!target) return { tasks, target: null };

  return {
    target: { ...target, status: nextStatus },
    tasks: tasks.map((task) => (
      String(task.id).toUpperCase() === normalizedId ? { ...task, status: nextStatus } : task
    )),
  };
}
