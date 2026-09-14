import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

function stripComment(value) {
  let quoted = false;
  let quote = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === '"' || char === "'") && (!i || value[i - 1] !== '\\')) {
      if (!quoted) {
        quoted = true;
        quote = char;
      } else if (quote === char) quoted = false;
    }
    if (char === '#' && !quoted && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd();
  }
  return value;
}

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed === '') return {};
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const body = trimmed.slice(1, -1).trim();
        return body === '' ? [] : body.split(',').map((item) => scalar(item));
      }
      throw new Error(`manifest supports JSON-style inline collections only: ${trimmed}`);
    }
  }
  return trimmed;
}

function keyValue(text) {
  const index = text.indexOf(':');
  if (index <= 0) throw new Error(`manifest mapping entry is invalid: ${text}`);
  return [text.slice(0, index).trim(), scalar(text.slice(index + 1))];
}

function parseBlock(lines, cursor, indent) {
  const list = lines[cursor]?.indent === indent && lines[cursor].text.startsWith('-');
  const value = list ? [] : {};
  while (cursor < lines.length && lines[cursor].indent === indent) {
    const line = lines[cursor];
    if (list !== line.text.startsWith('-')) break;
    if (list) {
      const rest = line.text.slice(1).trim();
      if (!rest) {
        if (lines[cursor + 1]?.indent <= indent) throw new Error('manifest list item has no value');
        const child = parseBlock(lines, cursor + 1, lines[cursor + 1].indent);
        value.push(child.value);
        cursor = child.cursor;
        continue;
      }
      if (!rest.includes(':')) {
        value.push(scalar(rest));
        cursor += 1;
        continue;
      }
      const [firstKey, firstValue] = keyValue(rest);
      const item = { [firstKey]: firstValue };
      cursor += 1;
      if (lines[cursor]?.indent > indent) {
        const child = parseBlock(lines, cursor, lines[cursor].indent);
        if (!child.value || Array.isArray(child.value) || typeof child.value !== 'object')
          throw new Error('manifest list mapping child must be an object');
        Object.assign(item, child.value);
        cursor = child.cursor;
      }
      value.push(item);
      continue;
    }
    const [key, itemValue] = keyValue(line.text);
    cursor += 1;
    if (itemValue && typeof itemValue === 'object' && !Array.isArray(itemValue) && Object.keys(itemValue).length === 0) {
      if (lines[cursor]?.indent > indent) {
        const child = parseBlock(lines, cursor, lines[cursor].indent);
        value[key] = child.value;
        cursor = child.cursor;
      } else value[key] = {};
    } else value[key] = itemValue;
  }
  return { value, cursor };
}

export function parseManifest(source) {
  const lines = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => {
      if (/\t/.test(line)) throw new Error(`manifest tabs are not supported at line ${index + 1}`);
      const text = stripComment(line.trimEnd());
      if (!text.trim()) return null;
      const indent = line.length - line.trimStart().length;
      return { indent, text: text.trimStart(), line: index + 1 };
    })
    .filter(Boolean);
  if (!lines.length) throw new Error('manifest is empty');
  const parsed = parseBlock(lines, 0, lines[0].indent);
  if (parsed.cursor !== lines.length || Array.isArray(parsed.value)) throw new Error('manifest root must be a mapping');
  return parsed.value;
}

function safeRelative(root, value) {
  const candidate = resolve(root, value);
  const rel = relative(resolve(root), candidate);
  const normalized = rel.replaceAll('\\', '/');
  return normalized === '' || (normalized !== '..' && !normalized.startsWith('../'));
}

export async function validateGovernance(input) {
  const repo = resolve(input.repo);
  const governanceRoot = input.governance_root ?? 'docs/governance';
  const root = resolve(repo, governanceRoot);
  const manifestPath = resolve(root, input.manifest_name ?? 'governance-manifest.yaml');
  const result = { ok: false, governance_root: governanceRoot, manifest_path: manifestPath };
  let source;
  try {
    const stats = await lstat(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('manifest is not a regular file');
    source = await readFile(manifestPath, 'utf8');
    const realRepo = await realpath(repo);
    const realManifest = await realpath(manifestPath);
    const rel = relative(realRepo, realManifest);
    const normalized = rel.replaceAll('\\', '/');
    if (normalized === '..' || normalized.startsWith('../')) throw new Error('manifest is outside repository');
  } catch (error) {
    return { ...result, code: 'GOVERNANCE_MANIFEST_MISSING_OR_UNSAFE', message: String(error.message ?? error) };
  }
  let manifest;
  try {
    manifest = parseManifest(source);
  } catch (error) {
    return { ...result, code: 'GOVERNANCE_MANIFEST_INVALID', message: String(error.message ?? error) };
  }
  if (manifest.version === undefined || !Array.isArray(manifest.documents))
    return { ...result, code: 'GOVERNANCE_MANIFEST_SCHEMA_INVALID', message: 'version and documents are required' };
  const ids = new Set();
  const invalid = [];
  for (const document of manifest.documents) {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      invalid.push('document is not an object');
      continue;
    }
    for (const field of ['id', 'path', 'audience', 'version', 'status']) {
      if (document[field] === undefined || document[field] === '' || (field === 'audience' && !Array.isArray(document[field])))
        invalid.push(`${field} is missing`);
    }
    if (ids.has(document.id)) invalid.push(`duplicate id: ${document.id}`);
    ids.add(document.id);
    if (typeof document.path === 'string' && !safeRelative(repo, document.path)) invalid.push(`path outside repository: ${document.path}`);
    if (!['active', 'candidate', 'history'].includes(document.status)) invalid.push(`invalid status: ${document.status}`);
  }
  if (invalid.length) return { ...result, code: 'GOVERNANCE_MANIFEST_SCHEMA_INVALID', message: invalid.join('; ') };
  const missingFiles = [];
  for (const document of manifest.documents) {
    const documentPath = resolve(repo, document.path);
    try {
      const stats = await lstat(documentPath);
      if (!stats.isFile() || stats.isSymbolicLink()) missingFiles.push(document.path);
    } catch {
      missingFiles.push(document.path);
    }
  }
  if (missingFiles.length)
    return { ...result, code: 'GOVERNANCE_DOCUMENT_MISSING_OR_UNSAFE', message: `missing or unsafe documents: ${missingFiles.join(', ')}` };
  const required = input.required_documents ?? [
    'CURRENT_STATUS.md',
    'PROJECT_EXECUTION_PLAN.md',
    'IMPLEMENTATION_HISTORY.md',
    'GOVERNANCE_CHANGELOG.md',
    'SOL_PROJECT_PROMPT_CANONICAL.md',
  ];
  const paths = new Set(manifest.documents.map((document) => document.path));
  const missing = required.filter((file) => !paths.has(`${governanceRoot}/${file}`) && !paths.has(file));
  if (missing.length) return { ...result, code: 'GOVERNANCE_REQUIRED_DOCUMENT_MISSING', message: `missing registered documents: ${missing.join(', ')}` };
  return {
    ...result,
    ok: true,
    code: 'OK',
    version: manifest.version,
    governance_revision: manifest.governance_revision ?? null,
    sol_prompt_revision: manifest.sol_prompt_revision ?? null,
    document_count: manifest.documents.length,
  };
}
