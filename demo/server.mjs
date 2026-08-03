// A tiny task board: the app under test for the leak-finder demo.
//
// No dependencies and no database — tasks live in memory for the lifetime of
// the process, which is exactly what lets one test leak state into another.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3210);

let nextId = 1;
const tasks = new Map();

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Task board</title>
  </head>
  <body>
    <h1>Task board</h1>
    <form id="new-task">
      <label for="title">Task title</label>
      <input id="title" name="title" autocomplete="off" required />
      <button type="submit">Add task</button>
    </form>
    <p id="count"></p>
    <ul id="tasks"></ul>
    <script type="module">
      const list = document.querySelector("#tasks");
      const count = document.querySelector("#count");

      const api = (path, options) =>
        fetch(path, {
          headers: { "content-type": "application/json" },
          ...options,
        });

      async function render() {
        const tasks = await (await api("/api/tasks")).json();
        count.textContent = "Open tasks: " + tasks.filter((task) => !task.done).length;
        list.replaceChildren(
          ...tasks.map((task) => {
            const item = document.createElement("li");
            const done = document.createElement("input");
            done.type = "checkbox";
            done.checked = task.done;
            done.setAttribute("aria-label", "Done: " + task.title);
            done.addEventListener("change", async () => {
              await api("/api/tasks/" + task.id, {
                method: "PATCH",
                body: JSON.stringify({ done: done.checked }),
              });
              render();
            });
            const title = document.createElement("span");
            title.textContent = task.title;
            const remove = document.createElement("button");
            remove.textContent = "Delete";
            remove.setAttribute("aria-label", "Delete: " + task.title);
            remove.addEventListener("click", async () => {
              await api("/api/tasks/" + task.id, { method: "DELETE" });
              render();
            });
            item.append(done, title, remove);
            return item;
          }),
        );
      }

      document.querySelector("#new-task").addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = document.querySelector("#title");
        await api("/api/tasks", {
          method: "POST",
          body: JSON.stringify({ title: input.value }),
        });
        input.value = "";
        render();
      });

      render();
    </script>
  </body>
</html>
`;

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }
  try {
    return raw === "" ? {} : JSON.parse(raw);
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (url.pathname === "/api/tasks") {
    if (req.method === "GET") {
      send(res, 200, [...tasks.values()]);
      return;
    }
    if (req.method === "POST") {
      const { title } = await readJson(req);
      if (typeof title !== "string" || title.trim() === "") {
        send(res, 400, { error: "title is required" });
        return;
      }
      const task = { id: nextId++, title: title.trim(), done: false };
      tasks.set(task.id, task);
      send(res, 201, task);
      return;
    }
  }

  const id = Number(url.pathname.match(/^\/api\/tasks\/(\d+)$/u)?.[1]);
  const task = tasks.get(id);
  if (task !== undefined) {
    if (req.method === "DELETE") {
      tasks.delete(id);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "PATCH") {
      const { done } = await readJson(req);
      tasks.set(id, { ...task, done: Boolean(done) });
      send(res, 200, tasks.get(id));
      return;
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Task board listening on http://localhost:${PORT}`);
});
