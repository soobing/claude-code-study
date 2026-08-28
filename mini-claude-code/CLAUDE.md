# mini-claude-code

Claude Code 내부 동작(에이전트 루프, 훅, 스킬, MCP, 서브에이전트, 압축, 컨텍스트 초기 로드)을
최소 구현으로 재현해보는 학습용 프로젝트.

## 실행

```bash
npm run mini -- "src 구조 보고 README 만들어줘"
USE_MCP=1 npm run mini -- "지금 몇 시야?"
```

## 코드 스타일

- 한국어 주석으로 각 계층(①~⑩)이 실제 Claude Code의 어떤 개념에 대응하는지 표시한다.
- 새 개념을 추가할 때는 `index.ts` 상단 헤더 주석 목록에도 항목을 추가한다.
