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

        const taskObj = {
          id: t.id,
          title: t.title || "",
          customer: t.related_customer_id || "",
          address: t.address || "",
          created: t.created_at || "",
          resolved: t.resolved_at || "",
          admin: adminName,
          link: (env.SPLYNX_URL || "").replace(/\/$/, "") +
                `/admin/scheduling/tasks/view?id=${t.id}`
        };

        if (isDone) grouped[adminName].done++;
        else {
          grouped[adminName].todo++;
          grouped[adminName].todoList.push(taskObj);
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

body{font-family:Arial;margin:20px;max-width:1400px;margin-left:auto;margin-right:auto;}

.header{display:flex;align-items:center;gap:20px;}

.logo{height:40px;}

.brand{color:#b30000;font-weight:bold;font-size:20px;}

.tiles{display:flex;flex-wrap:wrap;gap:15px;margin-top:10px;}

.tile{
  border:1px solid #ddd;
  padding:15px;
  border-radius:10px;
  cursor:move;
  background:#fafafa;
  box-shadow:0 2px 4px rgba(0,0,0,0.05);
  width:230px;
}

.tile:hover{background:#fff;}

.count{font-size:34px;font-weight:bold;color:#c40000;}

.done{font-size:14px;color:#008000;}

.hiddenBar{
  margin-top:15px;
  padding:8px;
  background:#f4f4f4;
  border-radius:10px;
  font-size:13px;
}

.hiddenTag{
  display:inline-block;
  background:#fff;
  border:1px solid #ccc;
  padding:4px 7px;
  border-radius:8px;
  margin-right:6px;
  cursor:pointer;
}

.loading,.modal{
  position:fixed;top:0;left:0;right:0;bottom:0;
  display:none;align-items:center;justify-content:center;
  background:#0006;z-index:99;
}

.modal-content{background:#fff;padding:20px;border-radius:10px;max-height:90vh;width:90%;overflow:auto;}

.search{margin-top:25px;margin-bottom:8px;}

#allrows{border-collapse:collapse;width:100%;font-size:13px;}

#allrows thead{background:#f6f6f6;}

#allrows th{padding:8px;border-bottom:2px solid #ccc;cursor:pointer;}

#allrows td{padding:6px;border-bottom:1px solid #eee;}

#allrows tr:hover{background:#f9f9f9;}

</style>
</head>

<body>

<div class="header">
  <img class="logo" src="https://static.vinet.co.za/logo.jpeg">
  <span class="brand">Vinet Scheduling</span>
  <button onclick="refresh()">Refresh</button>
  <span id="last"></span>
</div>

<div class="loading" id="loading">
  <div style="background:white;padding:20px;border-radius:12px;">Loading...</div>
</div>

<div id="tiles" class="tiles"></div>

<div id="hidden" class="hiddenBar"></div>

<div class="search">
  <input id="search" placeholder="Search client code / address / title..." style="width:300px;padding:6px;">
</div>

<table id="allrows">
  <thead>
    <tr>
      <th onclick="setSort('id')">ID</th>
      <th onclick="setSort('customer')">Client Code</th>
      <th onclick="setSort('address')">Address</th>
      <th onclick="setSort('created')">Created</th>
      <th onclick="setSort('admin')">Admin</th>
      <th onclick="setSort('title')">Title</th>
    </tr>
  </thead>
  <tbody></tbody>
</table>

<script>

let data={};
let all=[];
let sortField='id';
let sortDir='desc';

let order=JSON.parse(localStorage.getItem("order")||"[]");
let hidden=JSON.parse(localStorage.getItem("hidden")||"[]");

setInterval(()=>refresh(), 15*60*1000);

async function load(force=false){
  document.getElementById("loading").style.display="flex";
  const res=await fetch(force?"/api/refresh":"/api/tasks");
  const j=await res.json();
  data=j.data;

  const names=Object.keys(data);

  if(order.length===0) order=names;
  else order=order.filter(n=>names.includes(n)).concat(names.filter(n=>!order.includes(n)));

  all=[];
  names.forEach(a=>data[a].todoList.forEach(t=>all.push(t)));

  document.getElementById("last").innerText="Last updated: "+new Date(j.last).toLocaleString();
  renderTiles();
  renderAllRows();
  document.getElementById("loading").style.display="none";
}

function refresh(){ load(true); }

function renderTiles(){
  const t=document.getElementById("tiles");
  t.innerHTML="";

  order.forEach(admin=>{
    if(hidden.includes(admin)) return;

    const d=document.createElement("div");
    d.className="tile";
    d.draggable=true;

    d.innerHTML=\`
      <b>\${admin}</b>
      <div class="count">\${data[admin].todo}</div>
      <div class="done">Done: \${data[admin].done}</div>
      <label><input type="checkbox" onchange="toggleHide('\${admin}')" \${hidden.includes(admin)?'checked':''}/> Hide</label>
    \`;

    d.onclick=()=>openModal(admin);

    d.ondragstart=e=>{e.dataTransfer.setData("text/plain",admin);};
    d.ondragover=e=>e.preventDefault();
    d.ondrop=e=>{
      e.preventDefault();
      const from=e.dataTransfer.getData("text/plain");
      const to=admin;
      reorder(from,to);
    };

    t.appendChild(d);
  });

  renderHidden();
}

function reorder(a,b){
  const i=order.indexOf(a);
  const j=order.indexOf(b);
  order.splice(i,1);
  order.splice(j,0,a);
  localStorage.setItem("order",JSON.stringify(order));
  renderTiles();
}

function toggleHide(name){
  if(hidden.includes(name)) hidden=hidden.filter(x=>x!==name);
  else hidden.push(name);
  localStorage.setItem("hidden",JSON.stringify(hidden));
  renderTiles();
}

function renderHidden(){
  const bar=document.getElementById("hidden");
  bar.innerHTML="";
  hidden.forEach(h=>{
    const tag=document.createElement("span");
    tag.className="hiddenTag";
    tag.innerText=h;
    tag.onclick=()=>toggleHide(h);
    bar.appendChild(tag);
  });
}

function setSort(f){
  if(f===sortField) sortDir=sortDir==='asc'?'desc':'asc';
  else{sortField=f;sortDir='asc';}
  renderAllRows();
}

document.getElementById("search").oninput=()=>renderAllRows();

function renderAllRows(){
  const q=document.getElementById("search").value.toLowerCase();

  let arr=all.filter(t=>
    (t.customer+'').toLowerCase().includes(q) ||
    (t.address||'').toLowerCase().includes(q) ||
    (t.title||'').toLowerCase().includes(q)
  );

  arr.sort((a,b)=>{
    let av=a[sortField]||'', bv=b[sortField]||'';
    if(sortField==='id'){av=+av;bv=+bv;}
    return sortDir==='asc'?(av>bv?1:-1):(av<bv?1:-1);
  });

  const el=document.querySelector("#allrows tbody");
  el.innerHTML="";
  arr.forEach(t=>{
    const r=document.createElement("tr");
    r.onclick=()=>window.open(t.link,"_blank");
    r.innerHTML=\`
      <td>\${t.id}</td>
      <td>\${t.customer}</td>
      <td>\${t.address}</td>
      <td>\${t.created}</td>
      <td>\${t.admin}</td>
      <td>\${t.title}</td>\`;
    el.appendChild(r);
  });
}

function openModal(){}

load();

</script>

</body>
</html>`;
