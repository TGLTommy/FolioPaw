/**
 * Tests truncate tables and recursively delete the upload directory. Running
 * them against the real runtime paths destroys the local library, so refuse to
 * start unless the isolated test paths from the `test` npm script are in place.
 * This guard runs before any test module (and therefore before
 * config/database.ts opens a connection).
 */
const DB_PATH = process.env.DB_PATH;
const UPLOAD_DIR = process.env.UPLOAD_DIR;

if (DB_PATH !== ':memory:') {
  throw new Error(
    `Refusing to run tests against DB_PATH="${DB_PATH ?? '(unset, defaults to backend/data/database.sqlite)'}". `
    + 'Run "npm test" instead of invoking vitest directly, or set DB_PATH=:memory:.'
  );
}

if (!UPLOAD_DIR || !/(^|\/)(tmp|temp)(\/|$)/i.test(UPLOAD_DIR)) {
  throw new Error(
    `Refusing to run tests against UPLOAD_DIR="${UPLOAD_DIR ?? '(unset, defaults to backend/uploads)'}". `
    + 'Tests delete this directory recursively; point it at a temporary path, e.g. /tmp/foliopaw-test-uploads.'
  );
}
