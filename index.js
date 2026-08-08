#!/usr/bin/env node
'use strict';

const readline = require('readline');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const HTTP_PORT = 4444;
const HTTP_HOST = '127.0.0.1';
const POLL_TIMEOUT_MS = 30000;

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'roblox-mcp';
const SERVER_VERSION = '1.1';

// ─────────────────────────────────────────────────────────
// Tools schema — single source of truth. Plugin must implement every handler.
// ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'ping',
    category: 'Core',
    description: 'Health check. Verify Studio plugin is connected and responsive.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_studio_state',
    category: 'Core',
    description: 'Get current Studio state: place name, connected status, snapshot age.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'read_workspace',
    category: 'Explore',
    description: 'Return a tree of the workspace (or any service) up to a max depth. The root\'s direct children are paginated by pageSize/cursor (returns hasMore + cursor for the next page); deeper descendants are capped at pageSize per node.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Instance path, e.g. "Workspace" or "Workspace.Folder". Default: Workspace', example: 'Workspace' },
        depth: { type: 'number', description: 'Max traversal depth (default 3, max 6)', example: 3 },
        cursor: { type: 'string', description: 'Cursor from a previous response\'s data.cursor - fetches the next page of the root\'s children', example: '100' },
        pageSize: { type: 'number', description: 'Max children per node, and page size for the root (default 100, max 500)', example: 100 }
      }
    }
  },
  {
    name: 'bulk_create',
    category: 'Instances',
    description: 'Create multiple instances in one round-trip. Each item: { className, name?, parent, properties? }.',
    inputSchema: {
      type: 'object',
      properties: {
        instances: {
          type: 'array',
          description: 'List of instances to create. className and parent are required per item.',
          example: [{ className: 'Part', name: 'MyPart', parent: 'Workspace', properties: { Anchored: true } }],
          items: {
            type: 'object',
            properties: {
              className: { type: 'string', description: 'Class to create, e.g. "Part", "Script", "Folder"' },
              name: { type: 'string', description: 'Instance name (optional)' },
              parent: { type: 'string', description: 'Path to parent instance, e.g. "Workspace"' },
              properties: { type: 'object', description: 'Property assignments, e.g. {"Anchored":true}' }
            },
            required: ['className', 'parent']
          }
        }
      },
      required: ['instances']
    }
  },
  {
    name: 'get_children',
    category: 'Explore',
    description: 'List direct children of an instance.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the instance', example: 'Workspace' } },
      required: ['path']
    }
  },
  {
    name: 'get_properties',
    category: 'Explore',
    description: 'Read properties of an instance by path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance', example: 'Workspace.Part' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Optional specific property names (omit for all)', example: ['Name', 'Position'] }
      },
      required: ['path']
    }
  },
  {
    name: 'find_instances',
    category: 'Explore',
    description: 'Find instances by class name, optionally with IsA check.',
    inputSchema: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Exact class name to match (GetClassName)', example: 'Part' },
        searchIn: { type: 'string', description: 'Path to root for search. Default: game', example: 'Workspace' },
        isA: { type: 'string', description: 'Use IsA() instead of exact class match', example: 'BasePart' },
        maxResults: { type: 'number', description: 'Max results to return (default 50)', example: 50 }
      },
      required: ['className']
    }
  },
  {
    name: 'create_instance',
    category: 'Instances',
    description: 'Create a new instance (Script, Part, Folder, etc.) with properties.',
    inputSchema: {
      type: 'object',
      properties: {
        className: { type: 'string', description: 'Class to create, e.g. "Part", "Script", "Folder"', example: 'Part' },
        name: { type: 'string', description: 'Instance name (optional, defaults to ClassName)', example: 'MyPart' },
        parent: { type: 'string', description: 'Path to parent instance', example: 'Workspace' },
        properties: { type: 'object', description: 'Additional property assignments', example: { Anchored: true, Transparency: 0 } }
      },
      required: ['className', 'parent']
    }
  },
  {
    name: 'delete_instance',
    category: 'Instances',
    description: 'Delete an instance by path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the instance to delete', example: 'Workspace.OldPart' } },
      required: ['path']
    }
  },
  {
    name: 'rename_instance',
    category: 'Instances',
    description: 'Rename an instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance', example: 'Workspace.Part' },
        name: { type: 'string', description: 'New name for the instance', example: 'RenamedPart' }
      },
      required: ['path', 'name']
    }
  },
  {
    name: 'move_instance',
    category: 'Instances',
    description: 'Move an instance to a new parent.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance to move', example: 'Workspace.Part' },
        newParent: { type: 'string', description: 'Path to the new parent', example: 'Workspace.Folder' }
      },
      required: ['path', 'newParent']
    }
  },
  {
    name: 'clone_instance',
    category: 'Instances',
    description: 'Clone an instance and optionally reparent.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance to clone', example: 'Workspace.Part' },
        parent: { type: 'string', description: 'Path to new parent for the clone (optional, defaults to same parent)', example: 'Workspace.Folder' },
        name: { type: 'string', description: 'Name for the cloned instance (optional)', example: 'PartCopy' }
      },
      required: ['path']
    }
  },
  {
    name: 'modify_instance',
    category: 'Instances',
    description: 'Set properties on an existing instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance', example: 'Workspace.Part' },
        properties: { type: 'object', description: 'Property assignments to apply', example: { Transparency: 0.5, Anchored: true } }
      },
      required: ['path', 'properties']
    }
  },
  {
    name: 'write_script',
    category: 'Scripts',
    description: 'Write full source to a Script/LocalScript/ModuleScript. Use force=true to bypass safety checks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the script', example: 'ServerScriptService.Main' },
        source: { type: 'string', description: 'Full Lua source code to write', example: 'print("hello")' },
        force: { type: 'boolean', description: 'Bypass safety checks (default false)' }
      },
      required: ['path', 'source']
    }
  },
  {
    name: 'read_script',
    category: 'Scripts',
    description: 'Read source code of a script by path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the script', example: 'ServerScriptService.Main' } },
      required: ['path']
    }
  },
  {
    name: 'check_script',
    category: 'Scripts',
    description: 'Check a script for syntax/load errors without saving. If path given, checks existing; if source given, checks that.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to an existing script to check (optional if source given)', example: 'ServerScriptService.Main' },
        source: { type: 'string', description: 'Lua source to check instead of reading from path (optional)', example: 'print("hello")' }
      }
    }
  },
  {
    name: 'execute_lua',
    category: 'Scripts',
    description: 'Execute arbitrary Lua code in Studio (server-side). Use force=true to bypass safety.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Lua code to execute on the server', example: 'print("hello from MCP")' },
        force: { type: 'boolean', description: 'Bypass safety checks (default false)' }
      },
      required: ['code']
    }
  },
  {
    name: 'select_instances',
    category: 'Explore',
    description: 'Set Studio selection to given paths.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Instance paths to select', example: ['Workspace.Part1', 'Workspace.Part2'] }
      },
      required: ['paths']
    }
  },
  {
    name: 'get_selection',
    category: 'Explore',
    description: 'Get currently selected instances in Studio.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'set_lighting',
    category: 'Lighting',
    description: 'Change Lighting service properties.',
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Lighting properties: Brightness, TimeOfDay, Ambient, etc.', example: { Brightness: 2, TimeOfDay: '14:00:00' } }
      },
      required: ['properties']
    }
  },
  {
    name: 'add_tag',
    category: 'Tags',
    description: 'Add a CollectionService tag to an instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance', example: 'Workspace.Part' },
        tag: { type: 'string', description: 'Tag name to add', example: 'Enemy' }
      },
      required: ['path', 'tag']
    }
  },
  {
    name: 'remove_tag',
    category: 'Tags',
    description: 'Remove a CollectionService tag from an instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the instance', example: 'Workspace.Part' },
        tag: { type: 'string', description: 'Tag name to remove', example: 'Enemy' }
      },
      required: ['path', 'tag']
    }
  },
  {
    name: 'get_tagged',
    category: 'Tags',
    description: 'List instances with a given CollectionService tag.',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Tag name to search for', example: 'Enemy' } },
      required: ['tag']
    }
  },
  ];

