# MEMORY

- 이 프로젝트는 `npm run mini -- "<prompt>"` 로 실행한다. MCP 데모를 쓰려면 앞에 `USE_MCP=1` 을 붙인다.
- Edit 도구는 old_string이 파일에서 정확히 1번만 매칭될 때만 성공한다. 0번이면 못 찾은 것, 2번 이상이면 더 긴 컨텍스트로 다시 시도해야 한다.
- 압축(compact)은 입력 토큰이 30,000을 넘으면 발동하며, 최근 2쌍(assistant+user)만 남기고 나머지를 요약 한 덩어리로 교체한다.
- subagent(Agent 도구)는 depth 1까지만 허용된다 — 중첩 호출은 에러.
- MCP 도구 스키마는 기본적으로 지연 로드된다. `USE_MCP=1`만 주면 이름만 노출되고, 모델이 `ToolSearch`로 찾아야 실제 스키마가 로드된다. `ENABLE_TOOL_SEARCH=false`로 즉시 전부 로드, `ENABLE_TOOL_SEARCH=auto`로 10% 임계값 자동 판단.
- `src/api/` 경로 규칙과 `*.test.ts` 규칙, `src/api/CLAUDE.md`(중첩)는 그 경로의 파일을 Read할 때만 로드되고, 압축 후엔 다시 Read해야 재로드된다 — 데모용 픽스처는 `src/api/hello.test.ts`.
- `/compact` 후 CLAUDE.md·auto memory는 디스크에서 다시 읽고, skill 설명 목록은 사라지며 호출했던 스킬 본문만 재주입된다.
