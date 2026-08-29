// ⑭ 데모용 픽스처 — src/api/**(api-conventions.md) 와 *.test.ts(testing.md)
// 두 경로 규칙에 동시에 매칭되고, 같은 디렉토리의 CLAUDE.md도 함께 로드된다.
test("hello handler returns greeting", () => {
  // 실제 테스트가 아니라 경로 규칙/중첩 CLAUDE.md 로드를 시연하기 위한 더미 파일
});
