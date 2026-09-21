# Agent instructions

## Runtime

- Use the locally installed Node.js `24.20.0` for all install, build, test, pack, release, and publish commands in this repository.
- Before running a Node- or pnpm-based command, verify that the invoked executable is Node.js `24.20.0`. If the default `node` resolves to another version, locate and invoke the local `24.20.0` executable explicitly.

## Repository boundary

- This repository is the source project for [`agent-loop-snapshot`](https://github.com/SinglePoi/agent-loop-snapshot) and its `@agent-loop-snapshot/*` npm packages.
- Treat package sources under `packages/` as the authoritative implementation. Do not mistake a downstream consumer's installed packages, vendor tarballs, lockfiles, or local patches for this project's source of truth.

## Files outside this repository

- Before modifying any file outside this repository, report the exact target path, why the external change is needed, and the intended scope to the user.
- Wait for the user's explicit approval before making that external change. Do not infer that a path mentioned in an issue, document, or attachment is authorization to modify that external project.
