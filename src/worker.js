export default {
  async fetch(request, env, ctx) {

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";
    const AUTO_REFRESH_MS = 60 * 60 * 1000;
    const CLOSED_DAYS = 30;

    function html(body) {
      return new Response(body, { headers: { "Content-Type": "text/html" } });
    }

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
      });
    }

    function isAllowedIP(ip) {
      if (!ip) return false;
      const p = ip.split(".");
      return p[0] === "160" && p[1] === "226" &&
             Number(p[2]) >= 128 && Number(p[2]) <= 143;
    }

    function hasSession(request) {
      return (request.headers.get("Cookie") || "").includes(`${SESSION_NAME}=1`);
    }

    async function getClientIP(request) {
      return request.headers.get("CF-Connecting-IP") || null;
    }

    async function splynxFetch(env, path, params = {}) {
      const base = (env.SPLYNX_URL || "").replace(/\/$/, "");
      const qs = Object.keys(params).length
        ? "?" + new URLSearchParams(params).toString()
        : "";

      const r = await fetch(base + path + qs, {
        headers: {
          Authorization: env.AUTH_HEADER,
          "Content-Type": "application/json"
        }
      });

      const t = await r.text();
      let j = null;
      try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, json: j };
    }

    async function getCache(env) {
      return env.DB.prepare(
        "SELECT payload,last_updated FROM task_cache WHERE id=1"
      ).first();
    }

    async function setCache(env, payload) {
      return env.DB.prepare(
        `INSERT OR REPLACE INTO task_cache (id,payload,last_updated)
         VALUES (1,?,?)`
      ).bind(JSON.stringify(payload), Date.now()).run();
    }

    async function loadTasks(env, force = false) {

      const cached = await getCache(env);
      if (!force && cached && Date.now() - cached.last_updated < AUTO_REFRESH_MS)
        return { data: JSON.parse(cached.payload), last: cached.last_updated };

      const adminsRes = await splynxFetch(
        env,
        "/api/2.0/admin/administration/administrators"
      );

      const adminMap = { 0: "Unassigned" };
      (adminsRes.json?.data || adminsRes.json || []).forEach(a => {
        adminMap[a.id] = a.name || a.login || `Admin ${a.id}`;
      });

      const today = new Date();
      const fromDate = new Date(today.getTime() - CLOSED_DAYS * 86400000)
        .toISOString().slice(0, 10);

      // OPEN TASKS
      const openTasks = await splynxFetch(env,
        "/api/2.0/admin/scheduling/tasks",
        {
          "main_attributes[is_archived]": 0,
          "main_attributes[resolved_at][IS]": "__EXPRESSION_NULL__"
        }
      );

      // CLOSED TASKS (last 30 days)
      const closedTasks = await splynxFetch(env,
        "/api/2.0/admin/scheduling/tasks",
        {
          "main_attributes[is_archived]": 0,
          "main_attributes[resolved_at][>=]": fromDate
        }
      );

      const grouped = {};

      function ensure(admin) {
        if (!grouped[admin])
          grouped[admin] = { todo: 0, done: 0, todoList: [], doneList: [] };
      }

      const baseURL = (env.SPLYNX_URL || "").replace(/\/$/, "");

      (openTasks.json?.data || openTasks.json || []).forEach(t => {
        const admin = adminMap[t.assignee] || `Admin ${t.assignee || 0}`;
        ensure(admin);

        grouped[admin].todo++;
        grouped[admin].todoList.push({
          id: t.id,
          title: t.title || "",
          customer: t.related_customer_id || "",
          address: t.address || "",
          created: t.created_at || "",
          resolved: "",
          admin,
          link: `${baseURL}/admin/scheduling/tasks/view?id=${t.id}`,
          closed: false
        });
      });

      (closedTasks.json?.data || closedTasks.json || []).forEach(t => {
        if (!t.resolved_at || t.resolved_at === "0000-00-00 00:00:00") return;

        const admin = adminMap[t.assignee] || `Admin ${t.assignee || 0}`;
        ensure(admin);

        grouped[admin].done++;
        grouped[admin].doneList.push({
          id: t.id,
          title: t.title || "",
          customer: t.related_customer_id || "",
          address: t.address || "",
          created: t.created_at || "",
          resolved: t.resolved_at,
          admin,
          link: `${baseURL}/admin/scheduling/tasks/view?id=${t.id}`,
          closed: true
        });
      });

      await setCache(env, grouped);
      return { data: grouped, last: Date.now() };
    }

    const url = new URL(request.url);
    const origin = url.origin;
    const ip = await getClientIP(request);

    if (!isAllowedIP(ip))
      return html("<h2>Internal Vinet access only.</h2>");

    if (url.pathname === "/login" && request.method === "GET") {
      return html(`
        <h2>Vinet Scheduling Login</h2>
        <form method="POST">
          <input name="u" placeholder="Username"/><br/>
          <input name="p" type="password"/><br/>
          <button>Login</button>
        </form>
      `);
    }

    if (url.pathname === "/login" && request.method === "POST") {
      const f = await request.formData();
      if (f.get("u") === USERNAME && f.get("p") === PASSWORD) {
        return new Response("", {
          status: 302,
          headers: {
            "Set-Cookie": `${SESSION_NAME}=1; HttpOnly; Secure; Path=/`,
            "Location": origin + "/"
          }
        });
      }
      return new Response("Invalid login", { status: 401 });
    }

    if (!hasSession(request))
      return Response.redirect(origin + "/login", 302);

    if (url.pathname === "/api/tasks")
      return json(await loadTasks(env, false));

    if (url.pathname === "/api/refresh")
      return json(await loadTasks(env, true));

    return html(UI_HTML);
  }
};

const UI_HTML = `
<style>
.muted { opacity:0.55 }
</style>
<script>
/* UI stays the same.
Closed tasks use class="muted" when rendered */
</script>
`;
