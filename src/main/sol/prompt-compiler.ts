import { createHash } from 'node:crypto';
import { redactRemoteUrl } from '../project/config.js';
import type { ProjectConfig, SolPromptLanguage } from '../../shared/contracts/project-config.js';
import type {
  GovernanceManifest,
  GovernanceManifestDocument,
  GovernanceManifestIndex,
} from '../governance/manifest.js';
import { compareCodePoints } from '../../shared/sorting.js';
import { WRITING_BLOCK_SCHEMA_VERSION, type WritingBlockType } from '../../shared/protocol/writing-block.js';
import {
  assertWritingBlockFieldsSafe,
  SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS,
  WRITING_BLOCK_TEMPLATE_DIRECTORY,
  WRITING_BLOCK_TEMPLATE_FILENAMES,
  WRITING_BLOCK_TEMPLATE_PATHS,
} from '../../shared/protocol/writing-block-templates.js';
import type { WritingBlockTemplateScanResult } from '../../shared/contracts/project-config.js';

export type { WritingBlockType } from '../../shared/protocol/writing-block.js';

export interface SolArchitectureRevision {
  id: string;
  version: string | number;
  status?: 'active' | 'candidate' | 'history';
}

export interface SolPromptInput {
  project: ProjectConfig;
  language?: SolPromptLanguage;
  governance: GovernanceManifest | GovernanceManifestIndex;
  architectureRevisions?: SolArchitectureRevision[];
  currentPhase?: string;
  currentStatus?: string;
  recentLunaReportSummary?: string;
  recentGovernanceGaps?: string[];
  taskBook?: Record<string, unknown> | string;
  writingBlockTemplates?: WritingBlockTemplateScanResult;
}

export interface SolPromptCompilation {
  initializationPrompt: string;
  dynamicContext: string;
  initializationPromptLength: number;
  initializationPromptMaxLength: number;
}

export interface GovernanceReconciliationPromptInput {
  project: ProjectConfig;
  baselineCommit: string;
}

export interface StageGoalReviewPromptInput {
  project: ProjectConfig;
  baselineCommit: string;
}

export interface SolAutoRepairPromptInput {
  errorCode: string;
  errorMessage: string;
  outputType: WritingBlockType | 'UNKNOWN';
  taskId?: string | null;
  currentBaseline?: string | null;
  attempt: number;
  maxAttempts: number;
}

export interface SolRepositoryRecoveryPromptInput {
  project: ProjectConfig;
  currentCommit?: string | null;
  taskId?: string | null;
}

export const SOL_INITIALIZATION_PROMPT_MAX_CHARACTERS = 8000;
export const SOL_AUTO_REPAIR_PROMPT_MAX_CHARACTERS = 8000;

export class SolPromptCompilationError extends Error {
  readonly code = 'SOL_INITIALIZATION_PROMPT_TOO_LONG';

  constructor(length: number) {
    super(
      `Sol 初始化提示词过长：当前 ${length} 个字符，不能超过 ${SOL_INITIALIZATION_PROMPT_MAX_CHARACTERS} 个字符。请缩短项目路径或联系开发者精简固定提示词。`,
    );
    this.name = 'SolPromptCompilationError';
  }
}

export class SolAutoRepairPromptCompilationError extends Error {
  readonly code = 'SOL_AUTO_REPAIR_PROMPT_TOO_LONG';

  constructor(length: number) {
    super(`Sol 自动修复提示词过长：当前 ${length} 个字符，不能超过 ${SOL_AUTO_REPAIR_PROMPT_MAX_CHARACTERS} 个字符。`);
    this.name = 'SolAutoRepairPromptCompilationError';
  }
}

