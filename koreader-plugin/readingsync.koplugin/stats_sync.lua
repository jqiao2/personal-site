-- Reading sync: read the statistics database, send what the server doesn't have.
--
-- All the logic that isn't UI lives here so main.lua stays a thin layer of
-- menus and event handlers.
--
-- Approach follows KoInsight (github.com/GeorgeSG/KoInsight, MIT) — the same
-- SQ3 + socket.http idioms, since that is simply how a KOReader plugin talks to
-- a database and a network. What differs is the payload, the bearer auth, and
-- that this syncs incrementally from a server-held cursor rather than
-- re-uploading the whole statistics database every time.

local DataStorage = require("datastorage")
local JSON = require("json")
local SQ3 = require("lua-ljsqlite3/init")
local http = require("socket.http")
local logger = require("logger")
local ltn12 = require("ltn12")
local socket = require("socket")
local socketutil = require("socketutil")

local Sync = {}

local DB_PATH = DataStorage:getSettingsDir() .. "/statistics.sqlite3"

-- Rows per request. The endpoint caps a batch at 5000; this is far below that
-- because a Kindle has little memory and a flaky connection, and a sync that
-- has to resume is cheaper when its unit of work is small.
local CHUNK = 400

-- A safety valve, not a limit anyone should hit: one sync run will not loop
-- more than this many times. Guards against a pathological cursor.
local MAX_CHUNKS = 200

-- The endpoint rejects timestamps this far ahead, so there is no point sending
-- them. A Kindle that has been off for months boots with a stale clock, and one
-- row from 2087 would otherwise fail an entire batch.
local FUTURE_TOLERANCE = 24 * 60 * 60

-- How far back of the server's cursor to start reading anyway.
--
-- The cursor arrives as a UTC string and has to become a local epoch, which
-- means os.time/os.date and their DST handling. The two failure directions are
-- not symmetric: starting too early resends rows the server discards for free,
-- while starting too late skips them permanently. So we deliberately start a
-- day early and let the uniqueness constraint absorb it. A day of reading is a
-- few hundred rows — one chunk, tens of kilobytes.
local CURSOR_SAFETY_MARGIN = 24 * 60 * 60

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

--- Trimmed non-empty string, or nil.
--
-- KOReader stores the literal string "N/A" where an EPUB carries no metadata.
-- Left alone it becomes a book by an author named N/A; nil is omitted from the
-- JSON entirely, which is what the server reads as "absent".
local function str(v)
	if type(v) ~= "string" then
		return nil
	end
	local t = v:match("^%s*(.-)%s*$")
	if t == "" or t:upper() == "N/A" then
		return nil
	end
	return t
end

--- A positive integer, or nil. KOReader reports 0 pages for a book it has not
--- finished laying out; the server's column requires > 0.
local function pos_int(v)
	local n = tonumber(v)
	if n == nil then
		return nil
	end
	n = math.floor(n)
	if n <= 0 then
		return nil
	end
	return n
end

--- lua-ljsqlite3 returns results COLUMN-major: result[column][row], both
--- 1-based, with the row count as the second return. Wrapping it here keeps
--- that surprise in one place.
local function query(conn, sql)
	local result, rows = conn:exec(sql)
	if result == nil or rows == nil or rows == 0 then
		return nil, 0
	end
	return result, rows
end

--- Values arrive as LuaJIT cdata for integer columns, which JSON.encode cannot
--- serialise. tonumber on the way out of every column is not optional.
local function num(result, col, row)
	return tonumber(result[col][row])
end

local function text(result, col, row)
	local v = result[col][row]
	if v == nil then
		return nil
	end
	return str(tostring(v))
end

-- ---------------------------------------------------------------------------
-- HTTP
-- ---------------------------------------------------------------------------