const CATEGORY_ORDER = ['Core', 'Explore', 'Instances', 'Scripts', 'Lighting', 'Tags'];

// Every tool accepts an optional "client" param so MCP agents can target a
// specific Studio window by name. The web panel hides this field (it has its
// own click-to-target UI) and the plugin never sees it (stripped in executeTool).
for (const t of TOOLS) {
  t.inputSchema.properties.client = {
    type: 'string',
    description: 'Target a specific Studio client by name (as shown on the panel, e.g. "studio"). Omit to auto-pick: the only active client, or the most recently active one when several are connected.'
  };
}

// ──────────────────────────────────────────
// HTTP bridge to Studio plugin
// ─────────────────────────────────────────────────────────
const pending = new Map();   // id -> { resolve, reject, started }
const results = new Map();   // id -> result
let lastPluginPoll = 0;
let pluginInfo = null;
let reloadFlag = Date.now().toString(36);

// Track multiple polling clients (Studio plugins)
const clients = new Map(); // key -> { name, lastSeen, active, info }

function isPluginConnected() {
  return Date.now() - lastPluginPoll < 10000;
}

function getClientKey(req, url) {
  const name = url?.searchParams?.get('client') || req.headers['x-client-name'] || 'studio';
  return req.socket?.remoteAddress + ':' + name;
}

