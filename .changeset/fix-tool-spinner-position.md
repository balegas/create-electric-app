---
"@electric-agent/studio": patch
---

Move loading spinner from collapsed tool group header to the last tool line. Individual ToolExecution components already show their own spinners, so the group header spinner was redundant and misplaced.
