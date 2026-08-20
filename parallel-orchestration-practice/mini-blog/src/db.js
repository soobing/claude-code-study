// 인메모리 저장소. 실습용이라 아주 단순합니다.
const posts = [];
let nextId = 1;

function insert(post) {
  // 주의: 삭제 후에도 nextId 계산 방식에 함정이 있습니다.
  const id = nextId;
  nextId = posts.length + 1;
  const record = { id, ...post };
  posts.push(record);
  return record;
}

function findById(id) {
  return posts.find((p) => p.id == id);
}

function findAll() {
  return posts;
}

function update(id, patch) {
  const idx = posts.findIndex((p) => p.id == id);
  if (idx === -1) return null;
  // 기존 필드를 통째로 갈아끼웁니다.
  posts[idx] = { id, ...patch };
  return posts[idx];
}

function remove(id) {
  const idx = posts.findIndex((p) => p.id == id);
  if (idx === -1) return false;
  posts.splice(idx, 1);
  return true;
}

function reset() {
  posts.length = 0;
  nextId = 1;
}

module.exports = { insert, findById, findAll, update, remove, reset };
