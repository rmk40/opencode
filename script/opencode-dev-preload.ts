// Preload shim used by script/oc-wrapper.sh.
//
// bun's --cwd flag is required for module resolution to find the workspace's
// node_modules graph, but that also sets process.cwd() to the package dir,
// which would make opencode treat the package dir as the user's project dir.
//
// This preload runs before src/index.ts and restores the user's original
// working directory so opencode's process.cwd() matches what the user typed
// the command in — exactly mirroring the behavior of running a built
// `opencode` binary from any project directory.
const userPwd = process.env.OPENCODE_USER_PWD
if (userPwd) process.chdir(userPwd)
