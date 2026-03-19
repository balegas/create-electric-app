---
"@electric-agent/studio": patch
"@electric-agent/agent": patch
---

Fix Sprites runtime: separate SPRITES_API_TOKEN from FLY_API_TOKEN, fix SDK compatibility with @fly/sprites 0.0.1-rc37, remove global session cap, stop logging agent prompts to UI, and lazy-load serve command to unblock scaffold in sprites.
