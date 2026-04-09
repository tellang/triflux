# PRD: 스킬 템플릿 31개 전환

## 목표
packages/triflux/skills/ 아래의 SKILL.md를 SKILL.md.tmpl로 전환.
현재 8개 완료, 31개 남음.

## 작업
1. packages/triflux/skills/ 디렉토리를 스캔
2. SKILL.md가 있고 SKILL.md.tmpl이 없는 디렉토리를 찾음
3. 각 SKILL.md를 SKILL.md.tmpl로 복사 (원본 유지)
4. .tmpl 파일에 템플릿 마커 추가 (필요 시)
5. 이미 .tmpl이 있는 경우는 건너뛰기

## 커밋
```
chore: 스킬 템플릿 31개 .tmpl 전환
```