function pruneClients() {
  const now = Date.now();
  for (const [k, v] of clients) {
    if (now - v.lastSeen > 15000) clients.delete(k);
  }
}

function clientsList() {
  pruneClients();
  return [...clients.entries()].map(([key, c]) => ({
    key, name: c.name, active: c.active, lastSeen: c.lastSeen
  }));
}

function schemaExample(schema) {
  if (!schema) return undefined;
  if (schema.type === 'array') {
    if (!schema.items) return undefined;
    const item = schemaExample(schema.items);
    return item === undefined ? undefined : [item];
  }
  if (schema.type === 'object') {
    if (!schema.properties || !Object.keys(schema.properties).length) return undefined;
    const obj = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const val = v.example !== undefined ? v.example : schemaExample(v);
      obj[k] = val !== undefined ? val : (v.type === 'number' ? 0 : v.type === 'boolean' ? false : '...');
    }
    return obj;
  }
  return undefined;
}

function renderDocsHTML() {
  const byCategory = new Map();
  for (const t of TOOLS) {
    const cat = t.category || 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(t);
  }
  const orderedCats = [...CATEGORY_ORDER.filter(c => byCategory.has(c)), ...[...byCategory.keys()].filter(c => !CATEGORY_ORDER.includes(c))];

  const renderTool = t => {
    const props = t.inputSchema.properties || {};
    const required = t.inputSchema.required || [];
    const propKeys = Object.keys(props).filter(k => k !== 'client'); // panel targets clients via chips, not fields
    const inputs = propKeys.length === 0
      ? '<div class="np">No parameters</div>'
      : propKeys.map(([k, v]) => {
          const isReq = required.includes(k);
          const desc = v.description || '';
          const type = v.type || 'string';
          const enumOpts = v.enum ? v.enum.map(e => `<option>${e}</option>`).join('') : '';
          const example = v.example !== undefined ? v.example : schemaExample(v);
          let input;
          if (type === 'boolean') {
            input = `<label class="bl"><input type="checkbox" data-tkey="${k}"><span>enabled</span></label>`;
          } else if (enumOpts) {
            input = `<select data-tkey="${k}" class="fi"><option value="">—</option>${enumOpts}</select>`;
          } else if (type === 'array') {
            const ph = example !== undefined ? JSON.stringify(example) : '["a","b"]';
            input = `<input data-tkey="${k}" class="fi" placeholder='${ph}'>`;
          } else if (type === 'object') {
            const ph = example !== undefined ? JSON.stringify(example) : '{"k":"v"}';
            input = `<textarea data-tkey="${k}" class="fi" rows="2" placeholder='${ph}'></textarea>`;
          } else {
            const ph = example !== undefined ? String(example) : type;
            input = `<input data-tkey="${k}" class="fi" placeholder="${ph}">`;
          }
          return `<div class="fi-w">
            <div class="fh"><span class="fk">${k}</span>${isReq ? '<span class="rq">required</span>' : ''}</div>
            ${desc ? `<div class="fd">${desc}</div>` : ''}
            ${input}
          </div>`;
        }).join('');
    return `<div class="c" data-t="${t.name}">
      <div class="ch" onclick="this.parentElement.classList.toggle('op')">
        <span class="ca">▸</span>
        <span class="cn">${t.name}</span>
        <span class="cd">${t.description}</span>
      </div>
      <div class="cb">
        <div class="ci">${inputs}</div>
        <div class="actions">
          <button class="b" onclick="r('${t.name}')">Run →</button>
          <button class="b b2" onclick="cp('${t.name}')">Copy result</button>
        </div>
        <pre class="o" id="o-${t.name}"></pre>
      </div>
    </div>`;
  };

  const sections = orderedCats.map(cat => `<div class="cat" data-cat="${cat}">
    <div class="cat-h">${cat}</div>
    ${byCategory.get(cat).map(renderTool).join('')}
  </div>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MCP</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{color-scheme:dark}
body{background:#141414;color:#8a8a8a;font:12px/1.5 ui-monospace,SFMono-Regular,'Cascadia Code',Consolas,monospace;padding:28px 16px}
.w{max-width:720px;margin:0 auto}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:14px;margin-bottom:6px;border-bottom:1px solid #262626;flex-wrap:wrap}
h1{font-size:14px;font-weight:600;color:#d4d4d4;letter-spacing:.2px}
.m{color:#5c5c5c;font-size:10.5px;margin-top:2px}
.st{font-size:10.5px;color:#6a6a6a;display:flex;align-items:center;gap:6px;padding:4px 9px;border:1px solid #262626;border-radius:5px;background:#181818}
.dt{width:6px;height:6px;border-radius:50%;display:inline-block;background:#3a3a3a;transition:background .2s}
.dt.on{background:#7ea87e;box-shadow:0 0 5px #7ea87e55}
.dt.off{background:#3a3a3a}
.bar{display:flex;gap:8px;margin:14px 0 10px;align-items:center;flex-wrap:wrap}
.sr-w{position:relative;flex:1;min-width:160px}
.sr-w:before{content:'/';position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#4a4a4a;font-size:11px;pointer-events:none}
.sr{width:100%;background:#181818;border:1px solid #2a2a2a;border-radius:5px;padding:7px 8px 7px 20px;font:inherit;font-size:11.5px;color:#ccc;outline:none;transition:border-color .15s}
.sr::placeholder{color:#5c5c5c}
.sr:focus{border-color:#484848}
.cl{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.clt{font-size:10px;padding:3px 8px;background:#181818;border:1px solid #2a2a2a;border-radius:5px;display:flex;align-items:center;gap:5px;color:#6a6a6a;transition:border-color .15s;cursor:pointer}
.clt.on{border-color:#3d3d3d;color:#b0b0b0}
.clt.tgt{border-color:#5a7a5a;color:#b8c8b8}
.clt.tgt .dt{background:#7ea87e;box-shadow:0 0 5px #7ea87e55}
.clt button{background:none;border:none;color:#5c5c5c;cursor:pointer;font-size:11px;padding:0 1px;line-height:1}
.clt button:hover{color:#ccc}
.cnote{font-size:10px;color:#4a4a4a;flex-basis:100%;padding-left:2px}
.cat-h{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;color:#4a4a4a;margin:18px 0 6px;padding-left:2px}
.cat:first-of-type .cat-h{margin-top:4px}
.c{border:1px solid #262626;border-radius:6px;margin-bottom:6px;overflow:hidden;background:#181818;transition:border-color .15s}
.c:hover{border-color:#333}
.ch{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:pointer;user-select:none}
.ch .ca{color:#4a4a4a;font-size:9px;transition:transform .15s;flex-shrink:0}
.c.op .ch .ca{transform:rotate(90deg)}
.ch .cn{font-size:11.5px;color:#c2c2c2;white-space:nowrap;font-weight:600}
.ch .cd{color:#5c5c5c;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.cb{display:none;padding:4px 12px 12px;border-top:1px solid #232323}
.c.op .cb{display:block}
.ci{padding-top:8px}
.fi-w{margin-bottom:10px}
.fi-w:last-child{margin-bottom:0}
.fh{display:flex;align-items:center;gap:6px;margin-bottom:3px}
.fk{font-size:10.5px;color:#9a9a9a}
.rq{font-size:8.5px;color:#8a7a5c;background:#2a2418;border:1px solid #3a3020;border-radius:3px;padding:1px 5px;letter-spacing:.3px;text-transform:uppercase}
.fd{color:#5c5c5c;font-size:10px;margin-bottom:5px}
.fi{width:100%;background:#141414;border:1px solid #2a2a2a;border-radius:4px;padding:6px 8px;font:inherit;font-size:11px;color:#ccc;outline:none;transition:border-color .15s}
.fi::placeholder{color:#4a4a4a}
.fi:focus{border-color:#484848}
textarea.fi{resize:vertical;min-height:32px}
.bl{display:flex;align-items:center;gap:6px;font-size:11px;color:#aaa;cursor:pointer}
.bl input{accent-color:#6a6a6a;width:13px;height:13px}
.np{color:#5c5c5c;font-size:10.5px;padding:2px 0 8px}
.actions{display:flex;gap:6px;margin-top:4px}
.b{background:#232323;color:#bbb;border:1px solid #333;border-radius:4px;padding:6px 13px;font:inherit;font-size:11px;cursor:pointer;transition:background .15s,border-color .15s}
.b:hover{background:#2a2a2a;border-color:#454545}
.b:active{background:#1e1e1e}
.b:disabled{opacity:.35;cursor:default}
.b2{background:transparent;color:#6a6a6a}
.b2:hover{background:#202020;color:#999}
.o{background:#101010;border:1px solid #262626;border-radius:4px;padding:8px;font-size:10.5px;color:#8a8a8a;margin-top:8px;white-space:pre-wrap;word-break:break-word;display:none;max-height:220px;overflow:auto}
.o.s{display:block}
.o.e{color:#b08a8a;border-color:#3a2424}
footer{margin-top:22px;color:#454545;font-size:10px;text-align:center}
</style>
</head>
<body>
<div class="w">
<header>
  <div>
    <h1>Korone Studio (2021M) MCP</h1>
    <div class="m">${TOOLS.length} tools · v${SERVER_VERSION}</div>
  </div>
  <div class="st" id="st"><span class="dt off"></span>checking</div>
</header>
<div class="bar">
  <div class="sr-w"><input class="sr" id="sr" placeholder="Search tools..." oninput="f(this.value)"></div>
</div>
<div id="cl"></div>
<div id="tl">${sections}</div>
<footer>polling 127.0.0.1:4444</footer>
</div>
<script>
async function r(n){
  const c=document.querySelector('.c[data-t="'+n+'"]'); if(!c)return;
  const b=c.querySelector('.b'),o=document.getElementById('o-'+n);
  b.disabled=1; o.className='o s'; o.textContent='running...';
  const p={};
  c.querySelectorAll('[data-tkey]').forEach(e=>{
    const k=e.getAttribute('data-tkey');
    if(e.type==='checkbox'){p[k]=e.checked;return}
    let v=e.value.trim(); if(!v)return;
    if(e.tagName==='SELECT'){p[k]=v;return}
    try{v=JSON.parse(v)}catch{}
    p[k]=v;
  });
  try{
    const resp=await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,params:p,client:curTarget||undefined})});
    const j=await resp.json();
    if(j.error){o.className='o s e';o.textContent=j.error}
    else{const t=j.data?typeof j.data==='string'?j.data:JSON.stringify(j.data,null,2):'(empty)';o.textContent=t}
  }catch(e){o.className='o s e';o.textContent='err: '+e.message}
  b.disabled=0;
}
async function cp(n){
  const o=document.getElementById('o-'+n); if(!o||!o.textContent)return;
  try{await navigator.clipboard.writeText(o.textContent)}catch{}
}
function f(q){
  q=q.toLowerCase();
  document.querySelectorAll('.c').forEach(c=>{
    const name=c.querySelector('.cn').textContent.toLowerCase();
    const desc=c.querySelector('.cd').textContent.toLowerCase();
    c.style.display=(name.includes(q)||desc.includes(q))?'':'none';
  });
  document.querySelectorAll('.cat').forEach(cat=>{
    const visible=[...cat.querySelectorAll('.c')].some(c=>c.style.display!=='none');
    cat.style.display=visible?'':'none';
  });
}
function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
let curTarget=null;
function rc(clients){
  const d=document.getElementById('cl');
  if(!clients||!clients.length){d.innerHTML='';return}
  const cur=curTarget&&clients.find(c=>c.key===curTarget);
  if(curTarget&&!cur)curTarget=null;
  d.innerHTML=clients.map(c=>'<div class="clt'+(c.active?' on':'')+(c.key===curTarget?' tgt':'')+'" data-key="'+esc(c.key)+'" title="click to target · × to disable"><span class="dt '+(c.active?'on':'off')+'"></span>'+esc(c.name)+'<button class="ctb" data-key="'+esc(c.key)+'">×</button></div>').join('')
    +'<div class="cnote">target: '+((cur&&curTarget)?esc(cur.name):'auto — most recent active')+'</div>';
}
document.getElementById('cl').addEventListener('click', async e=>{
  const chip=e.target.closest('.clt'); if(!chip)return;
  const key=chip.getAttribute('data-key');
  if(e.target.closest('.ctb')){
    await fetch('/client-toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
    if(curTarget===key)curTarget=null;
  }else{
    curTarget=(curTarget===key)?null:key;
  }
  st();
});
async function st(){
  try{
    const r=await fetch('/status'),j=await r.json();
    const on=j.pluginConnected;
    document.querySelector('#st').innerHTML='<span class="dt '+(on?'on':'off')+'"></span>'+(on?'connected':'offline');
    rc(j.clients);
  }catch{ document.querySelector('#st').innerHTML='<span class="dt off"></span>offline' }
}
document.addEventListener('keydown',e=>{
  if(e.key==='/' && document.activeElement.id!=='sr'){e.preventDefault();document.getElementById('sr').focus()}
});
setInterval(st,2000);st();
</script>
</body>
</html>`;
}

function startHttpServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      if (body) { try { parsed = JSON.parse(body); } catch {} }
      const url = new URL(req.url, `http://${HTTP_HOST}`);

      if (req.method === 'GET' && url.pathname === '/poll') {
        lastPluginPoll = Date.now();
        const k = getClientKey(req, url);
        const clientParam = url.searchParams.get('client') || req.headers['x-client-name'];
        if (!clients.has(k)) {
          clients.set(k, { key: k, name: 'Studio', lastSeen: Date.now(), active: true, info: null });
        }
        const c = clients.get(k);
        c.lastSeen = Date.now();
        // Use this client's own /hello info (matched by the same key), not a shared global -
        // otherwise multiple Studio instances clobber each other's displayed place name.
        const placeName = c.info?.placeName;
        c.name = clientParam && clientParam !== 'studio'
          ? `${clientParam} (${placeName || '?'})`
          : (placeName || 'Studio');
        const cmds = [];
        if (c.active) {
          for (const [id, entry] of pending) {
            if (entry.sent) continue;
            if (entry.target && entry.target !== k) continue; // targeted at a different client
            cmds.push({ id, action: entry.action, params: entry.params });
            entry.sent = true;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ commands: cmds, serverTime: Date.now(), active: c.active }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/result') {
        const { id, success, data, error } = parsed;
        if (id && results) {
          results.set(id, { success, data, error, completedAt: Date.now() });
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            entry.resolve({ success, data, error });
          }
          setTimeout(() => results.delete(id), 60000);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/hello') {
        lastPluginPoll = Date.now();
        pluginInfo = parsed; // kept for backward-compat summary on /status
        const k = getClientKey(req, url);
        if (!clients.has(k)) {
          clients.set(k, { key: k, name: 'Studio', lastSeen: Date.now(), active: true, info: null });
        }
        const c = clients.get(k);
        c.info = parsed;
        c.lastSeen = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/client-toggle') {
        const v = clients.get(parsed.key);
        if (v) {
          v.active = !v.active;
          if (!v.active) {
            // Fail fast: pending commands targeted at this client can never
            // complete, so reject them instead of letting them hit the timeout.
            for (const [id, entry] of pending) {
              if (entry.sent) continue;
              if (entry.target === parsed.key) {
                pending.delete(id);
                entry.reject(new Error(`Client disabled while command pending: ${v.name}`));
              }
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/plugin-update-flag') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ flag: reloadFlag }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/log') {
        const entry = `[${new Date().toISOString()}] ${parsed.message || ''}\n`;
        process.stderr.write(`[plugin] ${parsed.message || ''}\n`);
        try { fs.appendFileSync(path.join(__dirname, 'mcp.log'), entry); } catch {}
        res.writeHead(200); res.end('{}');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/log') {
        try {
          const data = fs.readFileSync(path.join(__dirname, 'mcp.log'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(data);
        } catch {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('');
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/call') {
        const { name, params, client } = parsed;
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown tool: ${name}` }));
          return;
        }
        const timeoutMs = (name === 'execute_lua' || name === 'check_script') ? 45000 : POLL_TIMEOUT_MS;
        executeTool(name, params || {}, client).then(result => {
          const text = result.content?.[0]?.text || '';
          if (result.isError) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: text, isError: true }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ data: text }));
          }
        }).catch(err => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pluginConnected: isPluginConnected(),
          pluginInfo,
          pending: pending.size,
          results: results.size,
          clients: clientsList()
        }));
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/docs' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDocsHTML());
        return;
      }

      // Hot-reload: returns updated plugin source if mtime changed
      if (req.method === 'GET' && url.pathname === '/plugin-update') {
        const pluginPath = path.join(__dirname, 'plugin.lua');
        try {
          const stat = fs.statSync(pluginPath);
          const since = req.headers['if-modified-since'] ? new Date(req.headers['if-modified-since']).getTime() : 0;
          if (stat.mtimeMs <= since) {
            res.writeHead(304); res.end(); return;
          }
          const source = fs.readFileSync(pluginPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Last-Modified': new Date(stat.mtimeMs).toUTCString()
          });
          res.end(JSON.stringify({ source, mtime: stat.mtimeMs }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // Manual hot-reload trigger: re-read plugin.lua and notify
      if (req.method === 'POST' && url.pathname === '/reload-plugin') {
        reloadFlag = Date.now().toString(36);
        const pluginPath = path.join(__dirname, 'plugin.lua');
        try {
          const source = fs.readFileSync(pluginPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, flag: reloadFlag, bytes: source.length }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      res.writeHead(404); res.end('not found');
    });
  });
  server.listen(HTTP_PORT, HTTP_HOST, () => {
    process.stderr.write(`[roblox-mcp] HTTP bridge on http://${HTTP_HOST}:${HTTP_PORT}\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`[roblox-mcp] HTTP error: ${err.message}\n`);
  });
}

// Smart client targeting:
// - explicit targetClient (client key or display name) -> that client only
// - no target, one active client -> that client
// - no target, several active clients -> the most recently seen one (deterministic)
function resolveTargetClient(targetClient) {
  const now = Date.now();
  const active = [...clients.values()].filter(c => c.active && now - c.lastSeen < 15000);
  if (targetClient) {
    const found = clients.get(targetClient)
      || [...clients.values()].find(c => c.key === targetClient || String(c.name).split(' (')[0] === targetClient);
    if (!found) return { error: `Client not found: ${targetClient}` };
    if (!found.active) return { error: `Client disabled: ${targetClient}` };
    return { key: found.key };
  }
  if (active.length === 0) return { none: true };
  if (active.length === 1) return { key: active[0].key };
  active.sort((a, b) => b.lastSeen - a.lastSeen);
  return { key: active[0].key };
}

function sendCommand(action, params, timeoutMs, targetClient) {
  return new Promise((resolve, reject) => {
    if (!isPluginConnected() && action !== 'ping') {
      reject(new Error('Studio plugin not connected'));
      return;
    }
    let entryTarget = null;
    if (!(action === 'ping' && !targetClient)) {
      const t = resolveTargetClient(targetClient);
      if (t.error || t.none) {
        reject(new Error(t.error || 'All clients disabled (toggle off)'));
        return;
      }
      entryTarget = t.key;
    }
    const id = randomUUID();
    const entry = { action, params, resolve, reject, started: null, target: entryTarget };
    pending.set(id, entry);

    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for plugin (${action})`));
      }
    }, timeoutMs || POLL_TIMEOUT_MS);

    const origResolve = resolve;
    entry.resolve = (r) => { clearTimeout(timer); origResolve(r); };
    const origReject = reject;
    entry.reject = (e) => { clearTimeout(timer); origReject(e); };
  });
}

// ─────────────────────────────────────────────────────────
// MCP JSON-RPC over stdio
// ─────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function executeTool(name, args, targetClient) {
  const timeoutMs = name === 'execute_lua' || name === 'check_script' ? 45000 : POLL_TIMEOUT_MS;
  const clean = { ...(args || {}) };
  delete clean.client; // targeting hint, not a plugin param
  try {
    const r = await sendCommand(name, clean, timeoutMs, targetClient || null);
    if (r.success) {
      const text = (typeof r.data === 'string') ? r.data : JSON.stringify(r.data, null, 2);
      return { content: [{ type: 'text', text: text || '(no output)' }] };
    }
    return { isError: true, content: [{ type: 'text', text: `Error: ${r.error || 'unknown'}` }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return await executeTool(name, args);
  }
  throw new Error(`Unknown method: ${method}`);
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }

  // Notification (no id) — ignore result
  if (req.id === undefined || req.id === null) {
    try { await handle(req); } catch (err) {
      process.stderr.write(`[roblox-mcp] handler error: ${err.message}\n`);
    }
    return;
  }

  try {
    const result = await handle(req);
    if (result !== null) {
      send({ jsonrpc: '2.0', id: req.id, result });
    } else {
      send({ jsonrpc: '2.0', id: req.id, result: {} });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err.message } });
  }
});

rl.on('close', () => process.exit(0));

startHttpServer();
process.stderr.write(`[roblox-mcp] stdio MCP server ready\n`);