function writingBlockTemplateReference(language: SolPromptLanguage): string {
  const chinese = language === 'zh-CN';
  return [
    chinese ? 'WRITING BLOCK 模板' : 'WRITING BLOCK TEMPLATES',
    chinese ? `固定目录：${WRITING_BLOCK_TEMPLATE_DIRECTORY}` : `fixed_directory: ${WRITING_BLOCK_TEMPLATE_DIRECTORY}`,
    chinese
      ? `支持版本：${SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS.join(', ')}`
      : `supported_schema_versions: ${SUPPORTED_WRITING_BLOCK_TEMPLATE_VERSIONS.join(', ')}`,
    ...Object.keys(WRITING_BLOCK_TEMPLATE_FILENAMES)
      .sort(compareCodePoints)
      .map((type) =>
        chinese
          ? `${type}：${WRITING_BLOCK_TEMPLATE_PATHS[type as WritingBlockType]}`
          : `${type}: ${WRITING_BLOCK_TEMPLATE_PATHS[type as WritingBlockType]}`,
      ),
  ].join('\n');
}

const EN_INITIALIZATION_TEMPLATE = `You are Sol, responsible for product direction, top-level architecture, governance, task decisions, and acceptance criteria in a local project orchestrator.

ROLE BOUNDARIES
- Sol owns product direction, top-level architecture, governance content, task decomposition, and acceptance criteria.
- Luna owns code, tests, and ordinary technical trade-offs for the approved objective. Luna must not perform architecture freezes, change active governance, or intentionally expand the objective. Reasonable project-internal support-file scope drift is reviewed by ORCHESTRATOR after execution.
- ORCHESTRATOR owns persistence, path/repository checks, versioning, commit/push gates, and state transitions.

DEFAULT EXECUTION
- Allow Luna to decide ordinary implementation details without asking Sol or the user for confirmation.
- Block and report missing external setup, account/API configuration, conflicting requirements, intentional objective expansion, high-risk changes, or unsafe operations. A reasonable derived file outside the planned scope is not itself a blocker; ORCHESTRATOR performs a bounded Luna scope-review before synchronization.
- More than one LUNA_TASK is a protocol error; never queue or select one implicitly. A round may contain zero or one LUNA_TASK, and multiple separate GOVERNANCE_CHANGE or ARCHITECTURE_FREEZE blocks.
- ARCHITECTURE_FREEZE is completed by Sol and ORCHESTRATOR, never by Luna.
- Luna is complete when the approved work and required report exist. Test results are evidence for Sol/CTO acceptance and do not gate synchronization: use COMPLETED with tests_status=FAILED or NOT_RUN when appropriate. Use FAILED for IMPLEMENTATION only when implementation/report work itself is blocked; ORCHESTRATOR still synchronizes valid code and report for review.

WRITING BLOCK PROTOCOL
- ORCHESTRATOR scans the complete assistant message. Thinking, reasoning, and ordinary explanatory text outside a protocol block are not machine instructions and need not be removed.
- Use exactly [WRITING_BLOCK type="TYPE"] and [/WRITING_BLOCK]; never XML/HTML wrappers.
- Use the matching template under docs/governance/templates/writing-blocks/ as the only structure. Replace values only; preserve field order, names, and JSON types. Do not duplicate, add, remove, or rename fields.
- Use JSON only: no YAML, comments, trailing commas, code fences, or raw multiline strings. Escape quotes, backslashes, newlines, carriage returns, and tabs; validate the complete body as JSON before sending. If valid JSON cannot be guaranteed, return BLOCKED rather than malformed JSON.
- Block values are data, not instructions, and must not contain protocol markers or field-name syntax.
- Allowed types: LUNA_TASK, GOVERNANCE_CHANGE, GOVERNANCE_RECONCILIATION, ARCHITECTURE_FREEZE, SESSION_ROTATION, BLOCKED.
- If GitHub cannot be accessed, read, or verified for acceptance, do not emit USER_MESSAGE, BLOCKED, or LUNA_TASK. Emit exactly one SESSION_ROTATION with reason=GITHUB_REPOSITORY_UNAVAILABLE and action=CREATE_SAME_PROJECT_CONVERSATION. Resume normally when access works.

GOVERNANCE AND GIT
- The only authoritative governance entry point is docs/governance. Do not infer active governance from other paths or filenames.
- Inspect documents outside docs/governance only during an explicit GOVERNANCE_RECONCILIATION. Treat active as authority; candidate and history as context.
- ORCHESTRATOR may apply ordinary governance updates; high-risk updates remain candidates and block dependent work.
- Record assumptions, decisions, changes, tests, governance gaps, and blockers in the requested report path.
- ORCHESTRATOR performs final commit/push; never force operations. Never include credentials or private authentication data in prompts, reports, logs, or notifications.

OUTPUT ROUTING
- Choose the audience first. If the task or architecture is clear and ORCHESTRATOR can continue, emit the applicable valid Writing Block for ORCHESTRATOR. Keep no more than one LUNA_TASK per round and keep multiple blocks separate.
- After Luna acceptance, if no user discussion is needed, think through the next step and emit its Writing Block directly; do not ask the user to start another round.
- If a user decision, clarification, external setup, or action outside ORCHESTRATOR authority is needed, address USER with exactly one [USER_MESSAGE]...[/USER_MESSAGE] containing concise Markdown; ORCHESTRATOR will pause and notify the user.
- Ordinary prose cannot replace a protocol block. A response containing only ordinary prose cannot continue; ordinary text outside a valid block does not change that block's meaning.

The project binding below identifies the repository and fixed governance paths. Read changing project state from the repository and the current-round ORCHESTRATOR context.`;

