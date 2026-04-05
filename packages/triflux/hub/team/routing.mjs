/**
 * 라우팅 결정 함수
 * @param {object} opts
 * @param {Array<{id:string, description?:string, agent?:string, depends_on?:string[], complexity?:string}>} opts.subtasks
 * @param {string} opts.graph_type - "INDEPENDENT" | "SEQUENTIAL" | "DAG"
 * @param {boolean} opts.thorough - thorough 모드 여부
 * @returns {{
 *   strategy: "quick_single" | "thorough_single" | "quick_team" | "thorough_team" | "batch_single",
 *   reason: string,
 *   dag_width: number,
 *   max_complexity: string,
 *   dagContext: { dag_width: number, levels: Record<number, string[]>, edges: Array<{from:string, to:string}>, max_complexity: string, taskResults: Record<string, *> }
 * }}
 */
export function resolveRoutingStrategy({ subtasks, graph_type, thorough }) {
  const N = subtasks.length;
  if (N === 0) {
    const dagContext = { dag_width: 0, levels: {}, edges: [], max_complexity: 'S', taskResults: {} };
    return { strategy: 'quick_single', reason: 'empty_subtasks', dag_width: 0, max_complexity: 'S', dagContext };
  }

  const { width: dag_width, levels, edges } = computeDagInfo(subtasks, graph_type);
  const max_complexity = getMaxComplexity(subtasks);
  const dagContext = { dag_width, levels, edges, max_complexity, taskResults: {} };
  const isHighComplexity = ['L', 'XL'].includes(max_complexity);
  const allSameAgent = new Set(subtasks.map((s) => s.agent)).size === 1;
  const allSmall = subtasks.every((s) => normalizeComplexity(s.complexity) === 'S');

  // N==1: 단일 태스크
  if (N === 1) {
    if (thorough || isHighComplexity) {
      return {
        strategy: 'thorough_single',
        reason: 'single_high_complexity',
        dag_width,
        max_complexity,
        dagContext,
      };
    }
    return {
      strategy: 'quick_single',
      reason: 'single_low_complexity',
      dag_width,
      max_complexity,
      dagContext,
    };
  }

  // dag_width==1: 사실상 순차 -> single
  if (dag_width === 1) {
    if (thorough || isHighComplexity) {
      return {
        strategy: 'thorough_single',
        reason: 'sequential_chain',
        dag_width,
        max_complexity,
        dagContext,
      };
    }
    return {
      strategy: 'quick_single',
      reason: 'sequential_chain',
      dag_width,
      max_complexity,
      dagContext,
    };
  }

  // 동일 에이전트 + 모두 S: 프롬프트 병합 -> batch single
  if (allSameAgent && allSmall) {
    return {
      strategy: 'batch_single',
      reason: 'same_agent_small_batch',
      dag_width,
      max_complexity,
      dagContext,
    };
  }

  // dag_width >= 2: 팀
  if (thorough || isHighComplexity) {
    return {
      strategy: 'thorough_team',
      reason: 'parallel_high_complexity',
      dag_width,
      max_complexity,
      dagContext,
    };
  }
  return {
    strategy: 'quick_team',
    reason: 'parallel_low_complexity',
    dag_width,
    max_complexity,
    dagContext,
  };
}

/**
 * DAG 정보 계산 — 레벨별 태스크 배열, 간선, 최대 폭
 * @param {Array<{id:string, depends_on?:string[]}>} subtasks
 * @param {string} graph_type
 * @returns {{ width: number, levels: Record<number, string[]>, edges: Array<{from:string, to:string}> }}
 */
function computeDagInfo(subtasks, graph_type) {
  if (graph_type === 'SEQUENTIAL') {
    const levels = {};
    const edges = [];
    subtasks.forEach((t, i) => {
      levels[i] = [t.id];
      if (i > 0) edges.push({ from: subtasks[i - 1].id, to: t.id });
    });
    return { width: 1, levels, edges };
  }
  if (graph_type === 'INDEPENDENT') {
    const levels = { 0: subtasks.map((t) => t.id) };
    return { width: subtasks.length, levels, edges: [] };
  }

  // DAG: 레벨별 계산 (순환 의존 방어)
  const taskLevels = {};
  const visiting = new Set();

  function getLevel(task) {
    if (taskLevels[task.id] !== undefined) return taskLevels[task.id];
    if (visiting.has(task.id)) {
      taskLevels[task.id] = 0; // 순환 끊기
      return 0;
    }
    if (!task.depends_on || task.depends_on.length === 0) {
      taskLevels[task.id] = 0;
      return 0;
    }
    visiting.add(task.id);
    const depLevels = task.depends_on.map((depId) => {
      const dep = subtasks.find((s) => s.id === depId);
      return dep ? getLevel(dep) : 0;
    });
    visiting.delete(task.id);
    taskLevels[task.id] = Math.max(...depLevels) + 1;
    return taskLevels[task.id];
  }

  subtasks.forEach(getLevel);

  // 레벨별 태스크 그룹핑
  const levels = {};
  for (const [id, level] of Object.entries(taskLevels)) {
    if (!levels[level]) levels[level] = [];
    levels[level].push(id);
  }

  // 간선 수집
  const edges = [];
  for (const task of subtasks) {
    if (task.depends_on) {
      for (const depId of task.depends_on) {
        edges.push({ from: depId, to: task.id });
      }
    }
  }

  const width = Math.max(...Object.values(levels).map((arr) => arr.length), 1);
  return { width, levels, edges };
}

/**
 * 선행 태스크의 결과를 dagContext.edges에서 조회하여 반환
 * @param {string} taskId - 조회 대상 태스크 ID
 * @param {{ dagContext?: { edges: Array<{from:string, to:string}>, taskResults: Record<string, *> } }} pipelineState
 * @returns {Record<string, *>} 선행 태스크 ID → 결과 매핑
 */
export function getUpstreamResults(taskId, pipelineState) {
  const ctx = pipelineState?.dagContext;
  if (!ctx) return {};
  const upstreamIds = ctx.edges.filter((e) => e.to === taskId).map((e) => e.from);
  const results = {};
  for (const id of upstreamIds) {
    if (id in (ctx.taskResults || {})) {
      results[id] = ctx.taskResults[id];
    }
  }
  return results;
}

/**
 * 태스크 완료 시 결과를 dagContext에 기록
 * @param {string} taskId - 완료된 태스크 ID
 * @param {*} result - 태스크 결과
 * @param {{ dagContext?: { taskResults: Record<string, *> } }} pipelineState
 * @returns {boolean} 기록 성공 여부
 */
export function updateTaskResult(taskId, result, pipelineState) {
  const ctx = pipelineState?.dagContext;
  if (!ctx) return false;
  if (!ctx.taskResults) ctx.taskResults = {};
  ctx.taskResults[taskId] = result;
  return true;
}

/**
 * 최대 복잡도 추출
 * @param {Array<{complexity?:string}>} subtasks
 * @returns {"S" | "M" | "L" | "XL"}
 */
function getMaxComplexity(subtasks) {
  const order = { S: 0, M: 1, L: 2, XL: 3 };
  let max = 'S';
  for (const s of subtasks) {
    const complexity = normalizeComplexity(s.complexity);
    if (order[complexity] > order[max]) max = complexity;
  }
  return max;
}

/**
 * complexity 기본값 보정
 * @param {string | undefined} complexity
 * @returns {"S" | "M" | "L" | "XL"}
 */
function normalizeComplexity(complexity) {
  return ['S', 'M', 'L', 'XL'].includes(complexity) ? complexity : 'M';
}
