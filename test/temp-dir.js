import { rmSync } from 'fs';

// Teardown for a test's temp folder. Windows refuses to remove a folder while
// any process still has it as its working directory or a file in it open
// (EBUSY/EPERM), and a just-exited child can hold it a moment longer; Node's
// own retry waits that out. A folder that still won't go is a leak in the temp
// dir, not a failure of the test that already passed, so it only warns.
export function removeTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    console.warn(`Could not remove temp dir ${dir}: ${err.message}`);
  }
}
