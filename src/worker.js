export default {
  async fetch(request, env, ctx) {

    const USERNAME = "vinet";
    const PASSWORD = "Vinet007!";
    const SESSION_NAME = "vinet_session";

    const AUTO_REFRESH_MS = 60 * 60 * 1000;   // 1 hour
    const ADMIN_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

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

    async function getAdminCache(env) {
      return env.DB.prepare(
        "SELECT payload,last_updated FROM task_cache WHERE id=2"
      ).first();
    }

    async function setAdminCache(env, payload) {
      return env.DB.prepare(
        `INSERT OR REPLACE INTO task_cache (id,payload,last_updated)
         VALUES (2,?,?)`
      ).bind(JSON.stringify(payload), Date.now()).run();
    }

    async function loadAdmins(env) {

      const cached = await getAdminCache(env);

      if (cached && Date.now() - cached.last_updated < ADMIN_CACHE_MS)
        return JSON.parse(cached.payload);

      const res = await splynxFetch(env, "/api/2.0/admin/administration/administrators");

      if (!res.ok) throw new Error("Admin load failed");

      const admins = res.json?.data || res.json || [];

      const map = {};
      for (const a of admins) map[a.id] = a.name || a.login || `Admin #${a.id}`;

      await setAdminCache(env, map);

      return map;
    }

    async function loadTasks(env, force = false) {

      const cached = await getCache(env);

      if (!force && cached && Date.now() - cached.last_updated < AUTO_REFRESH_MS)
        return { data: JSON.parse(cached.payload), last: cached.last_updated };

      const res = await splynxFetch(env, "/api/2.0/admin/scheduling/tasks");

      if (!res.ok) throw new Error(`Splynx failure ${res.status}`);

      const tasks = res.json?.data || res.json || [];
      const admins = await loadAdmins(env);

      const grouped = {};

      for (const t of tasks) {

        const isTodo =
          String(t.workflow_status_id) === "1" &&
          String(t.closed) === "0" &&
          String(t.is_archived) === "0";

        if (!isTodo) continue;

        let admin = "Unassigned";

        if (t.assignee) admin = admins[t.assignee] || `Admin #${t.assignee}`;

        if (!grouped[admin]) grouped[admin] = [];

        grouped[admin].push({
          id: t.id,
          title: t.title || "",
          created: t.created_at || t.updated_at || "",
          town: t.address || "",
          priority: t.priority || "",
          note: t.description || "",
          customer: t.related_customer_id || "",
          link: (env.SPLYNX_URL || "").replace(/\/$/,"") + `/admin/scheduling/tasks/view?id=${t.id}`
        });
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
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:10px;}
.tile{border:1px solid #ddd;padding:12px;border-radius:10px;background:#fff;cursor:grab;display:flex;flex-direction:column;justify-content:space-between;}
.tile.hidden{opacity:0.3;}
.tile .count{font-size:28px;font-weight:bold;color:#c00000;}
.hidebox{margin-top:6px;font-size:12px;}
.section{margin-top:20px;}
table{width:100%;border-collapse:collapse;font-size:13px;background:#fff;}
td,th{border:1px solid #ddd;padding:6px;}
th{background:#f5f5f5;}
.modal{position:fixed;top:0;left:0;right:0;bottom:0;display:none;background:#0007;align-items:center;justify-content:center;z-index:10;}
.modal-content{background:#fff;padding:20px;border-radius:10px;max-height:90vh;width:90%;overflow:auto;}
.row-green{background:#e5f8e5;}
.row-yellow{background:#fff7cf;}
.row-red{background:#ffdede;}
#spinner{display:none;}
.searchbox{margin-top:10px;display:flex;gap:8px;}
@media(max-width:700px){
  .tiles{grid-template-columns:repeat(2,1fr);}
  .header{flex-wrap:wrap;}
}
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

<div class="summary" id="summary"></div>

<h3>Workload per Administrator</h3>
<div id="tiles" class="tiles"></div>

<div class="section">
  <h3>All To-Do Tasks</h3>

  <div class="searchbox">
    <input id="globalsearch" placeholder="Search client code, title, town..." style="flex:1" oninput="renderGlobal()">
  </div>

  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Client Code</th>
        <th>Town</th>
        <th>Priority</th>
        <th>Title</th>
        <th>Created</th>
        <th>Admin</th>
      </tr>
    </thead>
    <tbody id="globalrows"></tbody>
  </table>
</div>

<div id="modal" class="modal">
  <div class="modal-content">
    <button onclick="closeModal()">Close</button>
    <h3 id="mtitle"></h3>
    <input id="search" placeholder="Search" oninput="renderRows()"/>
    <select id="sort" onchange="saveSort();renderRows();">
      <option value="priority">Priority</option>
      <option value="town">Town</option>
      <option value="date">Date</option>
    </select>
    <table id="rows" width="100%"></table>
  </div>
</div>

<script>
let data={};
let tasksFlat=[];
let activeUser="";
let tasks=[];
let sortPref={};
let hiddenAdmins=JSON.parse(localStorage.getItem("hiddenAdmins")||"[]");
let order=JSON.parse(localStorage.getItem("tileOrder")||"[]");

async function load(force=false){
  document.getElementById("spinner").style.display="inline";
  const res=await fetch(force?"/api/refresh":"/api/tasks");
  const j=await res.json();
  data=j.data;
  buildFlat();
  renderTiles();
  renderGlobal();
  document.getElementById("summary").innerText="Total tasks: "+tasksFlat.length;
  document.getElementById("last").innerText="Last updated: "+new Date(j.last).toLocaleString();
  document.getElementById("spinner").style.display="none";
}

function refresh(){ load(true); }

function buildFlat(){
  tasksFlat=[];
  Object.keys(data).forEach(a=>{
    data[a].forEach(t=>{
      tasksFlat.push({...t,admin:a});
    });
  });
}

function orderedAdmins(){
  const admins=Object.keys(data).filter(a=>data[a].length);
  const set=new Set(order);
  const existing=order.filter(a=>admins.includes(a));
  const missing=admins.filter(a=>!set.has(a));
  return [...existing,...missing];
}

function renderTiles(){
  const t=document.getElementById("tiles");
  t.innerHTML="";
  const admins=orderedAdmins();

  admins.forEach(user=>{
    const c=data[user].length;
    if(c===0) return;
    const d=document.createElement("div");
    d.className="tile";
    if(hiddenAdmins.includes(user)) d.classList.add("hidden");
    d.draggable=true;

    d.innerHTML=\`
      <b>\${user}</b>
      <div class="count">\${c}</div>
      <label class="hidebox">
        <input type="checkbox" \${hiddenAdmins.includes(user)?"checked":""} onclick="toggleHide(event,'\${user}')"> Hide
      </label>
    \`;

    d.onclick=(e)=>{ if(e.target.tagName!=='INPUT') openModal(user); };

    d.addEventListener("dragstart",e=>{e.dataTransfer.setData("admin",user);});
    d.addEventListener("dragover",e=>e.preventDefault());
    d.addEventListener("drop",e=>{
      e.preventDefault();
      const from=e.dataTransfer.getData("admin");
      moveAdmin(from,user);
    });

    t.appendChild(d);
  });
}

function toggleHide(e,user){
  e.stopPropagation();
  if(hiddenAdmins.includes(user)) hiddenAdmins=hiddenAdmins.filter(a=>a!==user);
  else hiddenAdmins.push(user);
  localStorage.setItem("hiddenAdmins",JSON.stringify(hiddenAdmins));
  renderTiles();
  renderGlobal();
}

function moveAdmin(from,to){
  order=orderedAdmins();
  const fi=order.indexOf(from);
  const ti=order.indexOf(to);
  order.splice(fi,1);
  order.splice(ti,0,from);
  localStorage.setItem("tileOrder",JSON.stringify(order));
  renderTiles();
}

function openModal(user){
  activeUser=user;
  tasks=data[user];
  document.getElementById("mtitle").innerText=\`Tasks for \${user} (\${tasks.length})\`;
  loadSort();
  renderRows();
  document.getElementById("modal").style.display="flex";
}

function closeModal(){ document.getElementById("modal").style.display="none"; }

function ageColor(d){
  const days=(Date.now()-new Date(d))/86400000;
  if(days<=3) return "row-green";
  if(days<=6) return "row-yellow";
  return "row-red";
}

function renderRows(){
  const q=document.getElementById("search").value.toLowerCase();
  const s=document.getElementById("sort").value;
  let arr=tasks.filter(t=>
    (t.title||"").toLowerCase().includes(q)||
    (t.town||"").toLowerCase().includes(q)||
    (t.customer||"").toLowerCase().includes(q)||
    (t.id+"").includes(q)
  );

  if(s==="priority"){
    arr.sort((a,b)=>{
      const pa=["row-red","row-yellow","row-green"].indexOf(ageColor(a.created));
      const pb=["row-red","row-yellow","row-green"].indexOf(ageColor(b.created));
      return pa-pb;
    });
  }
  if(s==="town") arr.sort((a,b)=>(a.town||"").localeCompare(b.town||""));
  if(s==="date") arr.sort((a,b)=>new Date(b.created)-new Date(a.created));

  const el=document.getElementById("rows");
  el.innerHTML="";
  arr.forEach(t=>{
    const r=document.createElement("tr");
    r.className=ageColor(t.created);
    r.onclick=()=>window.open(t.link,"_blank");
    r.innerHTML=\`
      <td>\${t.id}</td>
      <td>\${t.customer||""}</td>
      <td>\${t.town||""}</td>
      <td>\${t.priority||""}</td>
      <td>\${t.title||""}</td>
      <td>\${t.created||""}</td>
      <td>\${t.note||""}</td>\`;
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
      (t.customer||"").toLowerCase().includes(q)||
      (t.title||"").toLowerCase().includes(q)||
      (t.town||"").toLowerCase().includes(q)
    )
    .forEach(t=>{
      const r=document.createElement("tr");
      r.className=ageColor(t.created);
      r.onclick=()=>window.open(t.link,"_blank");
      r.innerHTML=\`
        <td>\${t.id}</td>
        <td>\${t.customer||""}</td>
        <td>\${t.town||""}</td>
        <td>\${t.priority||""}</td>
        <td>\${t.title||""}</td>
        <td>\${t.created||""}</td>
        <td>\${t.admin||""}</td>
      \`;
      el.appendChild(r);
    });
}

function saveSort(){
  sortPref[activeUser]=document.getElementById("sort").value;
  localStorage.setItem("sortPref",JSON.stringify(sortPref));
}
function loadSort(){
  sortPref=JSON.parse(localStorage.getItem("sortPref")||"{}");
  document.getElementById("sort").value=sortPref[activeUser]||"priority";
}

load();
</script>

</body>
</html>`;
