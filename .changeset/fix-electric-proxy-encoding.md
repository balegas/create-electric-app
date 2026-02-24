---
"electric-agent": patch
---

Fix broken API responses in browser by removing Accept-Encoding forwarding in Electric proxy

The Electric shape proxy was forwarding the browser's `Accept-Encoding` header to the Electric service, which caused Electric to respond with `zstd`-compressed content. Node.js `fetch` doesn't auto-decompress zstd, so the raw compressed bytes were passed through to the browser, completely breaking Electric SQL shape parsing. Requests via curl (which doesn't advertise zstd) worked fine, but all browser requests failed.
