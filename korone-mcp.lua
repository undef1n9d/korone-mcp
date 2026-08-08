--[[
    Roblox MCP Plugin for Studio 2021
    v1.2 - stdio MCP bridge plugin with a configurable settings panel
    Polls an HTTP bridge for commands, executes them, posts results.
]]

-- =================================
-- SERVICES
-- =================================
local HttpService          = game:GetService("HttpService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local Selection            = game:GetService("Selection")
local RunService           = game:GetService("RunService")
local CollectionService    = game:GetService("CollectionService")
local UserInputService     = game:GetService("UserInputService")

if not plugin then
    warn("[MCP] Not running as plugin - aborting.")
    return
end

-- =================================
-- CONFIG (persisted across sessions, editable from the settings panel)
-- =================================
local function loadSetting(key, default)
    local ok, val = pcall(function() return plugin:GetSetting(key) end)
    if ok and val ~= nil then return val end
    return default
end

local function saveSetting(key, value)
    pcall(function() plugin:SetSetting(key, value) end)
end

local DEFAULTS = {
    ServerURL          = "http://127.0.0.1:4444",
    PollInterval       = 0.3,
    ClientName         = "studio",
    Enabled            = true,
    ShowStatusWidget   = true,
    StatusCheckInterval = 2,
    VerboseLogging     = false,
    SafetyEnabled      = true
}

local SERVER_URL           = loadSetting("MCP_ServerURL", DEFAULTS.ServerURL)
local POLL_INTERVAL        = loadSetting("MCP_PollInterval", DEFAULTS.PollInterval)
local CLIENT_NAME          = loadSetting("MCP_ClientName", DEFAULTS.ClientName)
local mcpEnabled           = loadSetting("MCP_Enabled", DEFAULTS.Enabled)
local showStatusWidget     = loadSetting("MCP_ShowStatusWidget", DEFAULTS.ShowStatusWidget)
local statusCheckInterval  = loadSetting("MCP_StatusCheckInterval", DEFAULTS.StatusCheckInterval)
local verboseLogging       = loadSetting("MCP_VerboseLogging", DEFAULTS.VerboseLogging)
local safetyEnabled        = loadSetting("MCP_SafetyEnabled", DEFAULTS.SafetyEnabled)

-- ===========================================
-- HTTP HELPERS
-- Client identification is passed as a query param (not a custom header) -
-- some Studio HttpService builds don't support the extra headers argument,
-- which silently breaks every request via pcall.
-- ===========================================
local function buildUrl(endpoint)
    local sep = string.find(endpoint, "?") and "&" or "?"
    local ok, encoded = pcall(function() return HttpService:UrlEncode(CLIENT_NAME) end)
    return SERVER_URL .. endpoint .. sep .. "client=" .. (ok and encoded or "studio")
end

local function httpGet(endpoint)
    local ok, res = pcall(function()
        return HttpService:GetAsync(buildUrl(endpoint))
    end)
    if not ok then return nil, res end
    local jok, data = pcall(function() return HttpService:JSONDecode(res) end)
    return jok and data or nil, res
end

local function httpPost(endpoint, body)
    local ok, res = pcall(function()
        return HttpService:PostAsync(buildUrl(endpoint), HttpService:JSONEncode(body))
    end)
    if not ok then return nil, res end
    local jok, data = pcall(function() return HttpService:JSONDecode(res) end)
    return jok and data or nil, res
end

local function log(msg, level)
    pcall(function()
        HttpService:PostAsync(buildUrl("/log"), HttpService:JSONEncode({
            level = level or "INFO", message = tostring(msg)
        }))
    end)
end

local function vlog(msg)
    if verboseLogging then log("[MCP][debug] " .. tostring(msg)) end
end

-- ===========================================
-- PATH RESOLUTION
-- ===========================================
-- Paths use dot notation, matching how you'd index instances in Lua:
-- "Workspace.Bridge.Part" or "ReplicatedStorage.Modules.Utils"
-- Slash notation ("Workspace/Bridge/Part") is still accepted for compatibility.
local function resolvePath(pathStr)
    if not pathStr or pathStr == "" then return game end
    if pathStr == "game" then return game end
    local parts = {}
    for part in string.gmatch(pathStr, "[^./]+") do
        table.insert(parts, part)
    end
    if #parts == 0 then return game end
    local current = game
    -- First part is a service name
    local first = parts[1]
    if first ~= "game" then
        local svc = game:GetService(first)
        if not svc then return nil, "Unknown service: " .. first end
        current = svc
    end
    for i = 2, #parts do
        local name = parts[i]
        local found = nil
        for _, child in ipairs(current:GetChildren()) do
            if child.Name == name then found = child; break end
        end
        if not found then return nil, "Not found: " .. table.concat(parts, ".", 1, i) end
        current = found
    end
    return current
end

local function getPathOf(instance)
    if instance == game then return "game" end
    local parts = {}
    while instance and instance ~= game do
        table.insert(parts, 1, instance.Name)
        instance = instance.Parent
    end
    return table.concat(parts, ".")
end

-- ===========================================
-- SAFETY CHECKS
-- ===========================================
local DANGEROUS_GLOBALS = { getfenv=true, setfenv=true, loadstring=true, load=true, require=true }
local function codeIsSafe(code)
    if not code or code == "" then return true, "" end
    -- Very basic heuristic
    if string.find(code, "game:Shutdown") then return false, "Contains game:Shutdown" end
    if string.find(code, "while true do") and not string.find(code, "break") and not string.find(code, "task.wait") and not string.find(code, "wait(") then
        return false, "Infinite loop without wait"
    end
    -- Block escape-vector globals: anything that can load/compile code or
    -- rewrite environments. May false-positive on comments/strings -
    -- pass force=true to bypass.
    for g in pairs(DANGEROUS_GLOBALS) do
        if string.find(code, g) then
            return false, "Uses restricted global: " .. g .. " (use force=true)"
        end
    end
    return true, ""
end

-- ===========================================
-- PROPERTY HELPERS
-- ===========================================
local function setProperty(instance, key, value)
    local ok, err = pcall(function()
        if type(value) == "table" then
            -- Try Color3 / Vector3 / UDim2 / etc. based on key
            if value._type == "Color3" then
                instance[key] = Color3.fromRGB(value.r or 255, value.g or 255, value.b or 255)
            elseif value._type == "Vector3" then
                instance[key] = Vector3.new(value.x or 0, value.y or 0, value.z or 0)
            elseif value._type == "Vector2" then
                instance[key] = Vector2.new(value.x or 0, value.y or 0)
            elseif value._type == "UDim2" then
                instance[key] = UDim2.new(value.xScale or 0, value.xOffset or 0, value.yScale or 0, value.yOffset or 0)
            elseif value._type == "UDim" then
                instance[key] = UDim.new(value.scale or 0, value.offset or 0)
            elseif value._type == "CFrame" then
                instance[key] = CFrame.new(value.x or 0, value.y or 0, value.z or 0)
            elseif value._type == "Enum" then
                local enum = Enum
                for _, part in ipairs(string.split(value.value, ".")) do
                    enum = enum[part]
                    if enum == nil then break end
                end
                if enum then instance[key] = enum end
            else
                -- Unknown structured value - try raw assignment
                instance[key] = value
            end
        else
            instance[key] = value
        end
    end)
    return ok, err
end

local function readProperty(instance, key)
    local ok, val = pcall(function() return instance[key] end)
    if not ok then return nil end
    if typeof(val) == "Color3" then
        return { _type="Color3", r=val.r*255, g=val.g*255, b=val.b*255 }
    elseif typeof(val) == "Vector3" then
        return { _type="Vector3", x=val.X, y=val.Y, z=val.Z }
    elseif typeof(val) == "Vector2" then
        return { _type="Vector2", x=val.X, y=val.Y }
    elseif typeof(val) == "UDim2" then
        return { _type="UDim2", xScale=val.X.Scale, xOffset=val.X.Offset, yScale=val.Y.Scale, yOffset=val.Y.Offset }
    elseif typeof(val) == "EnumItem" then
        return { _type="Enum", value=tostring(val) }
    elseif typeof(val) == "Instance" then
        return { _type="Instance", path=getPathOf(val), name=val.Name, className=val.ClassName }
    elseif typeof(val) == "table" or typeof(val) == "function" or typeof(val) == "thread" then
        return "<" .. typeof(val) .. ">"
    else
        return val
    end
end

-- ===========================================
-- SNAPSHOT / TREE
-- ===========================================
-- maxChildren caps how many children are expanded per node at deeper
-- levels (below the root). The root's own children are paginated
-- separately by handlers.read_workspace via cursor/pageSize.
local function snapshotTree(root, depth, maxDepth, maxChildren)
    if depth > maxDepth then return nil end
    local node = {
        name = root.Name,
        className = root.ClassName,
        path = getPathOf(root),
        children = {}
    }
    local children = root:GetChildren()
    if depth < maxDepth then
        for i, child in ipairs(children) do
            if i > maxChildren then
                node.truncated = true
                node.childrenCount = #children
                break
            end
            local sub = snapshotTree(child, depth + 1, maxDepth, maxChildren)
            table.insert(node.children, sub)
        end
    else
        node.childrenCount = #children
    end
    return node
end

-- ===========================================
-- ACTION HANDLERS
-- ===========================================
local handlers = {}

function handlers.ping(params)
    return { success = true, data = { ok = true, time = os.time() } }
end

function handlers.get_studio_state(params)
    return {
        success = true,
        data = {
            placeName = game.Name,
            isRunning = RunService:IsRunning(),
            editMode = not RunService:IsRunning(),
            workspaceChildCount = #game:GetService("Workspace"):GetChildren()
        }
    }
end

function handlers.read_workspace(params)
    local pathStr = params.path or "Workspace"
    local maxDepth = math.min(tonumber(params.depth) or 3, 6)
    local pageSize = math.min(math.max(tonumber(params.pageSize) or 100, 1), 500)
    local offset = math.max(tonumber(params.cursor) or 0, 0)
    local root, err = resolvePath(pathStr)
    if not root then return { success = false, error = err } end

    -- The root's own children are paginated by cursor/pageSize (this is
    -- usually where "large hierarchy" problems come from - one folder
    -- with thousands of siblings). Deeper descendants are still capped
    -- at pageSize per node to keep responses bounded.
    local allChildren = root:GetChildren()
    local total = #allChildren
    local lastIndex = math.min(offset + pageSize, total)

    local node = {
        name = root.Name,
        className = root.ClassName,
        path = getPathOf(root),
        totalChildren = total,
        children = {}
    }
    for i = offset + 1, lastIndex do
        local sub = snapshotTree(allChildren[i], 1, maxDepth, pageSize)
        table.insert(node.children, sub)
    end

    local nextCursor = nil
    if lastIndex < total then
        nextCursor = tostring(lastIndex)
    end

    return { success = true, data = { tree = node, cursor = nextCursor, hasMore = nextCursor ~= nil } }