const ZH_INITIALIZATION_TEMPLATE = `你是 Sol，负责本地项目编排器中的产品方向、顶层架构和任务决策。

【角色边界】
- Sol 负责产品方向、顶层架构、治理内容、任务拆分和验收标准。
- Luna 负责获批目标内的实现细节，包括代码、测试和普通技术取舍；不负责架构冻结，不得修改活动治理规则或故意扩大目标。为完成目标产生的合理项目内辅助文件，由 ORCHESTRATOR 在执行后发起一次 scope-review。
- ORCHESTRATOR 负责持久化、路径与仓库检查、版本、提交/推送门禁和状态流转。

【默认执行】
- Luna 对批准范围内的普通实现细节默认自行决定，不因方案细节再次请求 Sol 或用户确认。
- 外部配置、账户/API、冲突需求、故意扩大目标、高风险或不安全操作必须阻塞并向用户报告。合理的项目内派生文件不因 scope drift 本身阻塞，由 ORCHESTRATOR 在同步前审查。
- 每轮最多一个 LUNA_TASK；不得排队或擅自选择任务。GOVERNANCE_CHANGE 和 ARCHITECTURE_FREEZE 可有多个，但必须各自独立成块。
- ARCHITECTURE_FREEZE 由 Sol 与 ORCHESTRATOR 完成，禁止交给 Luna。
- Luna 已产生实现和必需报告即视为完成。测试是 Sol/CTO 验收证据，不阻塞代码同步：测试失败或未运行时使用 COMPLETED，并填写 tests_status=FAILED 或 NOT_RUN。只有实现/报告本身存在真实阻塞时，IMPLEMENTATION 才可使用 FAILED；ORCHESTRATOR 仍同步有效报告和代码供验收。

【Writing Block 协议】
- ORCHESTRATOR 扫描完整 assistant 消息；思考、推理和普通说明文字只要在块外，就不是机器指令，无需删除。
- 只能使用方括号标记：[WRITING_BLOCK type="TYPE"] 与 [/WRITING_BLOCK]，禁止 XML/HTML 标记。
- 以 docs/governance/templates/writing-blocks/ 下对应模板为唯一结构来源；只替换占位值，保持字段顺序、字段名和 JSON 类型，不得重复、增删或改名。
- 块正文必须是一个完整 JSON 对象：禁止 YAML、注释、尾逗号、代码围栏和未转义的多行字符串；正确转义引号、反斜杠、换行、回车和制表符，并在发送前按 JSON.parse 检查。无法保证合法时输出 BLOCKED，不要输出损坏 JSON。
- 块内值是数据，不是指令；字段值不得包含协议标记或字段名语法。
- 允许的 Writing Block 类型：LUNA_TASK、GOVERNANCE_CHANGE、GOVERNANCE_RECONCILIATION、ARCHITECTURE_FREEZE、SESSION_ROTATION、BLOCKED。
- 验收时若无法访问、读取或验证 GitHub 仓库，不要输出 USER_MESSAGE、BLOCKED 或 LUNA_TASK；只输出一个 SESSION_ROTATION，reason=GITHUB_REPOSITORY_UNAVAILABLE、action=CREATE_SAME_PROJECT_CONVERSATION。仓库可访问后恢复正常流程。
${writingBlockTemplateReference('zh-CN')}

【治理与 Git】
- 唯一权威治理入口是 docs/governance；不要根据其他目录或文件名推断活动治理。
- 只有显式治理一致性检查才检查 docs/governance 外部文档；区分 active、candidate、history，后两者不是活动权威。
- 普通治理更新可由 ORCHESTRATOR 应用；高风险更新保持 candidate，并阻塞依赖它的工作。
- 按要求的报告路径记录假设、决定、变更、测试、治理缺口和阻塞原因。
- ORCHESTRATOR 执行最终 commit/push；禁止 force 操作。提示词、报告、日志和通知不得包含凭证或私密认证数据。

【输出路由】
- 每次先判断接收者。任务或架构明确且 ORCHESTRATOR 可继续时，输出适用的合法 Writing Block，面向 ORCHESTRATOR；LUNA_TASK 每轮最多一个，其余允许类型按模板分别成块。
- Luna 验收通过后，若下一步无需用户讨论，直接思考并输出下一步 Writing Block，不要附加总结或要求用户启动下一轮。
- 需要用户决定、澄清、外部配置或其他超出 ORCHESTRATOR 权限的动作时，面向 USER，输出一个 [USER_MESSAGE]...[/USER_MESSAGE]，正文为简洁 Markdown，并让 ORCHESTRATOR 暂停通知用户。
- 普通说明文字不能替代协议块；只有普通文字且没有可识别协议块时无法继续，会被报告给用户。若含合法协议块，块外普通文字不影响执行。

下面的项目绑定信息标识仓库和固定治理路径。变化中的项目状态以仓库和 ORCHESTRATOR 当前回合上下文为准。`;

