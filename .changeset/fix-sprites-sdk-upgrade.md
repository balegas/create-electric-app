---
"@electric-agent/studio": patch
---

Upgrade @fly/sprites SDK from 0.0.1 to 0.0.1-rc37 to fix production sprite compatibility. The old SDK was incompatible with the current Sprites server due to field mapping changes (snake_case vs camelCase), missing URL fields, and control mode defaults. Also updates checkpoint/restore stream consumption to use the new CheckpointStream/RestoreStream API instead of raw Response objects.
