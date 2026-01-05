export default {
  async fetch(request, env, ctx) {

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";
    const AUTO_REFRESH_MS = 60 * 60 * 1000;

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
      return p[0] === "160" && p[1] === "226" && Number(p[2]) >= 128 && Number(p[2]) <= 143;
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

    async function loadAdmins(env) {
      const res = await splynxFetch(env, "/api/2.0/admin/administration/administrators");
      const list = res.json?.data || res.json || [];
      const map = {};
      list.forEach(a => map[a.id] = a.name || a.login || `Admin #${a.id}`);
      return map;
    }

    async function loadTasks(env, force = false) {

      const cached = await getCache(env);
      if (!force && cached && Date.now() - cached.last_updated < AUTO_REFRESH_MS)
        return { data: JSON.parse(cached.payload), last: cached.last_updated };

      const admins = await loadAdmins(env);

      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");
      if (!res.ok) throw new Error("Splynx failure");

      const tasks = res.json?.data || res.json || [];

      const grouped = {};
      const all = [];

      function normalize(s) {
        return (s || "").toString().trim().toLowerCase();
      }

      const isDone = s =>
        ["done", "completed"].includes(normalize(s));

      for (const t of tasks) {

        const status =
          t.status_name ||
          t.workflow_status_name ||
          t.workflow_status ||
          "";

        if (normalize(status) === "to archive") continue;
        if (String(t.is_archived) === "1") continue;

        if (isDone(status)) continue; // 🚀 ignore done completely

        let admin = "Unassigned";
        if (t.assignee) admin = admins[t.assignee] || `Admin #${t.assignee}`;

        if (!grouped[admin]) grouped[admin] = [];

        const obj = {
          id: t.id,
          customer: t.related_customer_id || "",
          address: t.address || "",
          title: t.title || "",
          priority: t.priority || "",
          created: t.created_at || t.date_created || "",
          status,
          admin,
          link: (env.SPLYNX_URL || "").replace(/\/$/, "") + `/admin/scheduling/tasks/view?id=${t.id}`
        };

        grouped[admin].push(obj);
        all.push(obj);
      }

      const payload = { grouped, all };

      await setCache(env, payload);

      return { data: payload, last: Date.now() };
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


const UI_HTML = `
<!doctype html>
<html>
<head>
<title>Vinet Scheduling</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:Arial;margin:15px;}
.header{display:flex;align-items:center;gap:15px;flex-wrap:wrap;}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:10px;}
.tile{border:1px solid #ccc;border-radius:10px;padding:10px;background:#fafafa}
.count{font-size:28px;font-weight:bold;color:#c00}
.hidebox{font-size:12px}
table{width:100%;border-collapse:collapse;margin-top:10px}
td,th{border-bottom:1px solid #ddd;padding:6px}
.row{cursor:pointer}
#spinner{display:none}
</style>
</head>
<body>

<div class="header">
  <img src="https://static.vinet.co.za/logo.jpeg" height="40">
  <h2>Vinet Scheduling</h2>
  <button onclick="refresh()">Refresh</button>
  <span id="last"></span>
  <span id="spinner">Loading…</span>
</div>

<div id="summary"></div>

<div id="tiles" class="tiles"></div>

<h3>All Pending Tasks</h3>
<input id="search" placeholder="Search client / address / title..." style="width:100%;padding:6px" oninput="renderAll()"/>

<table>
<thead>
<tr>
<th>ID</th>
<th>Client Code</th>
<th>Address</th>
<th>Status</th>
<th>Priority</th>
<th>Created</th>
<th>Admin</th>
</tr>
</thead>
<tbody id="allrows"></tbody>
</table>

<script>
let data={grouped:{},all:[]};

async function load(force=false){
  spinner(true);
  const r=await fetch(force?"/api/refresh":"/api/tasks");
  const j=await r.json();
  data=j.data;
  document.getElementById("last").innerText="Last updated: "+new Date(j.last).toLocaleString();
  renderTiles();
  renderAll();
  spinner(false);
}

function spinner(b){document.getElementById("spinner").style.display=b?"inline":"none";}

function refresh(){ load(true); }

function renderTiles(){
  const t=document.getElementById("tiles");
  const s=document.getElementById("summary");

  let tp=0;
  t.innerHTML="";
  Object.keys(data.grouped).forEach(a=>{
    const pending=data.grouped[a].length;
    tp+=pending;

    const d=document.createElement("div");
    d.className="tile";
    d.innerHTML=\`
      <b>\${a}</b><br>
      <span class="count">\${pending}</span><br>
      <label class="hidebox"><input type="checkbox" onchange="toggleHide('\${a}')" /> Hide</label>
    \`;
    t.appendChild(d);
  });

  s.innerHTML=\`<b>Total pending:</b> \${tp}\`;
}

function toggleHide(a){
  const h=JSON.parse(localStorage.getItem("hiddenAdmins")||"[]");
  if(h.includes(a)) localStorage.setItem("hiddenAdmins",JSON.stringify(h.filter(x=>x!==a)));
  else{h.push(a);localStorage.setItem("hiddenAdmins",JSON.stringify(h));}
  renderAll();
}

function renderAll(){
  const q=document.getElementById("search").value.toLowerCase();
  const el=document.getElementById("allrows");
  const hidden=JSON.parse(localStorage.getItem("hiddenAdmins")||"[]");

  el.innerHTML="";
  data.all.filter(t=>
    !hidden.includes(t.admin) &&
    ((t.title||"").toLowerCase().includes(q) ||
     (t.address||"").toLowerCase().includes(q) ||
     (t.customer||"").toString().includes(q))
  ).forEach(t=>{
    const r=document.createElement("tr");
    r.className="row";
    r.onclick=()=>window.open(t.link,"_blank");
    r.innerHTML=\`
      <td>\${t.id}</td>
      <td>\${t.customer}</td>
      <td>\${t.address}</td>
      <td>\${t.status}</td>
      <td>\${t.priority}</td>
      <td>\${t.created}</td>
      <td>\${t.admin}</td>
    \`;
    el.appendChild(r);
  });
}

load();
</script>

</body>
</html>
`;
