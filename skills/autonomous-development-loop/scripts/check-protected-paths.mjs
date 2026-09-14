import { main } from './lib/cli.mjs';
import { checkPaths } from './lib/path-policy.mjs';

await main(async (input) => {
  if (!Array.isArray(input?.paths)) return { ok: false, code: 'PATHS_REQUIRED', message: 'paths must be an array' };
  const result = checkPaths(input.paths, Array.isArray(input.protected_paths) ? input.protected_paths : []);
  return { ...result, code: result.ok ? 'OK' : 'PATH_POLICY_REJECTED' };
});
