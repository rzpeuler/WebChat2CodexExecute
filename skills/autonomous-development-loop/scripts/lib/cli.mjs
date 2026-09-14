import { readFile } from 'node:fs/promises';

export function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2).replaceAll('-', '_');
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    result[key] = value;
    i += 1;
  }
  return result;
}

export async function readJsonInput(argv) {
  const args = parseArgs(argv);
  if (args.input === undefined) throw new Error('--input is required');
  return JSON.parse(await readFile(args.input, 'utf8'));
}

export function emit(result, exitCode = result.ok === false ? 1 : 0) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = exitCode;
}

export async function main(run) {
  try {
    const result = await run(await readJsonInput(process.argv.slice(2)));
    emit(result, result.ok === false ? result.exit_code ?? 1 : 0);
  } catch (error) {
    emit(
      {
        ok: false,
        code: error?.code ?? 'TOOL_FAILED',
        message: redact(String(error?.message ?? error)),
      },
      error?.exitCode ?? 1,
    );
  }
}

export function redact(value) {
  return String(value)
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/([?&](?:token|password|secret|key|auth)[^=]*=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 4000);
}
