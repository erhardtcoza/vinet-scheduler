export default {
  async fetch(request, env, ctx) {

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";
    const AUTO_REFRESH_MS = 60 * 60 * 1000; // 1 hour

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

      const admins = await splynxFetch(env, "/api/2.0/admin/administration/administrators");
      const adminMap = { 0: "Unassigned" };

      if (admins.ok) {
        const list = admins.json?.data || admins.json || [];
        for (const a of list) adminMap[a.id] = a.name || a.login || `Admin ${a.id}`;
      }

      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");
      if (!res.ok) throw new Error("Splynx failed");

      const tasks = res.json?.data || res.json || [];
      const grouped = {};

      for (const t of tasks) {

        if (String(t.is_archived) === "1") continue;

        const adminName = adminMap[t.assignee] || `Admin ${t.assignee || 0}`;

        if (!grouped[adminName])
          grouped[adminName] = { todo: 0, done: 0, todoList: [] };

        const isDone = !!(t.resolved_at && t.resolved_at !== "0000-00-00 00:00:00");

        if (isDone) grouped[adminName].done++;
        else {
          grouped[adminName].todo++;
          grouped[adminName].todoList.push({
            id: t.id,
            title: t.title || "",
            customer: t.related_customer_id || "",
            address: t.address || "",
            created: t.created_at || "",
            link: (env.SPLYNX_URL || "").replace(/\/$/, "") +
                  `/admin/scheduling/tasks/view?id=${t.id}`
          });
        }
      }

      await setCache(env, grouped);
      return { data: grouped, last: Date.now() };
    }

    const url = new URL(request.url);
    const origin = url.origin;
    const ip = await getClientIP(request);

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
}

const UI_HTML = `<!doctype html>
<html>
<head>
<title>Vinet Scheduling</title>
<style>
body{font-family:Arial;margin:20px;}
.header{display:flex;align-items:center;gap:20px;}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,260px);gap:15px;margin-top:20px;}
.tile{border:1px solid #ccc;padding:15px;border-radius:8px;cursor:pointer;background:#fafafa;}
.count{font-size:34px;font-weight:bold;color:#c40000;}
.done{font-size:14px;color:#008000;}
.modal,.loading{position:fixed;top:0;left:0;right:0;bottom:0;display:none;align-items:center;justify-content:center;background:#0007;z-index:99;}
.modal-content{background:#fff;padding:20px;border-radius:10px;max-height:90vh;width:85%;overflow:auto;}
#rows td{padding:6px;border-bottom:1px solid #eee;}
</style>
</head>
<body>

<div class="header">
  <h2>Vinet Scheduling</h2>
  <button onclick="refresh()">Refresh</button>
  <span id="last"></span>
</div>

<div class="loading" id="loading"><div style="background:white;padding:20px;border-radius:10px;">Loading...</div></div>

<div id="tiles" class="tiles"></div>

<div id="modal" class="modal">
  <div class="modal-content">
    <button onclick="closeModal()">Close</button>
    <h3 id="mtitle"></h3>
    <table id="rows" width="100%"></table>
  </div>
</div>

<script>
let data={};
let tasks=[];

async function load(force=false){
  document.getElementById("loading").style.display="flex";
  const res=await fetch(force?"/api/refresh":"/api/tasks");
  const j=await res.json();
  data=j.data;
  document.getElementById("last").innerText="Last updated: "+new Date(j.last).toLocaleString();
  renderTiles();
  document.getElementById("loading").style.display="none";
}

function refresh(){ load(true); }

function renderTiles(){
  const t=document.getElementById("tiles");
  t.innerHTML="";
  Object.keys(data).forEach(admin=>{
    const d=document.createElement("div");
    d.className="tile";
    d.innerHTML=\`<b>\${admin}</b>
      <div class="count">\${data[admin].todo}</div>
      <div class="done">Done: \${data[admin].done}</div>\`;
    d.onclick=()=>openModal(admin);
    t.appendChild(d);
  });
}

function openModal(admin){
  tasks=data[admin].todoList;
  document.getElementById("mtitle").innerText=\`\${admin} — To-Do Tasks (\${tasks.length})\`;
  const el=document.getElementById("rows");
  el.innerHTML="";
  tasks.forEach(t=>{
    const r=document.createElement("tr");
    r.onclick=()=>window.open(t.link,"_blank");
    r.innerHTML=\`
      <td>\${t.id}</td>
      <td>\${t.customer}</td>
      <td>\${t.address}</td>
      <td>\${t.created}</td>
      <td>\${t.title}</td>
    \`;
    el.appendChild(r);
  });
  document.getElementById("modal").style.display="flex";
}

function closeModal(){
  document.getElementById("modal").style.display="none";
}

load();
</script>

</body>
</html>`;
