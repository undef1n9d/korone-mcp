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
const SERVER_VERSION = '1.2';
const PLUGIN_FILE = path.join(__dirname, 'korone-mcp.lua');

// Optional auth: set ENABLE_AUTH to true and choose a token to protect
// /call and /client-toggle. Default is off (open local access on 127.0.0.1).
// When enabled, requests need ?token= or the x-mcp-token header.
const ENABLE_AUTH = false;
const MCP_TOKEN = 'change-me';
function checkToken(req, url) {
  if (!ENABLE_AUTH) return true;
  const t = url?.searchParams?.get('token') || req.headers['x-mcp-token'];
  return t === MCP_TOKEN;
}

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
      : propKeys.map(k => {
          const v = props[k];
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
          } else if (type === 'string' && (k === 'code' || k === 'source')) {
            // Multi-line Lua code: a single-line input would make pasting
            // scripts with newlines impossible.
            const ph = example !== undefined ? String(example) : type;
            input = `<textarea data-tkey="${k}" class="fi" rows="5" placeholder='${ph}'></textarea>`;
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

  return renderPanel(sections);
}

// Panel page lives in panel.html (kept out of index.js so it is editable and
// lintable on its own). Dynamic parts use {{PLACEHOLDER}} tokens.
function renderPanel(sections) {
  let html;
  try {
    html = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
  } catch (err) {
    process.stderr.write(`[roblox-mcp] cannot read panel.html: ${err.message}\n`);
    return '<!DOCTYPE html><html><body style="background:#141414;color:#c33;font:14px monospace;padding:24px"><h1>panel.html not found</h1><p>' + err.message + '</p></body></html>';
  }
  return html
    .replace('{{SECTIONS}}', sections)
    .replace('{{TOOLS_COUNT}}', String(TOOLS.length))
    .replace('{{SERVER_VERSION}}', SERVER_VERSION)
    .replace('{{POLL_ADDR}}', `${HTTP_HOST}:${HTTP_PORT}`);
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
      if (body) { try { parsed = JSON.parse(body); } catch (e) { process.stderr.write(`[roblox-mcp] bad JSON from ${req.method} ${req.url}: ${e.message}\n`); } }
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
        c.active = true; // fresh plugin session = fresh client; re-enable if it was toggled off
        c.lastSeen = Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/client-toggle') {
        if (!checkToken(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const v = clients.get(parsed.key);
        if (!v) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Client not found: ${parsed.key}` }));
          return;
        }
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
        try { fs.appendFileSync(path.join(__dirname, 'mcp.log'), entry); } catch (e) { process.stderr.write(`[roblox-mcp] cannot append mcp.log: ${e.message}\n`); }
        res.writeHead(200); res.end('{}');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/log') {
        try {
          const data = fs.readFileSync(path.join(__dirname, 'mcp.log'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(data);
        } catch (e) {
          process.stderr.write(`[roblox-mcp] cannot read mcp.log: ${e.message}\n`);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('');
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/call') {
        if (!checkToken(req, url)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
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
        const pluginPath = PLUGIN_FILE;
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

      // Manual hot-reload trigger: re-read korone-mcp.lua and notify
      if (req.method === 'POST' && url.pathname === '/reload-plugin') {
        reloadFlag = Date.now().toString(36);
        const pluginPath = PLUGIN_FILE;
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
  try { req = JSON.parse(line); } catch (e) { process.stderr.write(`[roblox-mcp] bad MCP line: ${e.message}\n`); return; }

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
