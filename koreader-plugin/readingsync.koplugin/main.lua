-- Reading sync: menus, settings, and the events that make it hands-off.
--
-- The point of the plugin is that you never think about it. You open a book,
-- you read, you close it — and the pages show up on the site. Everything here
-- is in service of that: the manual "Sync now" exists for setup and for when
-- you want reassurance, not as the normal path.

local ConfirmBox = require("ui/widget/confirmbox")
local DataStorage = require("datastorage")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local LuaSettings = require("luasettings")
local NetworkMgr = require("ui/network/manager")
-- Named for specificity, not style: a plugin's own directory goes on
-- package.path, and a module called "sync" is a collision waiting to happen.
local Sync = require("stats_sync")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local logger = require("logger")
local _ = require("gettext")

-- KOReader's statistics plugin writes its rows on its own schedule, and plugin
-- event order is not guaranteed. Waiting a beat after a document closes means
-- we read the database after it has flushed, not before.
local FLUSH_DELAY_SECONDS = 3

local ReadingSync = WidgetContainer:extend({
	name = "readingsync",
	is_doc_only = false,
})

function ReadingSync:init()
	self.settings = LuaSettings:open(DataStorage:getSettingsDir() .. "/readingsync.lua")
	if self.ui and self.ui.menu then
		self.ui.menu:registerToMainMenu(self)
	end
end

function ReadingSync:config()
	return {
		server_url = self.settings:readSetting("server_url"),
		sync_token = self.settings:readSetting("sync_token"),
		device = self.settings:readSetting("device") or "kindle-pw5",
	}
end

function ReadingSync:isConfigured()
	local c = self:config()
	return c.server_url ~= nil and c.server_url ~= "" and c.sync_token ~= nil and c.sync_token ~= ""
end

-- ---------------------------------------------------------------------------
-- Menu
-- ---------------------------------------------------------------------------

function ReadingSync:addToMainMenu(menu_items)
	menu_items.readingsync = {
		text = _("Reading sync"),
		-- "more_tools", not "tools". A plugin's menu item is an orphan as far as
		-- the menu sorter is concerned, and an orphan is appended to the END of
		-- whatever it points at — so "tools" buries it below "More tools", off
		-- the bottom of the first page on a Paperwhite. Tools -> More tools is
		-- also where every other third-party plugin puts itself.
		sorting_hint = "more_tools",
		sub_item_table = {
			{
				text = _("Sync now"),
				keep_menu_open = true,
				callback = function()
					self:syncNow()
				end,
			},
			{
				text = _("Sync when a book is closed"),
				checked_func = function()
					return self.settings:readSetting("sync_on_close") ~= false
				end,
				callback = function()
					local on = self.settings:readSetting("sync_on_close") ~= false
					self.settings:saveSetting("sync_on_close", not on)
					self.settings:flush()
				end,
			},
			{
				text = _("Sync when going to sleep"),
				checked_func = function()
					return self.settings:readSetting("sync_on_suspend") ~= false
				end,
				callback = function()
					local on = self.settings:readSetting("sync_on_suspend") ~= false
					self.settings:saveSetting("sync_on_suspend", not on)
					self.settings:flush()
				end,
				separator = true,
			},
			{
				text_func = function()
					local url = self.settings:readSetting("server_url")
					return url and (_("Server: ") .. url) or _("Set server URL")
				end,
				keep_menu_open = true,
				callback = function(touchmenu_instance)
					self:editSetting("server_url", _("Server URL"), "https://example.com", function()
						if touchmenu_instance then
							touchmenu_instance:updateItems()
						end
					end)
				end,
			},
			{
				text_func = function()
					local token = self.settings:readSetting("sync_token")
					-- Never render the token. A Kindle screen is a public
					-- surface and the value is a bearer credential.
					return token and _("Token: set") or _("Set sync token")
				end,
				keep_menu_open = true,
				callback = function(touchmenu_instance)
					self:editSetting("sync_token", _("Sync token"), "", function()
						if touchmenu_instance then
							touchmenu_instance:updateItems()
						end
					end)
				end,
			},
			{
				text_func = function()
					return _("Device name: ") .. self:config().device
				end,
				keep_menu_open = true,
				callback = function(touchmenu_instance)
					self:editSetting("device", _("Device name"), "kindle-pw5", function()
						if touchmenu_instance then
							touchmenu_instance:updateItems()
						end
					end)
				end,
				separator = true,
			},
			{
				text_func = function()
					local last = self.settings:readSetting("last_result")
					return last and (_("Last sync: ") .. last) or _("Last sync: never")
				end,
				keep_menu_open = true,
				callback = function() end,
			},
		},
	}
