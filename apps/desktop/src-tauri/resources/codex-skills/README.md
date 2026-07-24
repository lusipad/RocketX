Bundled Codex skills for RocketX.

- `azure-devops-server/` is vendored from
  <https://github.com/lusipad/azure-devops-server-skill> commit
  `293b09774cf9d1ef880a889baf212a9b661e0a75`, skill tree
  `0cc00597153f26ab6ec7e50197dbae82ffb35206`.
- The 19 files under that directory are copied as-is for Codex skill discovery
  and remain under the MIT license in `LICENSE.azure-devops-server.txt`.
- `azure-devops-server-host-adapter.ps1` is RocketX's fixed host adapter. It only maps stdin JSON into the vendored `Invoke-AzureDevOpsServerApi.ps1` entrypoint so PATs never appear in argv.