end

function handlers.get_children(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local list = {}
    for _, c in ipairs(inst:GetChildren()) do
        table.insert(list, { name = c.Name, className = c.ClassName, path = getPathOf(c) })
    end
    return { success = true, data = list }
end

function handlers.get_properties(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local result = { name = inst.Name, className = inst.ClassName, path = getPathOf(inst), properties = {} }
    local wanted = params.properties
    if wanted and #wanted > 0 then
        for _, key in ipairs(wanted) do
            result.properties[key] = readProperty(inst, key)
        end
    else
        local defaults = { "Name", "ClassName", "Parent", "Archivable", "Anchored", "Position", "Size", "Color", "Transparency", "Material", "CanCollide", "CFrame", "Orientation", "Velocity", "Mass", "Elasticity", "Friction", "Reflectance", "Shape", "TopSurface", "BottomSurface", "BrickColor", "Locked", "FormFactor", "AssemblyLinearVelocity", "AssemblyAngularVelocity", "RotVelocity", "MaterialVariant", "FrontSurface", "BackSurface", "LeftSurface", "RightSurface", "Color3", "Value", "StringValue", "IntValue", "NumberValue", "BoolValue", "ObjectValue", "Source", "Enabled", "Disabled", "ScriptGuid", "LinkedSource", "RunContext", "Sandboxed", "ScriptsDisabled", "Tag", "ValueType", "SoundId", "Volume", "Looped", "Pitch", "RollOffMode", "MaxDistance", "EmitterSize", "PlayOnRemove", "Playing", "TimePosition", "PlaybackSpeed", "SavedVolume", "AutoPlay" }
        local seen = {}
        for _, key in ipairs(defaults) do
            if not seen[key] then
                seen[key] = true
                local v = readProperty(inst, key)
                if v ~= nil then result.properties[key] = v end
            end
        end
    end
    return { success = true, data = result }
end

function handlers.find_instances(params)
    local root
    if params.searchIn then
        root = resolvePath(params.searchIn)
    else
        root = game
    end
    if not root then return { success = false, error = "searchIn not found" } end
    local className = params.className
    local useIsA = params.isA
    local maxResults = params.maxResults or 50
    local found = {}
    local function walk(inst)
        if #found >= maxResults then return end
        for _, c in ipairs(inst:GetChildren()) do
            local match = false
            if useIsA then
                match = pcall(function() return c:IsA(useIsA) end) and c:IsA(useIsA)
            else
                match = c.ClassName == className
            end
            if match then
                table.insert(found, { name = c.Name, className = c.ClassName, path = getPathOf(c) })
            end
            walk(c)
            if #found >= maxResults then return end
        end
    end
    walk(root)
    return { success = true, data = { count = #found, instances = found } }
end

function handlers.bulk_create(params)
    local results = { created = {}, errors = {} }
    for i, item in ipairs(params.instances or {}) do
        local parent, err = resolvePath(item.parent)
        if not parent then
            table.insert(results.errors, { index = i, error = err })
        else
            local ok, inst = pcall(function()
                local newInst = Instance.new(item.className)
                if item.name then newInst.Name = item.name end
                if item.properties then
                    for k, v in pairs(item.properties) do
                        setProperty(newInst, k, v)
                    end
                end
                newInst.Parent = parent
                return newInst
            end)
            if ok then
                table.insert(results.created, { index = i, path = getPathOf(inst), name = inst.Name, className = inst.ClassName })
            else
                table.insert(results.errors, { index = i, error = tostring(inst) })
            end
        end
    end
    ChangeHistoryService:SetWaypoint("MCP bulk_create")
    return { success = true, data = results }
end

function handlers.create_instance(params)
    local parent, err = resolvePath(params.parent)
    if not parent then return { success = false, error = err } end
    local inst = Instance.new(params.className)
    if params.name then inst.Name = params.name end
    if params.properties then
        for k, v in pairs(params.properties) do
            setProperty(inst, k, v)
        end
    end
    inst.Parent = parent
    ChangeHistoryService:SetWaypoint("MCP create_instance")
    return { success = true, data = { path = getPathOf(inst), name = inst.Name, className = inst.ClassName } }
end

function handlers.delete_instance(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    if inst == game then return { success = false, error = "Cannot delete game" } end
    local path = getPathOf(inst)
    inst:Destroy()
    ChangeHistoryService:SetWaypoint("MCP delete_instance")
    return { success = true, data = { deleted = path } }
end

function handlers.rename_instance(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    inst.Name = params.name
    ChangeHistoryService:SetWaypoint("MCP rename_instance")
    return { success = true, data = { path = getPathOf(inst), name = inst.Name } }
end

function handlers.move_instance(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local newParent, perr = resolvePath(params.newParent)
    if not newParent then return { success = false, error = perr } end
    inst.Parent = newParent
    ChangeHistoryService:SetWaypoint("MCP move_instance")
    return { success = true, data = { path = getPathOf(inst) } }
end

function handlers.clone_instance(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local clone = inst:Clone()
    if params.name then clone.Name = params.name end
    if params.parent then
        local p = resolvePath(params.parent)
        if not p then return { success = false, error = "parent not found" } end
        clone.Parent = p
    else
        clone.Parent = inst.Parent
    end
    ChangeHistoryService:SetWaypoint("MCP clone_instance")
    return { success = true, data = { path = getPathOf(clone) } }
end

function handlers.modify_instance(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local applied = {}
    local failed = {}
    for k, v in pairs(params.properties or {}) do
        local ok, perr = setProperty(inst, k, v)
        if ok then applied[k] = true else failed[k] = perr end
    end
    ChangeHistoryService:SetWaypoint("MCP modify_instance")
    return { success = true, data = { applied = applied, failed = failed, path = getPathOf(inst) } }
end

function handlers.write_script(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local isScript = inst:IsA("Script") or inst:IsA("LocalScript") or inst:IsA("ModuleScript")
    if not isScript then return { success = false, error = "Target is not a Script/LocalScript/ModuleScript" } end
    if safetyEnabled and not params.force then
        local safe, sErr = codeIsSafe(params.source)
        if not safe then return { success = false, error = "Safety check failed: " .. sErr .. " (use force=true)" } end
    end
    inst.Source = params.source
    ChangeHistoryService:SetWaypoint("MCP write_script")
    return { success = true, data = { path = getPathOf(inst), bytes = #params.source } }
end

function handlers.read_script(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    local isScript = inst:IsA("Script") or inst:IsA("LocalScript") or inst:IsA("ModuleScript")
    if not isScript then return { success = false, error = "Target is not a Script/LocalScript/ModuleScript" } end
    return { success = true, data = inst.Source }
end

function handlers.check_script(params)
    local source = params.source
    if params.path and not source then
        local inst, err = resolvePath(params.path)
        if not inst then return { success = false, error = err } end
        source = inst.Source
    end
    if not source then return { success = false, error = "No source to check" } end
    -- Use loadstring to check syntax
    local fn, err = loadstring(source)
    if fn then return { success = true, data = { ok = true } } end
    return { success = true, data = { ok = false, error = err } }
end

function handlers.execute_lua(params)
    if safetyEnabled and not params.force then
        local safe, sErr = codeIsSafe(params.code)
        if not safe then return { success = false, error = "Safety check failed: " .. sErr .. " (use force=true)" } end
    end
    local fn, err = loadstring(params.code)
    if not fn then return { success = false, error = "Syntax error: " .. tostring(err) } end
    setfenv(fn, getfenv())
    local results = { pcall(fn) }
    local ok = results[1]
    if not ok then return { success = false, error = tostring(results[2]) } end
    local out = {}
    for i = 2, #results do
        local v = results[i]
        if typeof(v) == "Instance" then
            table.insert(out, "<" .. v.ClassName .. ":" .. v.Name .. ">")
        else
            table.insert(out, tostring(v))
        end
    end
    return { success = true, data = { ok = true, returns = out } }
end

function handlers.select_instances(params)
    local sel = {}
    for _, p in ipairs(params.paths or {}) do
        local inst = resolvePath(p)
        if inst then table.insert(sel, inst) end
    end
    Selection:Set(sel)
    return { success = true, data = { count = #sel } }
end

function handlers.get_selection(params)
    local list = {}
    for _, inst in ipairs(Selection:Get()) do
        table.insert(list, { name = inst.Name, className = inst.ClassName, path = getPathOf(inst) })
    end
    return { success = true, data = list }
end

function handlers.set_lighting(params)
    local lighting = game:GetService("Lighting")
    local applied, failed = {}, {}
    for k, v in pairs(params.properties or {}) do
        local ok, err = setProperty(lighting, k, v)
        if ok then applied[k] = true else failed[k] = err end
    end
    return { success = true, data = { applied = applied, failed = failed } }
end

function handlers.add_tag(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    CollectionService:AddTag(inst, params.tag)
    return { success = true }
end

function handlers.remove_tag(params)
    local inst, err = resolvePath(params.path)
    if not inst then return { success = false, error = err } end
    CollectionService:RemoveTag(inst, params.tag)
    return { success = true }
end

function handlers.get_tagged(params)
    local list = {}
    for _, inst in ipairs(CollectionService:GetTagged(params.tag)) do
        table.insert(list, { name = inst.Name, className = inst.ClassName, path = getPathOf(inst) })
    end
    return { success = true, data = list }
end

-- ===========================================
-- COMMAND EXECUTION
-- ===========================================
local function formatRequestLine(action, params)
    -- Truncate params to 100 chars total
    local paramsStr = ""
    if params and next(params) ~= nil then
        local ok, encoded = pcall(function() return HttpService:JSONEncode(params) end)
        if ok then
            if #encoded > 100 then
                paramsStr = " " .. string.sub(encoded, 1, 97) .. "..."
            else
                paramsStr = " " .. encoded
            end
        end
    end
    return "." .. action .. paramsStr
end

local function executeCommand(cmd)
    local handler = handlers[cmd.action]
    if not handler then
        return { success = false, error = "Unknown action: " .. tostring(cmd.action) }
    end
    print("[MCP] " .. formatRequestLine(cmd.action, cmd.params))
    local ok, result = pcall(handler, cmd.params or {})
    if not ok then
        return { success = false, error = tostring(result), stackTrace = debug.traceback() }
    end
    return result or { success = true, data = nil }
end

-- ===========================================
-- POLL LOOP
-- ===========================================
local function pollOnce()
    local data, err = httpGet("/poll")
    if not data then return end
    if data.commands then
        for _, cmd in ipairs(data.commands) do
            local result = executeCommand(cmd)
            pcall(function()
                HttpService:PostAsync(SERVER_URL .. "/result", HttpService:JSONEncode({
                    id = cmd.id,
                    success = result.success,
                    data = result.data,
                    error = result.error
                }))
            end)
        end
    end
end

local lastPoll = 0
local tickConn

local function startPolling()
    if tickConn then return end
    lastPoll = 0
    tickConn = game:GetService("RunService").Heartbeat:Connect(function()
        if os.clock() - lastPoll >= POLL_INTERVAL then
            lastPoll = os.clock()
            pollOnce()
        end
    end)
end

local function stopPolling()
    if tickConn then tickConn:Disconnect(); tickConn = nil end
end

httpPost("/hello", {
    plugin = "roblox-mcp",
    version = "1.2",
    studioVersion = "2021",
    placeName = game.Name,
    clientName = CLIENT_NAME
})
log("[MCP] Plugin loaded - polling " .. SERVER_URL .. "/poll every " .. POLL_INTERVAL .. "s")

if mcpEnabled then startPolling() end

-- =================================
-- TOOLBAR + SETTINGS PANEL
-- Clicking the toolbar icon shows/hides an in-viewport Frame (not a
-- separate dockable window - some Studio builds handle those poorly)
-- =================================
local statusGui -- forward-declared; created below, toggled from the settings panel

-- Toolbar buttons can't be re-created with the same id while the old one
-- still exists (hot reload would crash with "Cannot create more than one
-- button with id ..."). Cache the toolbar + button in _G so reloads reuse
-- them instead of trying to recreate them.
local MCP_CACHE = _G.KORONE_MCP_CACHE
_G.KORONE_MCP_CACHE = MCP_CACHE or {}
MCP_CACHE = _G.KORONE_MCP_CACHE
-- Detach any click handler left over from a previous instance
if MCP_CACHE.clickConn then
    pcall(function() MCP_CACHE.clickConn:Disconnect() end)
    MCP_CACHE.clickConn = nil
end
if MCP_CACHE.unloadConn then
    pcall(function() MCP_CACHE.unloadConn:Disconnect() end)
    MCP_CACHE.unloadConn = nil
end

local toolbar = MCP_CACHE.toolbar or plugin:CreateToolbar("Roblox MCP")
local toggleBtn = MCP_CACHE.toggleBtn or toolbar:CreateButton(
    "MCP Settings",
    "Show/hide the MCP settings panel",
    "rbxassetid://941139"
)
MCP_CACHE.toolbar = toolbar
MCP_CACHE.toggleBtn = toggleBtn

local COLORS = {
    bg = Color3.fromRGB(20, 20, 20),
    bgLight = Color3.fromRGB(28, 28, 28),
    field = Color3.fromRGB(16, 16, 16),
    border = Color3.fromRGB(42, 42, 42),
    text = Color3.fromRGB(204, 204, 204),
    dim = Color3.fromRGB(140, 140, 140),
    faint = Color3.fromRGB(90, 90, 90),
    button = Color3.fromRGB(34, 34, 34),
    buttonBorder = Color3.fromRGB(51, 51, 51),
    on = Color3.fromRGB(120, 170, 120),
    off = Color3.fromRGB(90, 90, 90),
    err = Color3.fromRGB(170, 120, 120)
}

local settingsGui = Instance.new("ScreenGui")
settingsGui.Name = "MCPSettingsGui"
settingsGui.ResetOnSpawn = false
settingsGui.IgnoreGuiInset = true
settingsGui.DisplayOrder = 100
settingsGui.Parent = game:GetService("CoreGui")

local settingsFrame = Instance.new("Frame")
settingsFrame.Name = "MCPSettingsFrame"
settingsFrame.Size = UDim2.new(0, 640, 0, 480)
settingsFrame.Position = UDim2.new(0.5, -320, 0.5, -240)
settingsFrame.BackgroundColor3 = COLORS.bg
settingsFrame.BorderColor3 = COLORS.border
settingsFrame.BorderSizePixel = 1
settingsFrame.Visible = false
settingsFrame.Parent = settingsGui

local titleBar = Instance.new("Frame")
titleBar.Name = "TitleBar"
titleBar.Size = UDim2.new(1, 0, 0, 24)
titleBar.BackgroundColor3 = COLORS.bgLight
titleBar.BorderSizePixel = 0
titleBar.Parent = settingsFrame

local titleLabel = Instance.new("TextLabel")
titleLabel.BackgroundTransparency = 1
titleLabel.Position = UDim2.new(0, 8, 0, 0)
titleLabel.Size = UDim2.new(1, -32, 1, 0)
titleLabel.Font = Enum.Font.Code
titleLabel.TextSize = 12
titleLabel.TextColor3 = COLORS.text
titleLabel.TextXAlignment = Enum.TextXAlignment.Left
titleLabel.Text = "MCP Settings"
titleLabel.Parent = titleBar

local closeBtn = Instance.new("TextButton")
closeBtn.Size = UDim2.new(0, 24, 0, 24)
closeBtn.Position = UDim2.new(1, -24, 0, 0)
closeBtn.BackgroundTransparency = 1
closeBtn.Font = Enum.Font.Code
closeBtn.TextSize = 14
closeBtn.TextColor3 = COLORS.dim
closeBtn.Text = "x"
closeBtn.Parent = titleBar

-- Drag the panel by its title bar
do
    local dragging = false
    local dragStart, startPos

    titleBar.InputBegan:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            dragging = true
            dragStart = input.Position
            startPos = settingsFrame.Position
        end
    end)

    titleBar.InputEnded:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            dragging = false
        end
    end)

    UserInputService.InputChanged:Connect(function(input)
        if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
            local delta = input.Position - dragStart
            settingsFrame.Position = UDim2.new(
                startPos.X.Scale, startPos.X.Offset + delta.X,
                startPos.Y.Scale, startPos.Y.Offset + delta.Y
            )
        end
    end)
end

-- Resize handle (bottom-right corner) - Frames aren't natively resizable
local resizeHandle = Instance.new("TextButton")
resizeHandle.Name = "ResizeHandle"
resizeHandle.Size = UDim2.new(0, 16, 0, 16)
resizeHandle.Position = UDim2.new(1, -16, 1, -16)
resizeHandle.BackgroundColor3 = COLORS.bgLight
resizeHandle.BorderColor3 = COLORS.border
resizeHandle.BorderSizePixel = 1
resizeHandle.AutoButtonColor = false
resizeHandle.Text = ""
resizeHandle.ZIndex = 5
resizeHandle.Parent = settingsFrame

local resizeGrip = Instance.new("TextLabel")
resizeGrip.BackgroundTransparency = 1
resizeGrip.Size = UDim2.new(1, 0, 1, 0)
resizeGrip.Font = Enum.Font.Code
resizeGrip.TextSize = 12
resizeGrip.TextColor3 = COLORS.faint
resizeGrip.Text = "//"
resizeGrip.Rotation = 90
resizeGrip.Parent = resizeHandle

local MIN_WIDTH, MIN_HEIGHT = 260, 220

do
    local resizing = false
    local resizeStart, startSize

    resizeHandle.InputBegan:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            resizing = true
            resizeStart = input.Position
            startSize = settingsFrame.Size
        end
    end)

    resizeHandle.InputEnded:Connect(function(input)
        if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
            resizing = false
        end
    end)

    UserInputService.InputChanged:Connect(function(input)
        if resizing and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
            local delta = input.Position - resizeStart
            local newWidth = math.max(MIN_WIDTH, startSize.X.Offset + delta.X)
            local newHeight = math.max(MIN_HEIGHT, startSize.Y.Offset + delta.Y)
            settingsFrame.Size = UDim2.new(0, newWidth, 0, newHeight)
        end
    end)
end

local function setSettingsVisible(visible)
    settingsFrame.Visible = visible
    toggleBtn:SetActive(visible)
end

toggleBtn:SetActive(false)
MCP_CACHE.clickConn = toggleBtn.Click:Connect(function()
    setSettingsVisible(not settingsFrame.Visible)
end)
closeBtn.MouseButton1Click:Connect(function()
    setSettingsVisible(false)
end)

-- Scrollable container so the panel stays usable even with lots of settings
local scroller = Instance.new("ScrollingFrame")
scroller.Name = "Scroller"
scroller.Size = UDim2.new(1, 0, 1, -24)
scroller.Position = UDim2.new(0, 0, 0, 24)
scroller.BackgroundColor3 = COLORS.bg
scroller.BorderSizePixel = 0
scroller.ScrollBarThickness = 5
scroller.ScrollBarImageColor3 = COLORS.border
scroller.CanvasSize = UDim2.new(0, 0, 0, 0)
scroller.Parent = settingsFrame

local root = Instance.new("Frame")
root.Name = "Root"
root.Size = UDim2.new(1, 0, 0, 0)
root.BackgroundTransparency = 1
root.BorderSizePixel = 0
root.Parent = scroller

local rootPadding = Instance.new("UIPadding")
rootPadding.PaddingTop = UDim.new(0, 10)
rootPadding.PaddingBottom = UDim.new(0, 10)
rootPadding.PaddingLeft = UDim.new(0, 10)
rootPadding.PaddingRight = UDim.new(0, 10)
rootPadding.Parent = root

local rootLayout = Instance.new("UIListLayout")
rootLayout.FillDirection = Enum.FillDirection.Vertical
rootLayout.SortOrder = Enum.SortOrder.LayoutOrder
rootLayout.Padding = UDim.new(0, 8)
rootLayout.Parent = root

local function updateCanvasSize()
    scroller.CanvasSize = UDim2.new(0, 0, 0, rootLayout.AbsoluteContentSize.Y + 20)
end
rootLayout:GetPropertyChangedSignal("AbsoluteContentSize"):Connect(updateCanvasSize)
spawn(updateCanvasSize)

-- Status row
local statusRow = Instance.new("Frame")
statusRow.Name = "StatusRow"
statusRow.BackgroundTransparency = 1
statusRow.Size = UDim2.new(1, 0, 0, 16)
statusRow.LayoutOrder = 0
statusRow.Parent = root

local panelDot = Instance.new("Frame")
panelDot.Size = UDim2.new(0, 6, 0, 6)
panelDot.Position = UDim2.new(0, 2, 0, 5)
panelDot.BackgroundColor3 = COLORS.off
panelDot.BorderSizePixel = 0
panelDot.Parent = statusRow

local panelStatusLabel = Instance.new("TextLabel")
panelStatusLabel.BackgroundTransparency = 1
panelStatusLabel.Position = UDim2.new(0, 14, 0, 0)
panelStatusLabel.Size = UDim2.new(1, -14, 1, 0)
panelStatusLabel.Font = Enum.Font.Code
panelStatusLabel.TextSize = 12
panelStatusLabel.TextColor3 = COLORS.dim
panelStatusLabel.TextXAlignment = Enum.TextXAlignment.Left
panelStatusLabel.Text = "checking..."
panelStatusLabel.Parent = statusRow

local function makeField(order, labelText, defaultValue)
    local container = Instance.new("Frame")
    container.Name = labelText .. "Field"
    container.BackgroundTransparency = 1
    container.Size = UDim2.new(1, 0, 0, 40)
    container.LayoutOrder = order
    container.Parent = root

    local label = Instance.new("TextLabel")
    label.BackgroundTransparency = 1
    label.Size = UDim2.new(1, 0, 0, 14)
    label.Font = Enum.Font.Code
    label.TextSize = 11
    label.TextColor3 = COLORS.faint
    label.TextXAlignment = Enum.TextXAlignment.Left
    label.Text = labelText
    label.Parent = container

    local box = Instance.new("TextBox")
    box.Size = UDim2.new(1, 0, 0, 24)
    box.Position = UDim2.new(0, 0, 0, 16)
    box.BackgroundColor3 = COLORS.field
    box.BorderColor3 = COLORS.border
    box.BorderSizePixel = 1
    box.Font = Enum.Font.Code
    box.TextSize = 12
    box.TextColor3 = COLORS.text
    box.PlaceholderColor3 = COLORS.faint
    box.ClearTextOnFocus = false
    box.Text = tostring(defaultValue)
    box.TextXAlignment = Enum.TextXAlignment.Left

    local boxPadding = Instance.new("UIPadding")
    boxPadding.PaddingLeft = UDim.new(0, 6)
    boxPadding.Parent = box

    box.Parent = container
    return box
end

local urlBox = makeField(1, "Server URL", SERVER_URL)
local intervalBox = makeField(2, "Poll interval (seconds)", POLL_INTERVAL)
local nameBox = makeField(3, "Client name", CLIENT_NAME)
local statusIntervalBox = makeField(4, "Status check interval (seconds)", statusCheckInterval)

-- Reusable checkbox row (label + toggle)
local function makeCheckboxRow(order, labelText, initialValue, onToggle)
    local row = Instance.new("Frame")
    row.BackgroundTransparency = 1
    row.Size = UDim2.new(1, 0, 0, 20)
    row.LayoutOrder = order
    row.Parent = root

    local checkbox = Instance.new("TextButton")
    checkbox.Size = UDim2.new(0, 14, 0, 14)
    checkbox.Position = UDim2.new(0, 0, 0, 3)
    checkbox.BackgroundColor3 = initialValue and COLORS.on or COLORS.field
    checkbox.BorderColor3 = COLORS.border
    checkbox.BorderSizePixel = 1
    checkbox.Text = ""
    checkbox.AutoButtonColor = false
    checkbox.Parent = row

    local label = Instance.new("TextLabel")
    label.BackgroundTransparency = 1
    label.Position = UDim2.new(0, 22, 0, 0)
    label.Size = UDim2.new(1, -22, 1, 0)
    label.Font = Enum.Font.Code
    label.TextSize = 12
    label.TextColor3 = COLORS.dim
    label.TextXAlignment = Enum.TextXAlignment.Left
    label.Text = labelText
    label.Parent = row

    local value = initialValue
    local function setValue(v, skipCallback)
        value = v
        checkbox.BackgroundColor3 = value and COLORS.on or COLORS.field
        if not skipCallback then onToggle(value) end
    end
    checkbox.MouseButton1Click:Connect(function()
        setValue(not value)
    end)

    return { instance = checkbox, setValue = setValue }
end

local enabledCheckboxCtl = makeCheckboxRow(5, "Polling enabled", mcpEnabled, function(value)
    mcpEnabled = value
    saveSetting("MCP_Enabled", mcpEnabled)
    if mcpEnabled then
        startPolling()
        log("[MCP] Enabled - polling started")
    else
        stopPolling()
        log("[MCP] Disabled - polling stopped")
    end
end)

local safetyCheckboxCtl = makeCheckboxRow(6, "Safety checks enabled", safetyEnabled, function(value)
    safetyEnabled = value
    saveSetting("MCP_SafetyEnabled", safetyEnabled)
    log("[MCP] Safety checks " .. (value and "enabled" or "disabled"))
end)

local showStatusCheckboxCtl = makeCheckboxRow(7, "Show status indicator", showStatusWidget, function(value)
    showStatusWidget = value
    saveSetting("MCP_ShowStatusWidget", showStatusWidget)
    if statusGui then statusGui.Enabled = showStatusWidget end
end)

local verboseCheckboxCtl = makeCheckboxRow(8, "Verbose logging", verboseLogging, function(value)
    verboseLogging = value
    saveSetting("MCP_VerboseLogging", verboseLogging)
end)

-- Feedback line (shows save/test results)
local feedbackLabel = Instance.new("TextLabel")
feedbackLabel.BackgroundTransparency = 1
feedbackLabel.Size = UDim2.new(1, 0, 0, 16)
feedbackLabel.LayoutOrder = 9
feedbackLabel.Font = Enum.Font.Code
feedbackLabel.TextSize = 11
feedbackLabel.TextColor3 = COLORS.faint
feedbackLabel.TextXAlignment = Enum.TextXAlignment.Left
feedbackLabel.TextWrapped = true
feedbackLabel.Text = ""
feedbackLabel.Parent = root

-- Buttons row
local btnRow = Instance.new("Frame")
btnRow.BackgroundTransparency = 1
btnRow.Size = UDim2.new(1, 0, 0, 26)
btnRow.LayoutOrder = 10
btnRow.Parent = root

local saveBtn = Instance.new("TextButton")
saveBtn.Size = UDim2.new(0.48, 0, 1, 0)
saveBtn.Position = UDim2.new(0, 0, 0, 0)
saveBtn.BackgroundColor3 = COLORS.button
saveBtn.BorderColor3 = COLORS.buttonBorder
saveBtn.BorderSizePixel = 1
saveBtn.Font = Enum.Font.Code
saveBtn.TextSize = 12
saveBtn.TextColor3 = COLORS.text
saveBtn.Text = "Save"
saveBtn.Parent = btnRow

local testBtn = Instance.new("TextButton")
testBtn.Size = UDim2.new(0.48, 0, 1, 0)
testBtn.Position = UDim2.new(0.52, 0, 0, 0)
testBtn.BackgroundColor3 = COLORS.button
testBtn.BorderColor3 = COLORS.buttonBorder
testBtn.BorderSizePixel = 1
testBtn.Font = Enum.Font.Code
testBtn.TextSize = 12
testBtn.TextColor3 = COLORS.text
testBtn.Text = "Test connection"
testBtn.Parent = btnRow

-- Reset row
local resetRow = Instance.new("Frame")
resetRow.BackgroundTransparency = 1
resetRow.Size = UDim2.new(1, 0, 0, 26)
resetRow.LayoutOrder = 11
resetRow.Parent = root

local resetBtn = Instance.new("TextButton")
resetBtn.Size = UDim2.new(1, 0, 1, 0)
resetBtn.BackgroundColor3 = COLORS.button
resetBtn.BorderColor3 = COLORS.buttonBorder
resetBtn.BorderSizePixel = 1
resetBtn.Font = Enum.Font.Code
resetBtn.TextSize = 12
resetBtn.TextColor3 = COLORS.err
resetBtn.Text = "Reset to defaults"
resetBtn.Parent = resetRow

saveBtn.MouseButton1Click:Connect(function()
    local newUrl = urlBox.Text ~= "" and urlBox.Text or SERVER_URL
    local newInterval = tonumber(intervalBox.Text) or POLL_INTERVAL
    local newName = nameBox.Text ~= "" and nameBox.Text or CLIENT_NAME
    local newStatusInterval = tonumber(statusIntervalBox.Text) or statusCheckInterval

    SERVER_URL = newUrl
    POLL_INTERVAL = math.clamp(newInterval, 0.1, 10)
    CLIENT_NAME = newName
    statusCheckInterval = math.clamp(newStatusInterval, 0.5, 30)
    intervalBox.Text = tostring(POLL_INTERVAL)
    statusIntervalBox.Text = tostring(statusCheckInterval)

    saveSetting("MCP_ServerURL", SERVER_URL)
    saveSetting("MCP_PollInterval", POLL_INTERVAL)
    saveSetting("MCP_ClientName", CLIENT_NAME)
    saveSetting("MCP_StatusCheckInterval", statusCheckInterval)

    feedbackLabel.Text = "Saved - reconnecting..."
    feedbackLabel.TextColor3 = COLORS.on
    log("[MCP] Settings saved - url=" .. SERVER_URL .. " interval=" .. tostring(POLL_INTERVAL) .. " client=" .. CLIENT_NAME)

    if mcpEnabled then
        stopPolling()
        startPolling()
    end
end)

testBtn.MouseButton1Click:Connect(function()
    feedbackLabel.Text = "Testing..."
    feedbackLabel.TextColor3 = COLORS.dim
    spawn(function()
        local data = httpGet("/status")
        if data then
            feedbackLabel.Text = data.pluginConnected and "OK - server + plugin reachable" or "Server reachable, plugin not polling yet"
            feedbackLabel.TextColor3 = COLORS.on
        else
            feedbackLabel.Text = "Failed to reach " .. SERVER_URL
            feedbackLabel.TextColor3 = COLORS.err
        end
    end)
end)

resetBtn.MouseButton1Click:Connect(function()
    SERVER_URL = DEFAULTS.ServerURL
    POLL_INTERVAL = DEFAULTS.PollInterval
    CLIENT_NAME = DEFAULTS.ClientName
    statusCheckInterval = DEFAULTS.StatusCheckInterval
    mcpEnabled = DEFAULTS.Enabled
    showStatusWidget = DEFAULTS.ShowStatusWidget
    verboseLogging = DEFAULTS.VerboseLogging
    safetyEnabled = DEFAULTS.SafetyEnabled

    urlBox.Text = SERVER_URL
    intervalBox.Text = tostring(POLL_INTERVAL)
    nameBox.Text = CLIENT_NAME
    statusIntervalBox.Text = tostring(statusCheckInterval)
    enabledCheckboxCtl.setValue(mcpEnabled, true)
    safetyCheckboxCtl.setValue(safetyEnabled, true)
    showStatusCheckboxCtl.setValue(showStatusWidget, true)
    verboseCheckboxCtl.setValue(verboseLogging, true)

    saveSetting("MCP_ServerURL", SERVER_URL)
    saveSetting("MCP_PollInterval", POLL_INTERVAL)
    saveSetting("MCP_ClientName", CLIENT_NAME)
    saveSetting("MCP_StatusCheckInterval", statusCheckInterval)
    saveSetting("MCP_Enabled", mcpEnabled)
    saveSetting("MCP_ShowStatusWidget", showStatusWidget)
    saveSetting("MCP_VerboseLogging", verboseLogging)
    saveSetting("MCP_SafetyEnabled", safetyEnabled)

    if statusGui then statusGui.Enabled = showStatusWidget end

    feedbackLabel.Text = "Reset to defaults - reconnecting..."
    feedbackLabel.TextColor3 = COLORS.on
    log("[MCP] Settings reset to defaults")

    if mcpEnabled then
        startPolling()
    else
        stopPolling()
    end
end)

-- Connection status GUI (small ambient corner widget, toggleable from settings)
statusGui = Instance.new("ScreenGui")
statusGui.Name = "MCPStatusGui"
statusGui.ResetOnSpawn = false
statusGui.IgnoreGuiInset = true
statusGui.Enabled = showStatusWidget
statusGui.Parent = game:GetService("CoreGui")

local statusFrame = Instance.new("Frame")
statusFrame.Name = "MCPStatusFrame"
statusFrame.Size = UDim2.new(0, 120, 0, 28)
statusFrame.Position = UDim2.new(1, -130, 1, -38)
statusFrame.BackgroundColor3 = Color3.fromRGB(13, 13, 15)
statusFrame.BackgroundTransparency = 0.15
statusFrame.BorderColor3 = Color3.fromRGB(31, 31, 35)
statusFrame.BorderSizePixel = 1
statusFrame.Parent = statusGui

local statusDot = Instance.new("Frame")
statusDot.Name = "MCPStatusDot"
statusDot.Size = UDim2.new(0, 6, 0, 6)
statusDot.Position = UDim2.new(0, 10, 0, 11)
statusDot.BackgroundColor3 = Color3.fromRGB(82, 82, 91)
statusDot.BorderSizePixel = 0
statusDot.Parent = statusFrame

local statusLabel = Instance.new("TextLabel")
statusLabel.Name = "MCPStatusLabel"
statusLabel.Size = UDim2.new(1, -22, 1, 0)
statusLabel.Position = UDim2.new(0, 22, 0, 0)
statusLabel.BackgroundTransparency = 1
statusLabel.Text = "MCP: checking..."
statusLabel.TextColor3 = Color3.fromRGB(82, 82, 91)
statusLabel.TextSize = 10
statusLabel.Font = Enum.Font.Code
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.Parent = statusFrame

local function updateStatus(connected, text)
    statusLabel.Text = text or ("MCP: " .. (connected and "connected" or "offline"))
    statusDot.BackgroundColor3 = connected and Color3.fromRGB(34, 197, 94) or Color3.fromRGB(82, 82, 91)
    panelStatusLabel.Text = connected and ("Connected - " .. SERVER_URL) or ("Offline - " .. SERVER_URL)
    panelDot.BackgroundColor3 = connected and Color3.fromRGB(34, 197, 94) or COLORS.off
end

-- Start periodic status check (uses its own timer, independent of the poll loop)
local statusCheckConn
local lastStatusCheck = 0
local function startStatusCheck()
    if statusCheckConn then return end
    lastStatusCheck = 0
    statusCheckConn = game:GetService("RunService").Heartbeat:Connect(function()
        if os.clock() - lastStatusCheck >= statusCheckInterval then
            lastStatusCheck = os.clock()
            pcall(function()
                local data, err = httpGet("/status")
                if data and data.pluginConnected then
                    updateStatus(true, "MCP: connected")
                else
                    updateStatus(false, "MCP: offline")
                end
            end)
        end
    end)
end
startStatusCheck()

-- ===========================================
-- HOT RELOAD (dev convenience)
-- The server exposes /plugin-update-flag and /plugin-update so an
-- already-running plugin can pick up edits to plugin.lua without
-- re-inserting the script into Studio by hand. Best-effort: if the new
-- source fails to compile, the running plugin is left untouched.
-- ===========================================
local reloadCheckConn

local function teardown()
    if tickConn then tickConn:Disconnect(); tickConn = nil end
    if statusCheckConn then statusCheckConn:Disconnect(); statusCheckConn = nil end
    if reloadCheckConn then reloadCheckConn:Disconnect(); reloadCheckConn = nil end
    if statusGui then statusGui:Destroy(); statusGui = nil end
    if settingsGui then settingsGui:Destroy(); settingsGui = nil end
    if MCP_CACHE.clickConn then
        pcall(function() MCP_CACHE.clickConn:Disconnect() end)
        MCP_CACHE.clickConn = nil
    end
end

local lastReloadFlag = nil
local function tryHotReload()
    local flagData = httpGet("/plugin-update-flag")
    if not flagData or not flagData.flag then return end

    if lastReloadFlag == nil then
        lastReloadFlag = flagData.flag -- first check just establishes a baseline
        return
    end
    if flagData.flag == lastReloadFlag then return end

    local updateData = httpGet("/plugin-update")
    if not updateData or not updateData.source then
        log("[MCP] Reload flag changed but failed to fetch new source")
        return
    end

    local newFn, compileErr = loadstring(updateData.source)
    if not newFn then
        log("[MCP] New plugin source has a syntax error, not reloading: " .. tostring(compileErr))
        return
    end

    log("[MCP] Reloading plugin from updated source...")
    lastReloadFlag = flagData.flag
    teardown()
    setfenv(newFn, getfenv())
    local ok, err = pcall(newFn)
    if not ok then
        warn("[MCP] Hot reload failed: " .. tostring(err))
    end
end

local RELOAD_CHECK_INTERVAL = 5
local lastReloadCheck = 0
reloadCheckConn = RunService.Heartbeat:Connect(function()
    if os.clock() - lastReloadCheck >= RELOAD_CHECK_INTERVAL then
        lastReloadCheck = os.clock()
        pcall(tryHotReload)
    end
end)

-- Cleanup on plugin unload
MCP_CACHE.unloadConn = plugin.Unloading:Connect(function()
    teardown()
    -- Only on full unload do we release the toolbar button
    pcall(function() toggleBtn:Destroy() end)
    pcall(function() toolbar:Destroy() end)
    _G.KORONE_MCP_CACHE = nil
    log("[MCP] Plugin unloaded")
end)
