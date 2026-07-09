



local LINE_LENGTH = false

local IGNORE = {
	-- rules
	"1..", -- globals
	"4..", -- shadowing and redefinition

}

local NOT_GLOBALS = {
    "coroutine",
    "io",
    "socket",
    "dofile",
    "loadfile",
}

std = "lua52"

ignore = IGNORE
not_globals = NOT_GLOBALS

quiet = 1
codes = true

max_cyclomatic_complexity = false

max_line_length = LINE_LENGTH
max_code_line_length = LINE_LENGTH
max_string_line_length = LINE_LENGTH
max_comment_line_length = LINE_LENGTH

exclude_files = {
    "**/.trash/",
    "**/.history/",
    "**/stdlib/vendor/",
    "**/combat-tester/",
    "**/test-maker/",
    "**/trailer/",
    "**/love/includes/",
    "**/luaunit.lua",
    "**/factorio-runtime-api.lua",
    "**/.io",
    "**/docs/",
    "**/.vscode/",
    "**/*luaunit.lua",
}

