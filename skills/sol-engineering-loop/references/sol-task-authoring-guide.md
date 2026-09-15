# Sol Task Authoring Guide

The executor is Codex GPT-5.6 Luna with medium reasoning. Write tasks that give
Luna enough context for high first-pass accuracy without prescribing line-level
implementation.

Specify:

- what outcome is required and why;
- current facts and the repository baseline;
- scope and out-of-scope boundaries;
- frozen architecture and governance decisions;
- acceptance criteria that can be evidenced;
- known validation commands and protected constraints;
- the conditions that genuinely require Sol or user input.

Before authoring the next task, read the target repository's current status,
execution plan, implementation history, relevant report, governance, and
current HEAD. Do not leave major product or architecture decisions implicit.
