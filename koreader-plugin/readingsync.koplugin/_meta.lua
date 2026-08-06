local _ = require("gettext")

-- No `name` here: KOReader takes it from the plugin's directory, and as of
-- v2026.07 setting it warns that the value is deprecated and ignored.
return {
	fullname = _("Reading sync"),
	description = _([[Sends KOReader's reading statistics to your own site as you read.]]),
}
