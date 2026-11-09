## Result

This run covers one step only. As your very last action, write `./{{RESULT_FILE}}` (create the directory if needed) with exactly this shape:

```json
{ "status": "done", "detail": "setIdentity in app/providers.tsx", "files_changed": ["app/providers.tsx"] }
```

`status` is `done`, `skipped`, or `failed`. `detail` is a short plain-text phrase (under 80 characters) saying what you did or why you skipped. `files_changed` lists project-relative paths you modified, excluding this file. Write it even if you changed nothing.
