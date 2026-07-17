# create-rcx-app

Scaffold, validate, and preview a RocketX application without weakening the host sandbox.

```bash
npx create-rcx-app my-app
cd my-app
npx rcx-app validate
npx rcx-app dev
```

Available templates: `hello`, `kanban`, `poll`, and `oncall`.

`rcx-app dev` binds to `127.0.0.1` and provides a mock Bridge plus automatic browser refresh.
Install the directory in RocketX to verify real permissions and host capabilities.