--- One request. Returns ok, decoded_body_or_error_string, status_code.
local function request(method, url, token, body)
	local sink = {}
	local headers = {
		["Authorization"] = "Bearer " .. token,
	}
	if body ~= nil then
		headers["Content-Type"] = "application/json"
		headers["Content-Length"] = tostring(#body)
	end

	socketutil:set_timeout(socketutil.LARGE_BLOCK_TIMEOUT, socketutil.LARGE_TOTAL_TIMEOUT)
	local code, _headers, status = socket.skip(1, http.request({
		method = method,
		url = url,
		headers = headers,
		source = body and ltn12.source.string(body) or nil,
		sink = ltn12.sink.table(sink),
	}))
	socketutil:reset_timeout()

	if _headers == nil then
		logger.err("[readingsync] network error:", status or code)
		return false, "no network", nil
	end

	local content = table.concat(sink)
	if code ~= 200 then
		local message = content
		local ok, decoded = pcall(JSON.decode, content)
		if ok and type(decoded) == "table" and decoded.error then
			message = decoded.error
		end
		logger.err("[readingsync] HTTP", code, message)
		return false, string.format("HTTP %s: %s", tostring(code), tostring(message)), code
	end

	local ok, decoded = pcall(JSON.decode, content)
	if not ok or type(decoded) ~= "table" then
		return false, "server response was not JSON", code
	end
	return true, decoded, code
end

-- ---------------------------------------------------------------------------
-- Reading the statistics database
-- ---------------------------------------------------------------------------

--- Sessions with start_time >= `since`, ordered, one page of `limit` at
--- `offset`.
---
--- The join is the whole point: KOReader keys page stats by `id_book`, a local
--- autoincrement that differs on every device and means nothing to the server.
--- md5 is the only stable identifier, and it lives on the book row.
---
--- Paginated by OFFSET rather than by advancing the timestamp, because many
--- rows can share one second — a cursor that moved past them would skip them,
--- and a cursor that included them would never advance.
local function read_sessions(conn, since, offset, limit)
	local sql = string.format(
		[[SELECT b.md5, s.page, s.start_time, s.duration, s.total_pages
		  FROM page_stat_data s
		  JOIN book b ON b.id = s.id_book
		  WHERE b.md5 IS NOT NULL AND b.md5 != '' AND s.start_time >= %d
		  ORDER BY s.start_time, s.page
		  LIMIT %d OFFSET %d]],
		since,
		limit,
		offset
	)
	local result, rows = query(conn, sql)
	if rows == 0 then
		return {}
	end

	local now = os.time()
	local sessions = {}
	for i = 1, rows do
		local md5 = text(result, 1, i)
		local page = num(result, 2, i)
		local start_time = num(result, 3, i)
		local duration = num(result, 4, i)

		-- The endpoint rejects a whole batch over one bad row, on purpose: a
		-- silent partial insert is worse than a loud refusal. So anything it
		-- would refuse is dropped here instead.
		local usable = md5 ~= nil
			and page ~= nil
			and page > 0
			and start_time ~= nil
			and start_time > 0
			and start_time <= now + FUTURE_TOLERANCE
			and duration ~= nil
			and duration >= 0

		if usable then
			table.insert(sessions, {
				book_md5 = md5:lower(),
				page = math.floor(page),
				start_time = math.floor(start_time),
				duration = math.floor(duration),
				total_pages = pos_int(num(result, 5, i)),
			})
		end
	end
	return sessions
end

--- Metadata for exactly the books a given batch of sessions mentions.
local function read_books(conn, md5s)
	if next(md5s) == nil then
		return {}
	end

	local quoted = {}
	for md5 in pairs(md5s) do
		-- md5s come from the database and are hex, but quote-escape anyway
		-- rather than trust that.
		table.insert(quoted, "'" .. md5:gsub("'", "''") .. "'")
	end

	local sql = string.format(
		[[SELECT md5, title, authors, series, language, pages
		  FROM book WHERE lower(md5) IN (%s)]],
		table.concat(quoted, ",")
	)
	local result, rows = query(conn, sql)
	if rows == 0 then
		return {}
	end

	local books = {}
	for i = 1, rows do
		local md5 = text(result, 1, i)
		if md5 then
			md5 = md5:lower()
			table.insert(books, {
				md5 = md5,
				-- A book with no title still has a reading history worth
				-- keeping. Give it something addressable rather than dropping
				-- it and orphaning its sessions.
				title = text(result, 2, i) or ("Untitled (" .. md5:sub(1, 8) .. ")"),
				authors = text(result, 3, i),
				series = text(result, 4, i),
				language = text(result, 5, i),
				total_pages = pos_int(num(result, 6, i)),
			})
		end
	end
	return books
end

-- ---------------------------------------------------------------------------
-- The sync itself
-- ---------------------------------------------------------------------------

--- Push everything the server does not already have.
---
--- Returns a table: { ok, sent, inserted, chunks, message }.
---
--- Safe to call at any time and as often as you like. The server's uniqueness
--- constraint on (book, page, timestamp) discards anything it already holds, so
--- the worst case of an over-eager sync is wasted bytes.
function Sync.run(settings)
	local url = settings.server_url
	local token = settings.sync_token
	local device = settings.device or "kindle"

	if url == nil or url == "" or token == nil or token == "" then
		return { ok = false, message = "Set the server URL and token first" }
	end
	url = url:gsub("/+$", "")

	local endpoint = url .. "/api/reading/sync"

	-- Ask the server what it already has. This is the source of truth rather
	-- than a locally remembered cursor: it survives a settings reset, a restored
	-- backup, or a second device, and it is one small request.
	local ok, cursor = request("GET", endpoint .. "?device=" .. device, token)
	if not ok then
		return { ok = false, message = tostring(cursor) }
	end

	local since = 0
	if type(cursor.latest_session_at) == "string" then
		local y, m, d, hh, mm, ss = cursor.latest_session_at:match(
			"(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)"
		)
		if y then
			-- The cursor is UTC; os.time interprets a table as local time, so
			-- correct by the offset between the two.
			local as_local = os.time({
				year = tonumber(y),
				month = tonumber(m),
				day = tonumber(d),
				hour = tonumber(hh),
				min = tonumber(mm),
				sec = tonumber(ss),
				isdst = false,
			})
			local now = os.time()
			local offset = os.difftime(now, os.time(os.date("!*t", now)))
			since = as_local + offset - CURSOR_SAFETY_MARGIN
			if since < 0 then
				since = 0
			end
		end
	end

	local conn = SQ3.open(DB_PATH)
	if conn == nil then
		return { ok = false, message = "Could not open the statistics database" }
	end

	local sent, inserted, chunks = 0, 0, 0
	local offset = 0
	local result = { ok = true }

	while chunks < MAX_CHUNKS do
		local sessions = read_sessions(conn, since, offset, CHUNK)
		if #sessions == 0 then
			break
		end

		local md5s = {}
		for _, s in ipairs(sessions) do
			md5s[s.book_md5] = true
			s.device = device
		end

		local payload = JSON.encode({
			device = device,
			books = read_books(conn, md5s),
			sessions = sessions,
		})

		local posted, response = request("POST", endpoint, token, payload)
		if not posted then
			result = { ok = false, message = tostring(response) }
			break
		end

		sent = sent + (tonumber(response.sessions_received) or 0)
		inserted = inserted + (tonumber(response.sessions_inserted) or 0)
		chunks = chunks + 1
		offset = offset + CHUNK

		-- A short chunk means the query is drained; no need for another round
		-- trip to discover that.
		if #sessions < CHUNK then
			break
		end
	end

	conn:close()

	result.sent = sent
	result.inserted = inserted
	result.chunks = chunks
	if result.ok then
		result.message = string.format("%d sent, %d new", sent, inserted)
	end
	logger.info("[readingsync]", result.message)
	return result
end

Sync.DB_PATH = DB_PATH

return Sync
