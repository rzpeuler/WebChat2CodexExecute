import { main } from './lib/cli.mjs';
import { validateGovernance } from './lib/manifest.mjs';

await main(async (input) => validateGovernance(input));
