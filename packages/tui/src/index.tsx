#!/usr/bin/env node
import React from "react"
import { render } from "ink"
import meow from "meow"
import { App } from "./app.js"
import { setConfigPath, loadConfig } from "./lib/config.js"
import { runHeadless } from "./headless.js"

const cli = meow(
	`
  Usage
    $ electric-tui [options]
    $ electric-tui --one-line "Build a todo app"

  Options
    --server, -s      Server URL (default: http://localhost:4400)
    --config, -c      Config file path (default: ~/.electric-agent/config.json)
    --one-line, -o    Headless mode: create room, print join code, wait
    --version         Show version
    --help            Show help

  Shortcuts (interactive mode)
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
    $ electric-tui --one-line "A collaborative task board with drag and drop"
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
			oneLine: {
				type: "string",
				shortFlag: "o",
			},
		},
	},
)

if (cli.flags.config) {
	setConfigPath(cli.flags.config)
}

if (cli.flags.oneLine) {
	const config = loadConfig()
	const baseUrl = cli.flags.server ?? config.server
	runHeadless(cli.flags.oneLine, baseUrl, config)
} else {
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
}