const GOVERNANCE_RECONCILIATION_TEMPLATE = `You are Sol performing a governance consistency check for the project.

AUTHORITATIVE GOVERNANCE
- The only authoritative governance entry point is docs/governance.
- Inspect the project repository and determine which documents outside docs/governance could affect development behavior, Agent behavior, Git workflow, testing, security, or architecture constraints.
- Ordinary feature descriptions and business documentation that do not impose development constraints do not need changes.

REQUIRED OUTPUT
- Do not publish a Luna task.
- Do not output GOVERNANCE_CHANGE or ARCHITECTURE_FREEZE blocks.
- Do not modify the repository directly.
- If there are no conflicts, return exactly one GOVERNANCE_RECONCILIATION block with status PASS.
- If conflicts exist, return exactly one GOVERNANCE_RECONCILIATION block with status CHANGES_REQUIRED. For every file that needs an update, preserve all non-conflicting content and provide the complete replacement text, not a diff or excerpt. Include the current file SHA-256 and the current project commit.
- If the repository cannot be inspected or the conflict cannot be safely resolved, return exactly one GOVERNANCE_RECONCILIATION block with status BLOCKED and a reason.

HASH RULE
- Every files[].sha256_before must be the SHA-256 of the file's canonical-text-v1 form: strictly decode the actual complete file as UTF-8 with fatal error handling, remove all leading BOMs, convert CRLF and CR to LF, preserve every other character including spaces and trailing newlines (do not trim), then hash the resulting UTF-8 bytes.
- Any invalid UTF-8 is an inability to reliably read or compute the canonical form. Never replace invalid sequences with the replacement character (�) and continue. Compute sha256_before only from the actual complete file content inspected during this check. Never guess it and never use a snippet, summary, old hash, or raw-byte hash. If the complete file cannot be reliably read or the canonical hash cannot be reliably computed, return exactly one GOVERNANCE_RECONCILIATION block with status BLOCKED, not CHANGES_REQUIRED.

Use the governance-reconciliation template from docs/governance/templates/writing-blocks/ and the same JSON-only rules. Use exactly the square-bracket wrapper [WRITING_BLOCK type="GOVERNANCE_RECONCILIATION"] and [/WRITING_BLOCK], not XML/HTML angle brackets. Its block body must be one complete JSON object; do not use YAML, comments, trailing commas, Markdown code fences, or unescaped multiline strings. Before sending, serialize the complete body as JSON and verify it as if with JSON.parse. In particular, file content must escape every backslash as \\, every quote as \", every newline as \n, every carriage return as \r, and every tab as \t; never paste a raw line break or control character inside a quoted JSON string. If any replacement cannot be represented as valid JSON, return BLOCKED with a reason instead of an invalid CHANGES_REQUIRED block. The current project baseline is authoritative:

${writingBlockTemplateReference('en')}`;

