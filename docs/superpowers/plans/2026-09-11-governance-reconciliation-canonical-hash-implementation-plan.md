# 治理一致性规范化哈希实现计划

设计文档：[2026-09-11-governance-reconciliation-canonical-hash-design.md](../specs/2026-09-11-governance-reconciliation-canonical-hash-design.md)

## 实现目标

将治理一致性覆盖前的 `sha256_before` 校验从原始文件字节哈希升级为 `canonical-text-v1`，消除 CRLF/LF、UTF-8 BOM 等格式差异造成的误报，同时保留实际内容变化时的安全阻塞。

## 任务 1：增加规范化文本哈希工具

文件范围：`src/main/governance/` 及对应单元测试。

- 提取可复用的 UTF-8 文本读取、BOM 去除、换行规范化和 SHA-256 计算逻辑；
- 明确区分原始字节、规范化文本和输出编码；
- 对空文件、二进制、非法 UTF-8 保持现有拒绝行为；
- 测试 LF/CRLF/CR、BOM、正文变化、空格变化和末尾换行。

完成标准：工具测试覆盖规范化等价性和真实内容差异，且不改变路径安全行为。

## 任务 2：接入治理一致性应用器

文件范围：`src/main/governance/reconciliation-applier.ts` 及现有治理一致性测试。

- 将计划阶段和提交前二次校验统一改用规范化哈希；
- 保留备份、事务锁、路径越界、保护路径和回滚逻辑；
- 替换内容以 UTF-8 写入，并根据原文件的 BOM 与换行风格生成最终字节，减少无意义 diff；
- 规范化哈希不一致时继续抛出 `GOVERNANCE_RECONCILIATION_SHA_CONFLICT`；
- 增加“仅格式不同可覆盖”和“应用前实际变化仍阻塞”的测试。

完成标准：现有治理一致性回归测试通过，新增并发修改、换行差异、BOM 差异测试通过。

## 任务 3：更新 Writing Block 模板与 Sol 提示词

文件范围：`src/shared/protocol/writing-block-templates.ts`、`src/main/sol/prompt-compiler.ts` 及对应测试。

- 保留现有 `sha256_before` 字段和 Writing Block 结构；
- 明确该字段使用 `canonical-text-v1`；
- 要求 Sol 基于实际检查到的完整文本计算哈希，不猜测；
- 无法可靠读取或计算时返回 `BLOCKED`；
- 保持 JSON-only、完整替换文本和现有 8000 字符初始化提示词限制。

完成标准：模板、编译提示词和 JSON 校验测试通过，初始化提示词长度限制不回归。

## 任务 4：集成验证与回归

- 运行治理一致性、Writing Block、编排和自动化运行时相关测试；
- 运行完整测试套件；
- 检查 `git diff --check`、工作区状态和提交内容；
- 不修改自动修复分支，不改变远端同步职责，不自动绕过 SHA 冲突。

## 风险与处理

- 旧 Writing Block 中的原始字节哈希无法可靠识别模式；旧待处理块失败时提示重新执行检查；
- Git `autocrlf` 可能改变工作区原始字节，但规范化哈希应保持语义一致；
- 若实际正文变化，仍必须人工处理，不能使用规范化哈希掩盖变更。
