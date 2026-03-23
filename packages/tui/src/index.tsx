#!/usr/bin/env node
import React from "react"
import { render } from "ink"
import meow from "meow"
import { App } from "./app.js"
import { setConfigPath } from "./lib/config.js"

const cli = meow(
	`
  Usage
    $ electric-tui [options]

  Options
    --server, -s    Server URL (default: http://localhost:4400)
    --config, -c    Config file path (default: ~/.electric-agent/config.json)
    --version       Show version
    --help          Show help

  Shortcuts
    Ctrl+B/F      Switch tabs (back/forward)
    Ctrl+D        Close current tab / delete session
    Ctrl+S        Settings
    Ctrl+G        Respond to gate
    Ctrl+N        Go to home
    Ctrl+Q        Quit
    Esc           Dismiss overlay / go back

  Examples
    $ electric-tui
    $ electric-tui --server http://localhost:4400
`,
	{
		importMeta: import.meta,
		flags: {
			server: {
				type: "string",
				shortFlag: "s",
			},
			config: {
				type: "string",
				shortFlag: "c",
			},
		},
	},
)

if (cli.flags.config) {
	setConfigPath(cli.flags.config)
}

// Enter alternate screen buffer for cleaner rendering (less flicker)
const ENTER_ALT_SCREEN = "\x1b[?1049h"
const EXIT_ALT_SCREEN = "\x1b[?1049l"

process.stdout.write(ENTER_ALT_SCREEN)

const { waitUntilExit } = render(<App serverUrl={cli.flags.server} />, {
	patchConsole: false,
})

waitUntilExit().then(() => {
	process.stdout.write(EXIT_ALT_SCREEN)
})