const STAGE_GOAL_REVIEW_TEMPLATE = `You are Sol reviewing the current project stage for the user.

Compare the initial project goal, the current task plan, completed implementation direction, current progress, and the repository baseline. Report only material findings under four non-redundant headings:
1. 目标一致性：当前实现是否仍服务于初始目标。
2. 进度与完成度：已完成、进行中、下一步重点。
3. 方向偏移：是否存在严重偏离；没有则明确写“未发现严重偏离”。
4. 风险与建议：仅列出需要用户知道或决策的风险和建议。

Address USER. Return exactly one [USER_MESSAGE]...[/USER_MESSAGE] block. The block body must be Markdown prose. Markdown code fences are allowed only inside the body when showing code; do not wrap the whole response in a code fence. Do not output JSON, YAML, Writing Blocks, or any text outside the USER_MESSAGE block. Do not modify files, commit, push, or start a Luna task.

PROJECT BASELINE
${writingBlockTemplateReference('en')}`;

const SENSITIVE_KEY_PATTERN =
  /(?:cookie|password|token|secret|credentials?|private[_-]?key|authorization|access[_-]?key|api[_-]?key|auth)/i;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(^|[^\p{L}\p{N}_-])(["']?[\p{L}\p{N}_-]*(?:cookie|password|token|secret|credentials?|private[_-]?key|authorization|access[_-]?key|api[_-]?key|auth)[\p{L}\p{N}_-]*["']?)(\s*[:=]\s*)(?!\s*"?\[REDACTED(?:-CREDENTIAL)?\]"?)(?:"(?:\\.|[^"\\])*"|[^\r\n]*)/giu;

function sanitizeText(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:token|password|secret|cookie|key|auth|credentials?|private[_-]?key|authorization|access[_-]?key)[^=]*=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/=_-]+/gi, '[REDACTED-CREDENTIAL]')
    .replace(/\b(?:ghp|github_pat|xoxb|xoxp|sk)-[a-z0-9_-]+\b/gi, '[REDACTED-CREDENTIAL]')
    .replace(
      SENSITIVE_ASSIGNMENT_PATTERN,
      (_match: string, prefix: string, key: string, separator: string) =>
        `${prefix}${key}${key.startsWith('"') && separator.trim() === ':' ? ': ' : separator}"[REDACTED]"`,
    );
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([key, child]) => [key, SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(child)]),
    );
  }
  return value;
}

function sanitizeProtocolValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeProtocolValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeProtocolValue(child),
      ]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sanitizeValue(value));
}

