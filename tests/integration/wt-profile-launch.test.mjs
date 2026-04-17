import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { createWtManager } from "../../hub/team/wt-manager.mjs";

/**
 * Windows Terminal 프로필 실행 및 관리 통합 테스트
 * 실제 Windows 환경에서 wt.exe가 설치되어 있어야 정상 동작함.
 */
describe("wt-profile-launch integration", {
  skip: process.platform !== "win32" || !process.env.TFX_INTEGRATION_TESTS,
}, () => {
  const wt = createWtManager();
  const testTitle = `tfx-test-${Date.now()}`;

  // 테스트 종료 후 탭 정리 보장
  after(async () => {
    try {
      await wt.closeTab(testTitle);
    } catch {
      /* ignore */
    }
  });

  it("1. createTab으로 triflux 프로필 탭 생성 -> success: true 반환 확인", async () => {
    // triflux 프로필로 탭 생성 시도
    // profile이 지정되면 wt-manager는 내부적으로 ensureWtProfile()을 호출하여 설정을 보장함.
    const result = await wt.createTab({
      title: testTitle,
      profile: "triflux",
      command: "echo 'Triflux Profile Test'; Start-Sleep -Seconds 2",
    });

    assert.strictEqual(
      result.success,
      true,
      "탭 생성 결과가 success: true여야 함",
    );
    assert.strictEqual(
      result.title,
      testTitle,
      "반환된 타이틀이 요청한 타이틀과 일치해야 함",
    );
    assert.ok(
      typeof result.pid === "number" && result.pid > 0,
      "유효한 프로세스 PID가 반환되어야 함",
    );

    // 탭 목록에 포함되어 있는지 확인
    const tabs = wt.listTabs();
    const found = tabs.find((t) => t.title === testTitle);
    assert.ok(found, "생성된 탭이 관리 목록(listTabs)에 존재해야 함");
  });

  it("2. 생성된 탭 정리 (closeTab) -> 정상 종료 확인", async () => {
    await wt.closeTab(testTitle);

    // 탭 목록에서 제거되었는지 확인
    const tabs = wt.listTabs();
    const found = tabs.find((t) => t.title === testTitle);
    assert.strictEqual(
      found,
      undefined,
      "closeTab 후에는 탭이 목록에서 제거되어야 함",
    );
  });
});
