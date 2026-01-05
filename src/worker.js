export default {
  async fetch(request, env, ctx) {

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";

    const AUTO_REFRESH_MS = 60 * 60 * 1000;
    const ADMIN_CACHE_MS = 24 * 60 * 60 * 1000;

    function html(body) {
      return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      return env.DB.prepare("SELECT payload,last_updated FROM task_cache WHERE id=1").first();
    }

    async function setCache(env, payload) {
      return env.DB.prepare(`
        INSERT OR REPLACE INTO task_cache (id,payload,last_updated)
        VALUES (1,?,?)
      `).bind(JSON.stringify(payload), Date.now()).run();
    }

    async function getAdminCache(env) {
      return env.DB.prepare("SELECT payload,last_updated FROM task_cache WHERE id=2").first();
    }

    async function setAdminCache(env, payload) {
      return env.DB.prepare(`
        INSERT OR REPLACE INTO task_cache (id,payload,last_updated)
        VALUES (2,?,?)
      `).bind(JSON.stringify(payload), Date.now()).run();
    }

    async function loadAdmins(env) {
      const cached = await getAdminCache(env);
      if (cached && Date.now() - cached.last_updated < ADMIN_CACHE_MS)
        return JSON.parse(cached.payload);

      const res = await splynxFetch(env, "/api/2.0/admin/administration/administrators");

      const admins = res.json?.data || res.json || [];
      const map = {};
      for (const a of admins) map[a.id] = a.name || a.login || `Admin #${a.id}`;

      await setAdminCache(env, map);
      return map;
    }

    function duration(from, to) {
      if (!from || !to) return "";
      const ms = new Date(to) - new Date(from);
      if (ms <= 0) return "";
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      return `${h}h ${m}m`;
    }

    async function loadTasks(env, force = false) {

      const cached = await getCache(env);
      if (!force && cached && Date.now() - cached.last_updated < AUTO_REFRESH_MS)
        return { data: JSON.parse(cached.payload), last: cached.last_updated };

      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");
      const admins = await loadAdmins(env);

      const tasks = res.json?.data || res.json || [];

      const grouped = {};

      for (const t of tasks) {

        if (String(t.is_archived) === "1") continue;

        let admin = "Unassigned";
        if (t.assignee) admin = admins[t.assignee] || `Admin #${t.assignee}`;

        if (!grouped[admin]) grouped[admin] = { pending: [], done: [] };

        const obj = {
          id: t.id,
          customer: t.related_customer_id || "",
          address: t.address || "",
          title: t.title || "",
          priority: t.priority || "",
          created: t.created_at || "",
          completed: t.resolved_at || "",
          note: t.description || "",
          sla: duration(t.created_at, t.resolved_at),
          link: (env.SPLYNX_URL || "").replace(/\/$/, "") + `/admin/scheduling/tasks/view?id=${t.id}`
        };

        const isDone = String(t.closed) === "1" || !!t.resolved_at;

        if (isDone) grouped[admin].done.push(obj);
        else grouped[admin].pending.push(obj);
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
<meta charset="UTF-8">
<title>Vinet Scheduling</title>
<style>
body{font-family:Arial;margin:10px;max-width:1300px;margin-left:auto;margin-right:auto;background:#fafafa;}
.header{display:flex;align-items:center;gap:15px;background:#fff;padding:10px 15px;border-radius:10px;border:1px solid #ddd;}
.header img{height:40px;}
.header h2{margin:0;color:#c00000;}
button{background:#c00000;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;}
button:hover{background:#900;}
.summary{margin-top:10px;font-weight:bold;}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:10px;}
.tile{border:1px solid #ddd;padding:12px;border-radius:10px;background:#fff;cursor:grab;}
.tile.hidden{opacity:0.3;}
.count{font-size:26px;font-weight:bold;color:#c00000;}
.meta{font-size:12px;color:#555;}
table{width:100%;border-collapse:collapse;margin-top:10px;background:#fff;font-size:13px;}
td,th{border:1px solid #ddd;padding:6px;}
th{background:#f5f5f5;}
.row-green{background:#e5f8e5;}
.row-yellow{background:#fff7cf;}
.row-red{background:#ffdede;}
.modal{position:fixed;top:0;left:0;right:0;bottom:0;background:#0007;display:none;align-items:center;justify-content:center;}
.modal-content{background:#fff;padding:18px;border-radius:10px;width:92%;max-height:90vh;overflow:auto;}
#spinner{display:none;}
</style>
</head>
<body>

<div class="header">
<img src="https://static.vinet.co.za/logo.jpeg">
<h2>Vinet Scheduling</h2>
<button onclick="refresh()">Refresh</button>
<span id="last"></span>
<span id="spinner">Loading...</span>
</div>

<div id="summary" class="summary"></div>

<div class="tiles" id="tiles"></div>

<h3>All Tasks</h3>
<input id="globalsearch" placeholder="Search client / address / title..." style="width:100%;padding:6px" oninput="renderGlobal()">

<table>
<thead>
<tr>
<th>ID</th>
<th>Client Code</th>
<th>Address</th>
<th>Status</th>
<th>Priority</th>
<th>Created</th>
<th>Completed</th>
<th>SLA</th>
<th>Admin</th>
</tr>
</thead>
<tbody id="globalrows"></tbody>
</table>

<div id="modal" class="modal">
<div class="modal-content">
<button onclick="closeModal()">Close</button>
<h3 id="mtitle"></h3>
<select id="viewmode" onchange="renderRows()">
<option value="pending">Pending</option>
<option value="done">Done</option>
<option value="all">All</option>
</select>
<input id="search" placeholder="Search" oninput="renderRows()">
<table width="100%" id="rows"></table>
</div>
</div>

<script>
let data={};
let tasksFlat=[];
let hiddenAdmins=JSON.parse(localStorage.getItem("hiddenAdmins")||"[]");
let order=JSON.parse(localStorage.getItem("tileOrder")||"[]");
let activeUser="";

async function load(force=false){
document.getElementById("spinner").style.display="inline";
const res=await fetch(force?"/api/refresh":"/api/tasks");
const j=await res.json();
data=j.data;
buildFlat();
renderTiles();
renderGlobal();
document.getElementById("summary").innerText="Total pending: "+tasksFlat.filter(t=>t.status==="Pending").length+" | Done: "+tasksFlat.filter(t=>t.status==="Done").length;
document.getElementById("last").innerText="Last updated: "+new Date(j.last).toLocaleString();
document.getElementById("spinner").style.display="none";
}

function refresh(){ load(true); }

function buildFlat(){
tasksFlat=[];
Object.keys(data).forEach(a=>{
data[a].pending.forEach(t=>tasksFlat.push({...t,admin:a,status:"Pending"}));
data[a].done.forEach(t=>tasksFlat.push({...t,admin:a,status:"Done"}));
});
}

function orderedAdmins(){
const admins=Object.keys(data);
const set=new Set(order);
const existing=order.filter(a=>admins.includes(a));
const missing=admins.filter(a=>!set.has(a));
return [...existing,...missing];
}

function renderTiles(){
const t=document.getElementById("tiles");
t.innerHTML="";
orderedAdmins().forEach(admin=>{
if(!data[admin]) return;
const p=data[admin].pending.length;
const d=data[admin].done.length;
const box=document.createElement("div");
box.className="tile";
box.innerHTML=\`
<b>\${admin}</b>
<div class="count">\${p}</div>
<div class="meta">Done: \${d}</div>
<label><input type="checkbox" \${hiddenAdmins.includes(admin)?"checked":""} onchange="toggleHide('\${admin}')"> Hide</label>
\`;
box.onclick=()=>openModal(admin);
t.appendChild(box);
});
}

function toggleHide(a){
if(hiddenAdmins.includes(a)) hiddenAdmins=hiddenAdmins.filter(x=>x!==a);
else hiddenAdmins.push(a);
localStorage.setItem("hiddenAdmins",JSON.stringify(hiddenAdmins));
renderTiles();renderGlobal();
}

function openModal(a){
activeUser=a;
document.getElementById("mtitle").innerText=a;
renderRows();
document.getElementById("modal").style.display="flex";
}

function closeModal(){document.getElementById("modal").style.display="none";}

function ageColor(d){
const days=(Date.now()-new Date(d))/86400000;
if(days<=3) return "row-green";
if(days<=6) return "row-yellow";
return "row-red";
}

function renderRows(){
const mode=document.getElementById("viewmode").value;
const q=document.getElementById("search").value.toLowerCase();
let arr=[];
if(mode!=="done") arr=arr.concat(data[activeUser].pending.map(t=>({...t,status:"Pending"})));
if(mode!=="pending") arr=arr.concat(data[activeUser].done.map(t=>({...t,status:"Done"})));
arr=arr.filter(t=>
(t.customer+"").toLowerCase().includes(q)||
(t.address||"").toLowerCase().includes(q)||
(t.title||"").toLowerCase().includes(q)
);
const el=document.getElementById("rows");
el.innerHTML="";
arr.forEach(t=>{
const r=document.createElement("tr");
if(t.status==="Pending") r.className=ageColor(t.created);
r.onclick=()=>window.open(t.link,"_blank");
r.innerHTML=\`
<td>\${t.id}</td>
<td>\${t.customer||""}</td>
<td>\${t.address||""}</td>
<td>\${t.status}</td>
<td>\${t.priority||""}</td>
<td>\${t.created||""}</td>
<td>\${t.completed||""}</td>
<td>\${t.sla||""}</td>
\`;
el.appendChild(r);
});
}

function renderGlobal(){
const q=document.getElementById("globalsearch").value.toLowerCase();
const el=document.getElementById("globalrows");
el.innerHTML="";
tasksFlat
.filter(t=>!hiddenAdmins.includes(t.admin))
.filter(t=>
(t.customer+"").toLowerCase().includes(q)||
(t.address||"").toLowerCase().includes(q)||
(t.title||"").toLowerCase().includes(q)
)
.forEach(t=>{
const r=document.createElement("tr");
if(t.status==="Pending") r.className=ageColor(t.created);
r.onclick=()=>window.open(t.link,"_blank");
r.innerHTML=\`
<td>\${t.id}</td>
<td>\${t.customer||""}</td>
<td>\${t.address||""}</td>
<td>\${t.status}</td>
<td>\${t.priority||""}</td>
<td>\${t.created||""}</td>
<td>\${t.completed||""}</td>
<td>\${t.sla||""}</td>
<td>\${t.admin}</td>
\`;
el.appendChild(r);
});
}

load();
</script>

</body>
</html>`;