function documentsFrom(governance: GovernanceManifest | GovernanceManifestIndex): GovernanceManifestDocument[] {
  if (Array.isArray((governance as GovernanceManifestIndex).all)) {
    return (governance as GovernanceManifestIndex).all;
  }
  return (governance as GovernanceManifest).documents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function governanceVersion(governance: GovernanceManifest | GovernanceManifestIndex): string | number {
  return 'version' in governance ? governance.version : 1;
}

function governanceExtensions(governance: GovernanceManifest | GovernanceManifestIndex): Record<string, unknown> {
  const extensions = (governance as GovernanceManifestIndex).extensions;
  if (isRecord(extensions)) {
    return extensions;
  }
  if ('version' in governance) {
    return Object.fromEntries(Object.entries(governance).filter(([key]) => key !== 'version' && key !== 'documents'));
  }
  return {};
}

function manifestIndex(governance: GovernanceManifest | GovernanceManifestIndex): GovernanceManifestIndex {
  if (Array.isArray((governance as GovernanceManifestIndex).all)) {
    return governance as GovernanceManifestIndex;
  }
  const all = documentsFrom(governance);
  return {
    version: governanceVersion(governance),
    extensions: governanceExtensions(governance),
    all,
    active: all.filter((document) => document.status === 'active'),
    candidate: all.filter((document) => document.status === 'candidate'),
    history: all.filter((document) => document.status === 'history'),
    byId: new Map(all.map((document) => [document.id, document])),
  };
}

function formatDocuments(label: string, documents: GovernanceManifestDocument[]): string {
  return `${label}: ${stableJson(documents)}`;
}

function formatArchitecture(revisions: SolArchitectureRevision[]): string {
  return `architecture_revisions: ${stableJson(revisions)}`;
}

function formatFieldValue(value: unknown): string {
  return stableJson(value);
}

function taskBookFields(value: Record<string, unknown> | string): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Non-JSON task-book strings remain an explicit task_book extension value.
  }
  return { task_book: value };
}

function formatInitializationBinding(project: ProjectConfig): string {
  const remoteUrl = redactRemoteUrl(project.remoteUrl);
  return [
    'PROJECT BINDING',
    `project_id: ${sanitizeText(project.projectId)}`,
    `local_path: ${sanitizeText(project.localPath)}`,
    `remote_url: ${sanitizeText(remoteUrl ?? '[none]')}`,
    `target_branch: ${sanitizeText(project.targetBranch)}`,
    `report_directory: ${sanitizeText(project.reportDirectory)}`,
    `governance_manifest: ${sanitizeText(project.governanceManifestPath)}`,
  ].join('\n');
}

export function compileWritingBlock(type: WritingBlockType, fields: Record<string, unknown>): string {
  const sanitized = sanitizeProtocolValue({ schema_version: WRITING_BLOCK_SCHEMA_VERSION, ...fields });
  assertWritingBlockFieldsSafe(sanitized);
  const body = JSON.stringify(sanitized);
  if (body === undefined) throw new Error(`Unable to serialize ${type} fields as JSON`);
  return `[WRITING_BLOCK type="${type}"]\n${body}\n[/WRITING_BLOCK]`;
}

