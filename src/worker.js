export default {
async fetch(request, env, ctx) {

const USERNAME="vinet";
const PASSWORD="Vinet007!";
const SESSION="vinet_session";
const AUTO=60*60*1000;

function html(b){return new Response(b,{headers:{"Content-Type":"text/html"}})}
function json(d,s=200){return new Response(JSON.stringify(d),{status:s,headers:{"Content-Type":"application/json"}})}
function okIP(ip){if(!ip)return false;const p=ip.split(".");return p[0]==="160"&&p[1]==="226"&&Number(p[2])>=128&&Number(p[2])<=143}
function logged(r){return(r.headers.get("Cookie")||"").includes(`${SESSION}=1`)}
async function getIP(r){return r.headers.get("CF-Connecting-IP")||null}

async function api(env,path,opt={}){
 const base=(env.SPLYNX_URL||"").replace(/\/$/,"");
 const r=await fetch(base+path,{...opt,headers:{Authorization:env.AUTH_HEADER||"","Content-Type":"application/json"}});
 const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
 return{ok:r.ok,status:r.status,json:j,text:t}
}

async function cacheGet(env){
 return env.DB.prepare("SELECT payload,last_updated FROM task_cache WHERE id=1").first();
}
async function cacheSet(env,payload){
 return env.DB.prepare(`INSERT OR REPLACE INTO task_cache(id,payload,last_updated)VALUES(1,?,?)`)
   .bind(JSON.stringify(payload),Date.now()).run();
}

async function getAdmins(env){
 const r=await api(env,"/api/2.0/admin/administration/administrators");
 const list=r.json?.data||r.json||[];const map={};
 list.forEach(a=>map[a.id]=a.name||a.login||`Admin #${a.id}`);
 return map;
}

async function load(env,force=false){

 const c=await cacheGet(env);
 if(!force&&c&&Date.now()-c.last_updated<AUTO) return{data:JSON.parse(c.payload),last:c.last_updated};

 const admins=await getAdmins(env);

 const r=await api(env,"/api/2.0/admin/scheduling/tasks");
 if(!r.ok) throw new Error("Splynx error");

 const tasks=r.json?.data||r.json||[];
 const grouped={};

 for(const t of tasks){

  const ws=t.workflow_status_id;
  const archived=String(t.is_archived)==="1";
  const statusName=(t.status_name||"").toLowerCase();

  if(archived) continue;
  if(statusName==="to archive") continue;

  let admin="Unassigned";
  if(t.assignee) admin=admins[t.assignee]||`Admin #${t.assignee}`;
  if(!grouped[admin]) grouped[admin]={todo:[],done:[]};

  const rec={
    id:t.id,
    customer:t.related_customer_id||"",
    address:t.address||"",
    title:t.title||"",
    priority:t.priority||"",
    created:t.created_at||t.date_created||"",
    status:t.status_name||t.workflow_status_name||"",
    admin,
    link:(env.SPLYNX_URL||"").replace(/\/$/,"")+`/admin/scheduling/tasks/view?id=${t.id}`
  };

  if(ws===1||ws===2) grouped[admin].todo.push(rec);
  else grouped[admin].done.push(rec);
 }

 const payload={grouped};
 await cacheSet(env,payload);
 return{data:payload,last:Date.now()};
}

const url=new URL(request.url);
const origin=url.origin;
const ip=await getIP(request);

if(!okIP(ip)) return html(`<h2>Sorry — this tool is only available inside the Vinet network.</h2>`);

if(url.pathname==="/login"&&request.method==="GET")
 return html(`<h2>Vinet Scheduling Login</h2><form method="POST"><input name="u"/><br/><input name="p" type="password"/><br/><button>Login</button></form>`);

if(url.pathname==="/login"&&request.method==="POST"){
 const f=await request.formData();
 if(f.get("u")===USERNAME&&f.get("p")===PASSWORD)
  return new Response("",{status:302,headers:{"Set-Cookie":`${SESSION}=1; HttpOnly; Secure; Path=/`,"Location":origin+"/"}});
 return new Response("Invalid login",{status:401});
}

if(!logged(request)) return Response.redirect(origin+"/login",302);

if(url.pathname==="/api/tasks") return json(await load(env,false));
if(url.pathname==="/api/refresh") return json(await load(env,true));

return html(UI);
}
}

