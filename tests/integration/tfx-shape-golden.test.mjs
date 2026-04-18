import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildConsensusEnvelope,
  getShapeContract,
} from "../../hub/team/consensus-meta.mjs";

const GOLDEN_SHAPES = [
  {
    shape: "consensus",
    topic: "merge readiness",
    sections: [
      "## 합의 결과: {topic}",
      "### Consensus Score",
      "### 합의 항목",
      "### disputed items",
      "### resolved items",
      "### user decision needed",
      "### meta judgment",
    ],
    modeSpecificMeta: {
      resolution_threshold: 70,
    },
  },
  {
    shape: "debate",
    topic: "REST vs GraphQL",
    sections: [
      "## 토론 결과: {topic}",
      "### 비교 대상",
      "### 평가 기준",
      "### 합의 사항",
      "### 최종 추천",
      "### 리스크 및 완화 방안",
      "### meta judgment",
    ],
    modeSpecificMeta: {
      ranked_options: ["REST", "GraphQL"],
      winning_option: "REST",
    },
  },
  {
    shape: "panel",
    topic: "monolith split",
    sections: [
      "## 전문가 패널 보고서: {topic}",
      "### 패널 구성",
      "### 패널 합의",
      "### 소수 견해",
      "### 핵심 추천",
      "### 미해결 쟁점",
      "### 다음 단계",
      "### meta judgment",
    ],
    modeSpecificMeta: {
      panel_size: 3,
      expert_distribution: {
        claude: 1,
        codex: 1,
        gemini: 1,
      },
    },
  },
];

describe("Phase 4a golden — tfx-auto consensus shapes", () => {
  for (const golden of GOLDEN_SHAPES) {
    it(`${golden.shape} emits required meta_judgment fields`, () => {
      const envelope = buildConsensusEnvelope({
        shape: golden.shape,
        topic: golden.topic,
        cliSet: "triad",
        participants: ["claude", "codex", "gemini"],
        metaJudgment: {
          severity: {
            p1: [{ id: "p1-1", summary: "blocking issue" }],
            p2: [{ id: "p2-1", summary: "follow-up issue" }],
            p3: [{ id: "p3-1", summary: "polish item" }],
          },
          consensus: {
            agreements: [{ summary: "shared conclusion" }],
            conflicts: [{ summary: "open disagreement", parties: ["claude"] }],
          },
          recommendedAction: "FIX_FIRST",
          followupIssues: ["document rollout"],
          modeSpecificMeta: golden.modeSpecificMeta,
        },
      });

      assert.deepEqual(envelope, {
        mode: "consensus",
        shape: golden.shape,
        topic: golden.topic,
        cli_set: "triad",
        participants: [
          { name: "claude", status: "success" },
          { name: "codex", status: "success" },
          { name: "gemini", status: "success" },
        ],
        status: "complete",
        meta_judgment: {
          severity_classification: {
            p1: [{ id: "p1-1", summary: "blocking issue" }],
            p2: [{ id: "p2-1", summary: "follow-up issue" }],
            p3: [{ id: "p3-1", summary: "polish item" }],
          },
          consensus_vs_dispute: {
            agreements: [{ summary: "shared conclusion" }],
            conflicts: [
              { summary: "open disagreement", parties: ["claude"] },
            ],
          },
          recommended_action: "FIX_FIRST",
          followup_issues: ["document rollout"],
          mode_specific_meta: golden.modeSpecificMeta,
        },
      });

      assert.deepEqual(Object.keys(envelope.meta_judgment), [
        "severity_classification",
        "consensus_vs_dispute",
        "recommended_action",
        "followup_issues",
        "mode_specific_meta",
      ]);
    });

    it(`${golden.shape} exposes the expected markdown contract`, () => {
      const contract = getShapeContract(golden.shape);
      assert.equal(contract.shape, golden.shape);
      assert.deepEqual(contract.required_markdown_sections, golden.sections);
      assert.ok(contract.complexity >= 1);
    });
  }
});
