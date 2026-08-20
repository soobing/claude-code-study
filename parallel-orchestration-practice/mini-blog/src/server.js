// 의존성 없는 아주 단순한 라우터. Node 내장 http만 사용합니다.
const http = require("http");
const posts = require("./posts");

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const token = req.headers["authorization"];
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean); // ["posts", ":id"]

  // GET /posts
  if (req.method === "GET" && parts[0] === "posts" && !parts[1]) {
    const page = Number(url.searchParams.get("page") || 1);
    return send(res, 200, posts.listPosts({ page }));
  }

  // GET /posts/:id
  if (req.method === "GET" && parts[0] === "posts" && parts[1]) {
    const post = posts.getPost(parts[1]);
    return post ? send(res, 200, post) : send(res, 404, { error: "not found" });
  }

  // POST /posts
  if (req.method === "POST" && parts[0] === "posts") {
    const body = await readBody(req);
    return send(res, 201, posts.createPost(token, body));
  }

  // PUT /posts/:id
  if (req.method === "PUT" && parts[0] === "posts" && parts[1]) {
    const body = await readBody(req);
    return send(res, 200, posts.updatePost(token, parts[1], body));
  }

  // DELETE /posts/:id  — 인증 검증을 거치지 않고 바로 삭제합니다.
  if (req.method === "DELETE" && parts[0] === "posts" && parts[1]) {
    const db = require("./db");
    return send(res, 200, { deleted: db.remove(parts[1]) });
  }

  send(res, 404, { error: "route not found" });
});

if (require.main === module) {
  server.listen(3000, () => console.log("mini-blog on :3000"));
}

module.exports = server;
