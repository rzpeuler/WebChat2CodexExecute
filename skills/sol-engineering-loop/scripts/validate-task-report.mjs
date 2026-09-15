import { main } from './lib/cli.mjs';
import { validateTaskReport } from './lib/report.mjs';

await main(async (input) => validateTaskReport(input));
