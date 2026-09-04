# j41-dispatcher (npm alias)

This package exists so `npm install -g j41-dispatcher` installs **current**
Junction41 dispatcher, not frozen **2.0.0**.

It depends on `@junction41/dispatcher` at the same version and re-exports the
`j41-dispatcher` bin.

Canonical install is still:

```bash
npm install -g @junction41/dispatcher
```

## Maintainers — publish (do not run from `$HOME`)

The alias lives in this repo:

`j41-sovagent-dispatcher/packages/j41-dispatcher-alias/`

1. Log in as the npm user that owns `j41-dispatcher` (`autobb`). A 401 on
   `npm whoami` means there is no valid token on this machine.
2. Bump `version` and the `@junction41/dispatcher` dependency together with
   the scoped package.
3. From **this directory only**:

```bash
cd /path/to/j41-sovagent-dispatcher/packages/j41-dispatcher-alias
npm pack
# inspect the tarball; smoke-install into a scratch prefix
npm publish --access public
npm deprecate j41-dispatcher ""   # clear the 2.0.0 “frozen” message
```

Never `npm publish` from `~` or from the dispatcher repo root.
