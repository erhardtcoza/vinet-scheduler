export default {
  async fetch(request, env, ctx) {

    /* ================= CONFIG ================= */

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";
    const AUTO_REFRESH_MS = 60 * 60 * 1000;

    /* ================= HELPERS ================= */

    const html = body =>
      new Response(body, { headers: { "Content-Type": "text/html" } });

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
      });

    const hasSession = req =>
      (req.headers.get("Cookie") || "").includes(`${SESSION_NAME}=1`);

    const getIP = req =>
      req.headers.get("CF-Connecting-IP") || null;

    const isAllowedIP = ip => {
      if (!ip) return false;
      const p = ip.split(".");
      return p[0] === "160" && p[1] === "226" &&
             Number(p[2]) >= 128 && Number(p[2]) <= 143;
    };

    async function splynxFetch(path, params = {}) {
      const base = env.SPLYNX_URL.replace(/\/$/, "");
      const qs = new URLSearchParams(params).toString();
      const url = `${base}${path}${qs ? "?" + qs : ""}`;

      const r = await fetch(url, {
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

    async function getCache() {
      return env.DB.prepare(
        "SELECT payload,last_updated FROM task_cache WHERE id=1"
      ).first();
    }

    async function setCache(payload) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO task_cache (id,payload,last_updated) VALUES (1,?,?)"
      ).bind(JSON.stringify(payload), Date.now()).run();
    }

    /* ================= CORE LOGIC ================= */

    async function loadTasks(force = false) {

      const cached = await getCache();
      if (!force && cached && Date.now() - cached.last_updated < AUTO_REFRESH_MS)
        return { data: JSON.parse(cached.payload), last: cached.last_updated };

      /* --- Admins --- */

      const adminsRes = await splynxFetch(
        "/api/2.0/admin/administration/administrators"
      );

      const adminMap = { 0: "Unassigned" };
      (adminsRes.json?.data || []).forEach(a => {
        adminMap[a.id] = a.name || a.login || `Admin ${a.id}`;
      });

      /* --- Date window --- */

      const since = new Date();
      since.setDate(since.getDate() - 30);
      const sinceStr = since.toISOString().slice(0, 10);

      /* --- Open tasks --- */

      const openRes = await splynxFetch(
        "/api/2.0/admin/scheduling/tasks",
        {
          "main_attributes[is_archived]": 0,
          "main_attributes[resolved_at][IS]": "__EXPRESSION_NULL__"
        }
      );

      /* --- Closed tasks (30 days) --- */

      const closedRes = await splynxFetch(
        "/api/2.0/admin/scheduling/tasks",
        {
          "main_attributes[is_archived]": 0,
          "main_attributes[resolved_at][>=]": sinceStr
        }
      );

      const grouped = {};

      function ensure(admin) {
        if (!grouped[admin])
          grouped[admin] = { todo: 0, done: 0, todoList: [], doneList: [] };
      }

      function normalize(t, closed) {
        const admin = adminMap[t.assignee] || "Unassigned";
        ensure(admin);

        const obj = {
          id: t.id,
          title: t.title || "",
          customer: t.related_customer_id || "",
          address: t.address || "",
          created: t.created_at || "",
          resolved: t.resolved_at || "",
          admin,
          closed,
          link: `${env.SPLYNX_URL.replace(/\/$/, "")}/admin/scheduling/tasks/view?id=${t.id}`
        };

        if (closed) {
          grouped[admin].done++;
          grouped[admin].doneList.push(obj);
        } else {
          grouped[admin].todo++;
          grouped[admin].todoList.push(obj);
        }
      }

      (openRes.json?.data || []).forEach(t => normalize(t, false));
      (closedRes.json?.data || []).forEach(t => normalize(t, true));

      await setCache(grouped);
      return { data: grouped, last: Date.now() };
    }

    /* ================= ROUTING ================= */

    const url = new URL(request.url);
    const origin = url.origin;
    const ip = getIP(request);

    if (!isAllowedIP(ip))
      return html("<h2>Internal access only</h2>");

    if (url.pathname === "/login" && request.method === "GET") {
      return html(`
        <h2>Vinet Scheduling Login</h2>
        <form method="POST">
          <input name="u" placeholder="Username"><br>
          <input name="p" type="password" placeholder="Password"><br>
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
      return json(await loadTasks(false));

    if (url.pathname === "/api/refresh")
      return json(await loadTasks(true));

    return html(UI_HTML);
  }
};

/* ================= UI ================= */

const UI_HTML = `<!doctype html>
<html>
<head>
<title>Vinet Scheduling</title>
<style>
body{font-family:Arial;margin:20px;max-width:1400px;margin:auto}
.header{display:flex;align-items:center;gap:15px}
.logo{height:40px}
.brand{color:#b30000;font-weight:bold;font-size:20px}
.tiles{display:flex;flex-wrap:wrap;gap:15px;margin-top:15px}
.tile{border:1px solid #ddd;padding:15px;border-radius:10px;background:#fafafa;width:230px}
.count{font-size:34px;font-weight:bold;color:#c40000}
.done{font-size:14px;color:#008000}
table{width:100%;border-collapse:collapse;margin-top:20px;font-size:13px}
th,td{padding:6px;border-bottom:1px solid #eee}
tr:hover{background:#f9f9f9}
.muted{opacity:.55}
</style>
</head>

<body>

<div class="header">
  <img class="logo" src="https://static.vinet.co.za/logo.jpeg">
  <span class="brand">Vinet Scheduling</span>
  <button onclick="refresh()">Refresh</button>
  <label>
    <input type="checkbox" id="showClosed"> Show closed (30 days)
  </label>
  <span id="last"></span>
</div>

<div id="tiles" class="tiles"></div>

<table>
<thead>
<tr>
<th>ID</th><th>Client</th><th>Address</th>
<th>Created</th><th>Resolved</th><th>Admin</th><th>Title</th>
</tr>
</thead>
<tbody id="rows"></tbody>
</table>

<script>
let data={},all=[];
let showClosed=JSON.parse(localStorage.getItem("showClosed")||"false");
showClosedEl=document.getElementById("showClosed");
showClosedEl.checked=showClosed;
showClosedEl.onchange=()=>{
  showClosed=showClosedEl.checked;
  localStorage.setItem("showClosed",JSON.stringify(showClosed));
  render();
};

async function load(force){
  const r=await fetch(force?"/api/refresh":"/api/tasks");
  const j=await r.json();
  data=j.data;
  document.getElementById("last").innerText="Updated "+new Date(j.last).toLocaleString();
  render();
}

function refresh(){load(true)}

function render(){
  const tiles=document.getElementById("tiles");
  const rows=document.getElementById("rows");
  tiles.innerHTML="";
  rows.innerHTML="";
  all=[];
  Object.values(data).forEach(a=>{
    a.todoList.forEach(t=>all.push(t));
    if(showClosed) a.doneList.forEach(t=>all.push(t));
  });

  Object.keys(data).forEach(a=>{
    const d=document.createElement("div");
    d.className="tile";
    d.innerHTML=\`
      <b>\${a}</b>
      <div class="count">\${data[a].todo}</div>
      <div class="done">Done: \${data[a].done}</div>\`;
    tiles.appendChild(d);
  });

  all.forEach(t=>{
    const r=document.createElement("tr");
    if(t.closed) r.className="muted";
    r.onclick=()=>window.open(t.link,"_blank");
    r.innerHTML=\`
      <td>\${t.id}</td>
      <td>\${t.customer}</td>
      <td>\${t.address}</td>
      <td>\${t.created}</td>
      <td>\${t.closed?t.resolved:""}</td>
      <td>\${t.admin}</td>
      <td>\${t.title}</td>\`;
    rows.appendChild(r);
  });
}

load(false);
</script>
</body>
</html>`;