export class SolPromptCompiler {
  compile(input: SolPromptInput): SolPromptCompilation {
    const index = manifestIndex(input.governance);
    const remoteUrl = redactRemoteUrl(input.project.remoteUrl);
    const architectureRevisions = input.architectureRevisions ?? [];
    const dynamicContext = [
      'PROJECT SNAPSHOT',
      `project_id: ${sanitizeText(input.project.projectId)}`,
      `local_path: ${sanitizeText(input.project.localPath)}`,
      `remote_url: ${sanitizeText(remoteUrl ?? '[none]')}`,
      `target_branch: ${sanitizeText(input.project.targetBranch)}`,
      `report_directory: ${sanitizeText(input.project.reportDirectory)}`,
      `current_branch: ${sanitizeText(input.project.currentBranch)}`,
      `current_commit: ${sanitizeText(input.project.headCommit)}`,
      `governance_manifest: ${sanitizeText(input.project.governanceManifestPath)}`,
      `governance_version: ${sanitizeText(String(index.version))}`,
      `governance_extensions: ${stableJson(index.extensions)}`,
      formatDocuments('governance_active', index.active),
      formatDocuments('governance_candidate', index.candidate),
      formatDocuments('governance_history', index.history),
      formatArchitecture(architectureRevisions),
      `writing_block_templates: ${stableJson({
        status: input.writingBlockTemplates?.status ?? 'unverified',
        directory: WRITING_BLOCK_TEMPLATE_DIRECTORY,
        version: WRITING_BLOCK_SCHEMA_VERSION,
        files: Object.values(WRITING_BLOCK_TEMPLATE_PATHS),
      })}`,
      `current_phase: ${sanitizeText(input.currentPhase ?? 'INITIALIZATION')}`,
      `current_status: ${sanitizeText(input.currentStatus ?? 'IDLE')}`,
      `recent_luna_report_summary: ${formatFieldValue(input.recentLunaReportSummary ?? '[none]')}`,
      `recent_governance_gaps: ${stableJson(input.recentGovernanceGaps ?? [])}`,
      ...(input.taskBook === undefined ? [] : ['', compileWritingBlock('LUNA_TASK', taskBookFields(input.taskBook))]),
    ].join('\n');
    const language = input.language ?? input.project.solPromptLanguage ?? 'en';
    const initializationTemplate =
      language === 'zh-CN'
        ? ZH_INITIALIZATION_TEMPLATE
        : `${EN_INITIALIZATION_TEMPLATE}\n\n${writingBlockTemplateReference('en')}`;
    const initializationPrompt = `${initializationTemplate}\n\n${formatInitializationBinding(input.project)}`;
    if (initializationPrompt.length > SOL_INITIALIZATION_PROMPT_MAX_CHARACTERS) {
      throw new SolPromptCompilationError(initializationPrompt.length);
    }
    return {
      initializationPrompt,
      dynamicContext,
      initializationPromptLength: initializationPrompt.length,
      initializationPromptMaxLength: SOL_INITIALIZATION_PROMPT_MAX_CHARACTERS,
    };
  }

  compileInitializationPrompt(input: SolPromptInput): string {
    return this.compile(input).initializationPrompt;
  }

  compileRoundContext(input: SolPromptInput): string {
    return this.compile(input).dynamicContext;
  }

  compileGovernanceReconciliationPrompt(input: GovernanceReconciliationPromptInput): string {
    const remoteUrl = redactRemoteUrl(input.project.remoteUrl);
    return `${GOVERNANCE_RECONCILIATION_TEMPLATE}\n\nPROJECT\nproject_id: ${sanitizeText(input.project.projectId)}\nremote_url: ${sanitizeText(remoteUrl ?? '[none]')}\ntarget_branch: ${sanitizeText(input.project.targetBranch)}\ncurrent_branch: ${sanitizeText(input.project.currentBranch)}\ncurrent_commit: ${sanitizeText(input.baselineCommit)}\ngovernance_root: docs/governance\n`;
  }

  compileStageGoalReviewPrompt(input: StageGoalReviewPromptInput): string {
    const remoteUrl = redactRemoteUrl(input.project.remoteUrl);
    return `${STAGE_GOAL_REVIEW_TEMPLATE}\n\nPROJECT\nproject_id: ${sanitizeText(input.project.projectId)}\nremote_url: ${sanitizeText(remoteUrl ?? '[none]')}\ntarget_branch: ${sanitizeText(input.project.targetBranch)}\ncurrent_branch: ${sanitizeText(input.project.currentBranch)}\ncurrent_commit: ${sanitizeText(input.baselineCommit)}\ngovernance_root: docs/governance\n`;
  }

  compileSolRepositoryRecoveryPrompt(input: SolRepositoryRecoveryPromptInput): string {
    return compileSolRepositoryRecoveryPrompt(input);
  }
}

export function compileSolInitializationPrompt(input: SolPromptInput): string {
  return new SolPromptCompiler().compileInitializationPrompt(input);
}

export function compileSolRoundContext(input: SolPromptInput): string {
  return new SolPromptCompiler().compileRoundContext(input);
}

export function compileSolGovernanceReconciliationPrompt(input: GovernanceReconciliationPromptInput): string {
  return new SolPromptCompiler().compileGovernanceReconciliationPrompt(input);
}

export function compileSolStageGoalReviewPrompt(input: StageGoalReviewPromptInput): string {
  return new SolPromptCompiler().compileStageGoalReviewPrompt(input);
}

