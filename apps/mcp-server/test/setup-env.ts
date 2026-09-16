// Loaded by the test scripts with `--import`. Tests that call `startSession`
// directly would otherwise write under the developer's real ~/.autodemo;
// pinning AUTODEMO_HOME to the OS temp dir keeps the suite out of $HOME.
// Every such test still removes its own session directory. A value set by the
// caller wins.
import os from "node:os";
import path from "node:path";

process.env.AUTODEMO_HOME ??= path.join(os.tmpdir(), "autodemo-tests");
