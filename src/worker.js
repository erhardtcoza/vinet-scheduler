export default {
  async fetch(request, env, ctx) {

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";
    const AUTO_REFRESH_MS = 60 * 60 * 1000;

    function html(body) {
      return new Response(body, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
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
      return p[0] === "160" && p[1] === "226" && Number(p[2]) >= 128 && Number(p[2]) <= 143;
    }

    function hasSession(req) {
      return (req.headers.get("Cookie") || "").includes(`${SESSION_NAME}=1`);
    }

    async function getIP(req) {
      return req.headers.get("CF-Connecting-IP") || null;
    }

    async function splynxFetch(env, path, opt = {}) {
      const base = (env.SPLYNX_URL || "").replace(/\/$/, "");
      const headers = {
        Authorization: env.AUTH_HEADER || "",
        "Content-Type": "application/json",
        ...(opt.headers || {})
      };
      const r = await fetch(base + path, { ...opt, headers });
      const t = await r.text();
      let j = null;
      try { j = JSON.parse(t); } catch {}
      return { ok: r.ok, status: r.status, json: j, text: t };
    }

    async function getCache(env) {
      return env.DB.prepare("SELECT payload,last_updated FROM task_cache WHERE id=1").first();
    }

    async function setCache(env, payload) {
      return env.DB.prepare(
        `INSERT OR REPLACE INTO task_cache (id,payload,last_updated)
         VALUES (1,?,?)`
      ).bind(JSON.stringify(payload), Date.now()).run();
    }

    async function load(env, force = false) {

      const cached = await getCache(env);
      if (!force && cached && Date.now() - cached.last_updated < AUTO_REFRESH_MS)
        return { data: JSON.parse(cached.payload), last: cached.last_updated };

      // ---- fetch admins ----
      const adminsMap = {};
      {
        const r = await splynxFetch(env, "/api/2.0/admin/administration/administrators");
        if (r.ok) {
          const arr = r.json?.data || r.json || [];
          arr.forEach(a => adminsMap[a.id] = a.name || a.login || ("Admin "+a.id));
        }
      }

      // ---- fetch tasks ----
      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");
      if (!res.ok) throw new Error("Splynx API failed " + res.status);

      const tasks = res.json?.data || res.json || [];

      const grouped = {};

      for (const t of tasks) {

        // skip archived always
        if (String(t.is_archived) === "1") continue;

        // resolve admin name
        let admin = "Unassigned";

        if (t.assignee && adminsMap[t.assignee])
          admin = adminsMap[t.assignee];
        else if (t.assigned_to_title)
          admin = t.assigned_to_title;
        else if (t.assigned_to_name)
          admin = t.assigned_to_name;

        if (!grouped[admin]) grouped[admin] = { todo: 0, done: 0 };

        // ---- KEY RULE ----
        const isDone = !!(t.resolved_at && t.resolved_at !== "");

        if (isDone)
          grouped[admin].done++;
        else
          grouped[admin].todo++;
      }

      await setCache(env, grouped);

      return { data: grouped, last: Date.now() };
    }

    // ---------------- ROUTING ----------------

    const url = new URL(request.url);
    const origin = url.origin;
    const ip = await getIP(request);

    if (!isAllowedIP(ip))
      return html(`<h2>Sorry — this tool is only available inside the Vinet network.</h2>`);

    if (url.pathname === "/login" && request.method === "GET") {
      return html(`
        <h2>Vinet Scheduling Login</h2>
        <form method="POST">
          <input name="u" placeholder="Username"/><br/>
          <input name="p" type="password" placeholder="Password"/><br/>
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
      return new Response("Invalid", { status: 401 });
    }

    if (!hasSession(request))
      return Response.redirect(origin + "/login", 302);

    // debug – keep for now
    if (url.pathname === "/api/debug/sample") {
      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");
      const tasks = res.json?.data || res.json || [];
      return json(tasks.slice(0,5));
    }

    if (url.pathname === "/api/debug/statuses") {
      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");
      const tasks = res.json?.data || res.json || [];
      const map = {};
      for (const t of tasks) {
        const key = t.workflow_status_id;
        map[key] = (map[key] || 0) + 1;
      }
      return json(map);
    }

    if (url.pathname === "/api/tasks")
      return json(await load(env, false));

    if (url.pathname === "/api/refresh")
      return json(await load(env, true));

    return html(UI);
  }
}

const UI = `
<!doctype html>
<html>
<head>
<title>Vinet Scheduling</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>
body{font-family:Arial;margin:15px;}
.header{display:flex;align-items:center;gap:15px;flex-wrap:wrap}
.logo{height:40px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:10px}
.tile{border:1px solid #ddd;border-radius:8px;padding:12px;cursor:pointer;background:#fafafa}
.tile:hover{background:#f0f0f0}
.count{font-size:32px;color:#c00}
#last{font-size:12px;color:#555}
</style>
</head>
<body>

<div class="header">
<img class="logo" src="https://static.vinet.co.za/logo.jpeg"/>
<h2>Vinet Scheduling</h2>
<button onclick="refresh()">Refresh</button>
<span id="last"></span>
</div>

<h4 id="total"></h4>

<div id="tiles" class="tiles"></div>

<script>
async function load(force=false){
 const r = await fetch(force?"/api/refresh":"/api/tasks");
 const j = await r.json();

 document.getElementById("last").innerText =
  "Last updated: "+new Date(j.last).toLocaleString();

 const t=document.getElementById("tiles");
 t.innerHTML="";

 let total=0;

 Object.keys(j.data).forEach(name=>{
   const o=j.data[name];
   total+=o.todo;
   const d=document.createElement("div");
   d.className="tile";
   d.innerHTML=\`
     <b>\${name}</b>
     <div class="count">\${o.todo}</div>
     <div>Done: \${o.done}</div>
   \`;
   t.appendChild(d);
 });

 document.getElementById("total").innerText="Total To-Do: "+total;
}

function refresh(){ load(true); }

load();
</script>

</body>
</html>
`;