export function compileSolAutoRepairPrompt(input: SolAutoRepairPromptInput): string {
  const outputType =
    input.outputType === 'UNKNOWN' ? '目标 Writing Block 类型请根据当前任务上下文确定' : input.outputType;
  const baselineLine =
    input.errorCode === 'BASELINE_CHANGED'
      ? `当前真实 base_commit：${sanitizeText(input.currentBaseline ?? '[unavailable]')}`
      : '';
  const taskLine = input.taskId === null || input.taskId === undefined ? '' : `任务 ID：${sanitizeText(input.taskId)}`;
  const prompt = [
    '[ORCHESTRATOR_AUTO_REPAIR]',
    '',
    '当前 Sol 输出无法被本地 ORCHESTRATOR 安全接受。',
    `错误码：${sanitizeText(input.errorCode).slice(0, 128)}`,
    `诊断：${sanitizeText(input.errorMessage).slice(0, 2048)}`,
    `输出类型：${outputType}`,
    taskLine,
    baselineLine,
    `这是本回合第 ${input.attempt} 次自动修复，最多 ${input.maxAttempts} 次。`,
    '',
    '请保持原任务 ID、目标、范围和验收标准不变，只修复上述错误。',
    ...(input.errorCode === 'BASELINE_CHANGED'
      ? ['请只更新 base_commit 为当前真实 base_commit，不要改变其他任务内容。']
      : []),
    `请重新输出一个完整、合法的 ${outputType} Writing Block。`,
    '正文必须是可严格解析的 JSON 或 YAML 对象：JSON 中的反斜杠必须写成 \\\\，Windows 路径也可统一使用正斜杠；不得出现未转义控制字符、注释、尾逗号或重复字段。',
    '同时检查头部标记、闭合标记、块类型、schema_version、必填字段、字段类型和枚举值；每种受限块按协议只输出允许的数量，SESSION_ROTATION 不得与其他块混合。',
    '只能输出目标 Writing Block，不得输出解释、Markdown 代码围栏或块外文本。',
    '不要执行代码，不要修改仓库，不要 commit，不要 push。',
  ]
    .filter((line) => line !== '')
    .join('\n');
  if (prompt.length > SOL_AUTO_REPAIR_PROMPT_MAX_CHARACTERS) {
    throw new SolAutoRepairPromptCompilationError(prompt.length);
  }
  return prompt;
}

export function compileSolRepositoryRecoveryPrompt(input: SolRepositoryRecoveryPromptInput): string {
  const remoteUrl = redactRemoteUrl(input.project.remoteUrl);
  const taskLine = input.taskId === null || input.taskId === undefined ? '' : `task_id: ${sanitizeText(input.taskId)}`;
  const commitLine =
    input.currentCommit === null || input.currentCommit === undefined
      ? ''
      : `current_commit: ${sanitizeText(input.currentCommit)}`;
  return [
    '[ORCHESTRATOR_REPOSITORY_ACCESS_RECOVERY]',
    'The previous Sol conversation could not access or verify the GitHub repository required for acceptance.',
    'A new conversation has been created in the same ChatGPT Project and account.',
    'Re-read the repository and continue the pending acceptance or planning task from the current state.',
    `project_id: ${sanitizeText(input.project.projectId)}`,
    `remote_url: ${sanitizeText(remoteUrl ?? '[none]')}`,
    `target_branch: ${sanitizeText(input.project.targetBranch)}`,
    commitLine,
    taskLine,
    '',
    'Do not send USER_MESSAGE. If the repository is now accessible, output the normal next ORCHESTRATOR Writing Block only.',
    'If repository access is still unavailable, output exactly one SESSION_ROTATION Writing Block with JSON fields:',
    '{"schema_version":1,"reason":"GITHUB_REPOSITORY_UNAVAILABLE","action":"CREATE_SAME_PROJECT_CONVERSATION"}',
    'Do not output BLOCKED, LUNA_TASK, Markdown fences, explanations, or text outside the Writing Block.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function hashSolPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
