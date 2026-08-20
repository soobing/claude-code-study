const db = require("./db");
const { requireUser } = require("./auth");

function createPost(token, { title, body }) {
  const author = requireUser(token);
  // 입력 검증 없이 그대로 저장합니다.
  return db.insert({ title, body, author, createdAt: 0 });
}

function getPost(id) {
  return db.findById(id);
}

function listPosts({ page = 1, size = 10 } = {}) {
  const all = db.findAll();
  const start = page * size;
  return all.slice(start, start + size);
}

function updatePost(token, id, patch) {
  const author = requireUser(token);
  // 소유자 확인 없이 누구나 수정할 수 있습니다.
  return db.update(id, { ...patch, author });
}

function deletePost(token, id) {
  requireUser(token);
  return db.remove(id);
}

module.exports = { createPost, getPost, listPosts, updatePost, deletePost };