const UI=`
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vinet Scheduling</title>
<style>
body{font-family:Arial;margin:15px;}
.header{display:flex;align-items:center;gap:15px;flex-wrap:wrap;}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin-top:10px;}
.tile{border:1px solid #ddd;border-radius:10px;padding:12px;background:#fafafa}
.count{font-size:32px;font-weight:bold;color:#c00}
.done{font-size:12px;color:#555}
button{background:#b30000;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer}
#spinner{display:none}
.modal{position:fixed;top:0;left:0;right:0;bottom:0;background:#0007;display:none;align-items:center;justify-content:center}
.modal-body{background:white;border-radius:12px;padding:15px;max-height:90vh;width:95%;max-width:1100px;overflow:auto}
.tabbtn{padding:6px 10px;margin-right:6px;border-radius:6px;border:1px solid #ccc;cursor:pointer}
.tabactive{background:#b30000;color:white;border-color:#900}
table{width:100%;border-collapse:collapse;margin-top:10px}
td,th{border-bottom:1px solid #eee;padding:6px}
.row{cursor:pointer}
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

<div id="modal" class="modal">
 <div class="modal-body">
  <h3 id="mtitle"></h3>
  <button onclick="closeModal()">Close</button>
  <div>
    <button id="tabtodo" class="tabbtn" onclick="setTab('todo')">To-Do</button>
    <button id="tabdone" class="tabbtn" onclick="setTab('done')">Done</button>
  </div>

  <table>
   <thead>
    <tr>
     <th>ID</th><th>Client</th><th>Address</th><th>Status</th><th>Priority</th><th>Created</th>
    </tr>
   </thead>
   <tbody id="rows"></tbody>
  </table>
 </div>
</div>

<script>
let data={grouped:{}};
let active="",tab="todo";

async function load(force=false){
 spinner(true);
 const r=await fetch(force?"/api/refresh":"/api/tasks");
 const j=await r.json();
 data=j.data;
 document.getElementById("last").innerText="Last updated: "+new Date(j.last).toLocaleString();
 renderTiles();
 spinner(false);
}

function spinner(b){document.getElementById("spinner").style.display=b?"inline":"none";}
function refresh(){load(true);}

function renderTiles(){
 let total=0;
 const t=document.getElementById("tiles");t.innerHTML="";
 Object.keys(data.grouped).forEach(a=>{
  const todo=data.grouped[a].todo.length;
  const done=data.grouped[a].done.length;
  total+=todo;
  const d=document.createElement("div");
  d.className="tile";
  d.innerHTML=\`<b>\${a}</b><br><span class="count">\${todo}</span><div class="done">Done: \${done}</div>\`;
  d.onclick=()=>openModal(a);
  t.appendChild(d);
 });
 document.getElementById("summary").innerHTML="<b>Total To-Do:</b> "+total;
}

function openModal(a){active=a;tab="todo";document.getElementById("modal").style.display="flex";renderTab();}
function closeModal(){document.getElementById("modal").style.display="none";}
function setTab(x){tab=x;renderTab();}

function renderTab(){
 document.getElementById("tabtodo").className="tabbtn"+(tab==="todo"?" tabactive":"");
 document.getElementById("tabdone").className="tabbtn"+(tab==="done"?" tabactive":"");
 document.getElementById("mtitle").innerText=\`\${active} — \${tab==="todo"?"To-Do":"Done"}\`;

 const el=document.getElementById("rows");el.innerHTML="";
 (data.grouped[active][tab]||[]).forEach(t=>{
  const r=document.createElement("tr");
  r.className="row";
  r.onclick=()=>window.open(t.link,"_blank");
  r.innerHTML=\`<td>\${t.id}</td><td>\${t.customer}</td><td>\${t.address}</td><td>\${t.status}</td><td>\${t.priority}</td><td>\${t.created}</td>\`;
  el.appendChild(r);
 });
}

load();
</script>

</body>
</html>
`;
