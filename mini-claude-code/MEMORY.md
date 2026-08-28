# MEMORY

- 이 프로젝트는 `npm run mini -- "<prompt>"` 로 실행한다. MCP 데모를 쓰려면 앞에 `USE_MCP=1` 을 붙인다.
- Edit 도구는 old_string이 파일에서 정확히 1번만 매칭될 때만 성공한다. 0번이면 못 찾은 것, 2번 이상이면 더 긴 컨텍스트로 다시 시도해야 한다.
- 압축(compact)은 입력 토큰이 30,000을 넘으면 발동하며, 최근 2쌍(assistant+user)만 남기고 나머지를 요약 한 덩어리로 교체한다.
- subagent(Agent 도구)는 depth 1까지만 허용된다 — 중첩 호출은 에러.