end

function ReadingSync:editSetting(key, title, hint, on_saved)
	local dialog
	dialog = InputDialog:new({
		title = title,
		input = self.settings:readSetting(key) or "",
		input_hint = hint,
		buttons = {
			{
				{
					text = _("Cancel"),
					id = "close",
					callback = function()
						UIManager:close(dialog)
					end,
				},
				{
					text = _("Save"),
					is_enter_default = true,
					callback = function()
						local value = dialog:getInputText()
						if value == "" then
							value = nil
						elseif key == "server_url" then
							value = value:gsub("/+$", "")
						end
						self.settings:saveSetting(key, value)
						self.settings:flush()
						UIManager:close(dialog)
						if on_saved then
							on_saved()
						end
					end,
				},
			},
		},
	})
	UIManager:show(dialog)
	dialog:onShowKeyboard()
end

-- ---------------------------------------------------------------------------
-- Syncing
-- ---------------------------------------------------------------------------

--- Manual sync: says what happened, including when nothing happened.
function ReadingSync:syncNow()
	if not self:isConfigured() then
		UIManager:show(InfoMessage:new({
			text = _("Set the server URL and sync token first."),
		}))
		return
	end

	if not NetworkMgr:isOnline() then
		NetworkMgr:promptWifiOn()
		return
	end

	local info = InfoMessage:new({ text = _("Syncing reading statistics…") })
	UIManager:show(info)
	UIManager:forceRePaint()

	local result = Sync.run(self:config())
	UIManager:close(info)
	self:remember(result)

	UIManager:show(InfoMessage:new({
		text = result.ok and (_("Reading sync: ") .. result.message)
			or (_("Reading sync failed: ") .. tostring(result.message)),
		timeout = result.ok and 2 or nil,
	}))
end

--- Background sync: silent unless it is worth interrupting for, which it never
--- is. A failed automatic sync is not an error — the rows are still on the
--- device and the next sync will carry them.
function ReadingSync:syncQuietly(reason)
	if not self:isConfigured() then
		return
	end
	if not NetworkMgr:isOnline() then
		logger.dbg("[readingsync] skipping", reason, "sync: offline")
		return
	end

	logger.info("[readingsync] background sync:", reason)
	local ok, result = pcall(Sync.run, self:config())
	if ok then
		self:remember(result)
	else
		logger.err("[readingsync] background sync crashed:", tostring(result))
	end
end

function ReadingSync:remember(result)
	local stamp = os.date("%Y-%m-%d %H:%M")
	local text = result.ok and string.format("%s (%s)", result.message, stamp)
		or string.format("failed, %s", stamp)
	self.settings:saveSetting("last_result", text)
	self.settings:flush()
end

-- ---------------------------------------------------------------------------
-- Events — the hands-off part
-- ---------------------------------------------------------------------------

--- Closing a book is the natural sync point: the statistics for the session
--- just ended are complete, and you are not mid-page.
function ReadingSync:onCloseDocument()
	if self.settings:readSetting("sync_on_close") == false then
		return
	end
	-- Deferred so the statistics plugin has flushed, and so closing a book
	-- never feels like it is waiting on the network.
	UIManager:scheduleIn(FLUSH_DELAY_SECONDS, function()
		self:syncQuietly("document close")
	end)
end

--- Sleep catches the case where a book is left open for weeks — which, on a
--- Kindle, is most of the time.
function ReadingSync:onSuspend()
	if self.settings:readSetting("sync_on_suspend") == false then
		return
	end
	self:syncQuietly("suspend")
end

return ReadingSync
