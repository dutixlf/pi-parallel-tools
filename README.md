# pi-parallel-tools

Extends pi's built-in tools with background execution.

- `bash`, `read`, `grep`, `find`, `ls` accept `background: true`: the call returns a job id immediately and the result is delivered later.
- `job_poll` checks jobs, waits for them (`wait_ms`, `wait_for: any|all`), collects results, or cancels them (`cancel: true`).
- Finished jobs nobody is polling notify the model automatically.
- `/jobs` lists background jobs; `/jobs kill <id|all>` cancels them.

## Install

```bash
pi install git:github.com/dutixlf/pi-parallel-tools
```

Then run `/reload` in a running session.

Note: the wrapped built-ins are rebuilt with default options, so custom bash settings (shell path, command prefix, spawn hook) are ignored.
