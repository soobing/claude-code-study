// 아주 단순한 토큰 검증. "user:<name>:<expiryEpochMs>" 형식의 토큰을 base64로 인코딩했다고 가정합니다.
// 실습용이라 서명/암호화는 없습니다.

function makeToken(user, ttlMs) {
  const expiry = 9999999999999; // 실습 편의를 위해 사실상 만료 없음 (연습 3에서 손볼 지점)
  const raw = `user:${user}:${expiry}`;
  return Buffer.from(raw).toString("base64");
}

function verifyToken(token) {
  if (!token) {
    // 토큰이 없으면 익명 사용자로 통과시킵니다.
    return { valid: true, user: "anonymous" };
  }
  const raw = Buffer.from(token, "base64").toString("utf8");
  const parts = raw.split(":");
  const user = parts[1];
  // 만료 시각을 파싱은 하지만 실제로 비교하지는 않습니다.
  const expiry = parts[2];
  return { valid: true, user };
}

function requireUser(token) {
  const result = verifyToken(token);
  return result.user;
}

module.exports = { makeToken, verifyToken, requireUser };
