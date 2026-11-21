# Ready-made open-source tools for reducing token use by AI coding agents (opencode / OpenSpec focus), as of Nov 2026

Method note: GitHub's API was blocked from this environment, so star counts come from GitHub pages read with a summarizing fetch tool in Nov 2026. Treat them as approximate. Package versions, dates and licenses were checked directly against the npm registry (`registry.npmjs.org/<pkg>`) and PyPI (`pypi.org/pypi/<pkg>/json`) on 2026-11-21. Self-reported savings are labelled as such. Where independent measurements exist, they are given next to the vendor claims.

## Q1. Catalogue overview: what exists, and what is reusable for an opencode + OpenSpec SDD pipeline

### Takeaway
There is a large set of opencode-native plugins for context pruning, compaction, tool-schema slimming, output compression, retrieval and measurement. Almost none is OpenSpec- or SDD-stage-aware. The most direct SDD-specific precedent is a spec-kit extension that measures tokens per stage, scores quality and compares baseline vs variant. It has not been ported to OpenSpec. Independent paired benchmarks (JetBrains, Quesma) show that headline per-command savings (60–90%) often vanish end to end. So the hackathon deliverable should measure billed and cache-weighted tokens per stage, not bytes removed.

### Cited Findings

Catalogue table. Stars are approximate, from GitHub pages fetched Nov 2026. Version and date come from npm or PyPI on 2026-11-21.

| Tool | Repo | Stars | License | Latest | Category | opencode support |
|---|---|---|---|---|---|---|
| Dynamic Context Pruning (DCP) | github.com/Opencode-DCP/opencode-dynamic-context-pruning (npm points to Tarquinen/…) | ~4.2k | AGPL-3.0-or-later | 3.2.1, 2026-11-16 | Context pruning plugin | Native plugin |
| Magic Context | github.com/cortexkit/magic-context | ~2.4k | MIT | @cortexkit/opencode-magic-context 0.49.68, 2026-11-20 | Background compression and memory | Native plugin |
| OpenSlimedit | github.com/ASidorenkoCode/openslimedit | ~128 | MIT | 1.0.4, 2026-02-16 | Tool-schema and read-output slimming | Native plugin |
| opencode-snip | github.com/VincentHardouin/opencode-snip | n/a | MIT | 3.0.1, 2026-11-18 | Shell output filtering (wraps `snip`) | Native plugin |
| Sleev | github.com/sleev-labs/sleev | n/a (page not fetched, rate limited) | "SEE LICENSE IN LICENSE.md" (custom) | 1.8.16, 2026-11-13 | Local proxy, successor to DCP ideas | Proxy |
| RTK (Rust Token Killer) | github.com/rtk-ai/rtk | ~84.7k | Apache-2.0 CLI; engine/proxy BUSL-1.1 | n/a | CLI output compressor | TS plugin |
| Headroom | github.com/headroomlabs-ai/headroom (formerly chopratejas/headroom) | ~79.1k | Apache-2.0 | headroom-ai 0.44.0, 2026-11-10 | Context compression proxy/library | Wrap or proxy |
| context-mode | github.com/mksglu/context-mode | ~32.5k | Elastic-2.0 (ELv2) | 2.2.1, 2026-11-17 | Sandbox plus FTS5 index of tool output | `"plugin": ["context-mode"]` |
| caveman | github.com/JuliusBrussee/caveman | 10.9k at 6 days old; press later cites 65k–100k | Apache-2.0 | @caveman-ai/cli 4.1.0, 2026-11-08 | Terse output plus input compression | Listed as supported |
| Token Optimizer | github.com/alexgreensh/token-optimizer | n/a | not stated | n/a | Quality/compaction nudges, dashboard | Native TS plugin |
| Serena | github.com/oraios/serena | ~22.7k (Apr 2026) | MIT per Apr 2026 analysis; PyPI 2.1.0 says GPL-3.0-or-later | serena-agent 2.1.0, 2026-10-19 | LSP symbol retrieval MCP | MCP |
| codebase-memory-mcp | github.com/DeusData/codebase-memory-mcp | ~47.2k | MIT | PyPI 0.12.1, 2026-10-16 | Tree-sitter/SQLite code graph MCP | Named in installer |
| claude-context (Zilliz) | github.com/zilliztech/claude-context | ~12.7k | MIT | @zilliz/claude-context-mcp 0.1.16, 2026-11-12 | Hybrid vector code search MCP | Not named (generic MCP) |
| code-index-mcp | github.com/johnhuang316/code-index-mcp | n/a | MIT | 2.17.1, 2026-07-27 | Code index MCP | MCP |
| repomix | github.com/yamadashy/repomix | n/a | MIT | 1.19.0, 2026-11-08 | Repo packer with tree-sitter `--compress` | CLI/MCP |
| aider repo-map | github.com/Aider-AI/aider | n/a | n/a | aider-chat 0.86.2, 2026-02-12 | Ranked repo map within token budget | Concept to port |
| LLMLingua | github.com/microsoft/LLMLingua | n/a | MIT | llmlingua 0.2.2, 2024-04-09 (stale) | Prompt compression library | Library |
| OpenSpec | github.com/Fission-AI/OpenSpec | ~73.3k | MIT | @fission-ai/openspec 2.1.1, 2026-11-19 | SDD framework | Slash commands for 30+ tools |
| opencode-plugin-openspec | github.com/Octane0411/opencode-plugin-openspec | ~168 | MIT | 0.1.4, 2026-03-24 | OpenSpec planning agent for opencode | Native plugin |
| spec-kit-token-analyzer | github.com/coderandhiker/spec-kit-token-analyzer | n/a | MIT | v0.1.0 | Per-stage token A/B plus quality gate | spec-kit (port needed) |
| opencode-tokenscope | github.com/ramtinJ95/opencode-tokenscope | ~274 | MIT | 2.1.0, 2026-11-11 | Per-session token breakdown | Native plugin |
| Langfuse opencode plugin | @langfuse/opencode-observability-plugin | n/a | n/a | ≥0.5.0 | Tracing | Native plugin |
| opencode-plugin-otel | github.com/DEVtheOPS/opencode-plugin-otel | n/a | MPL-2.0 | 2.1.0, 2026-11-10 | OTel exporter | Native plugin |
| tokscale | github.com/junhoyeo/tokscale | n/a | MIT | 4.23.0, 2026-11-15 | Cross-agent usage CLI | Reads opencode data |
| LiteLLM | github.com/BerriAI/litellm | n/a | MIT | 1.110.2, 2026-11-20 | Provider-agnostic proxy/meter | Point provider baseURL at proxy |

Sources for the table:
- DCP: [GitHub](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning); [npm](https://registry.npmjs.org/@tarquinen/opencode-dcp)
- Magic Context: [GitHub](https://github.com/cortexkit/magic-context); [npm](https://registry.npmjs.org/@cortexkit/opencode-magic-context)
- OpenSlimedit: [GitHub](https://github.com/ASidorenkoCode/openslimedit); [npm](https://registry.npmjs.org/openslimedit)
- opencode-snip: [npm](https://registry.npmjs.org/opencode-snip); [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
- Sleev: [npm](https://registry.npmjs.org/sleev)
- RTK: [GitHub](https://github.com/rtk-ai/rtk)
- Headroom: [GitHub](https://github.com/chopratejas/headroom) (redirects to headroomlabs-ai); [npm](https://registry.npmjs.org/headroom-ai); [PyPI](https://pypi.org/pypi/headroom-ai/json)
- context-mode: [GitHub](https://github.com/mksglu/context-mode); [npm](https://registry.npmjs.org/context-mode)
- caveman: [README](https://raw.githubusercontent.com/JuliusBrussee/caveman/HEAD/README.md); [pantheon analysis](https://pantheon-org.github.io/agentic-context/analysis/juliusbrussee-caveman/); [npm](https://registry.npmjs.org/@caveman-ai/cli); press star counts from search-result titles: [levelup "65k-star repo"](https://levelup.gitconnected.com/i-tried-caveman-hit-a-wall-and-ended-up-sending-a-pull-request-to-a-65k-star-repo-8dc8952dcd59), [@IT "10万Star"](https://atmarkit.itmedia.co.jp/ait/articles/2608/19/news042.html)
- Token Optimizer: [site](https://token-optimizer.dev/platforms/opencode/)
- Serena: [pantheon analysis](https://pantheon-org.github.io/agentic-context/analysis/oraios-serena/); [PyPI](https://pypi.org/pypi/serena-agent/json)
- codebase-memory-mcp: [GitHub](https://github.com/DeusData/codebase-memory-mcp); [PyPI](https://pypi.org/pypi/codebase-memory-mcp/json)
- claude-context: [GitHub](https://github.com/zilliztech/claude-context); [npm](https://registry.npmjs.org/@zilliz/claude-context-mcp)
- code-index-mcp: [PyPI](https://pypi.org/pypi/code-index-mcp/json)
- repomix: [docs](https://repomix.com/guide/code-compress); [npm](https://registry.npmjs.org/repomix)
- aider: [docs](https://aider.chat/docs/repomap.html); [PyPI](https://pypi.org/pypi/aider-chat/json)
- LLMLingua: [PyPI](https://pypi.org/pypi/llmlingua/json)
- OpenSpec: [GitHub](https://github.com/Fission-AI/OpenSpec); [npm](https://registry.npmjs.org/@fission-ai/openspec)
- opencode-plugin-openspec: [GitHub](https://github.com/Octane0411/opencode-plugin-openspec); [npm](https://registry.npmjs.org/opencode-plugin-openspec)
- spec-kit-token-analyzer: [spec-kit community page](https://speckit-community.github.io/extensions/token-analyzer)
- tokenscope: [GitHub](https://github.com/ramtinJ95/opencode-tokenscope); [npm](https://registry.npmjs.org/@ramtinj95/opencode-tokenscope)
- Langfuse plugin: [Langfuse docs](https://langfuse.com/integrations/developer-tools/opencode.md)
- otel plugin: [npm](https://registry.npmjs.org/@devtheops/opencode-plugin-otel)
- tokscale: [npm](https://registry.npmjs.org/tokscale)
- LiteLLM: [PyPI](https://pypi.org/pypi/litellm/json)

Other catalogue facts:
- awesome-opencode has ~10.1k stars. Its context/token entries include DCP, opencode-snip, Context Analysis (token usage analysis), Magic Context ("lossless context management with background compression"), Opencode Log Sanitizer (redacts long strings, JWTs and base64 blobs from pasted logs "to reduce token usage"), and Harness Memory ("73 percent fewer tokens than CLAUDE.md", self-reported). Its token-tracking entries include OpenCode Token Tracker, Opencode Quota, Opencode Telemetry (SQLite cost rollups across agent chains), opencode-plugin-otel, Token Monitor, Tokscale, agenttrace, OpenTab and OC Monitor Share. It also lists OpenCodeRAG (tree-sitter chunking plus LanceDB), and under spec-driven work GoopSpec, Gem Team, NERV and the OpenSpec plugin — [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
- The current opencode is `opencode-ai` 1.19.6 (2026-11-17). An OpenCode 2 also exists. The Langfuse docs give a different config key for each: `"plugins"` for OpenCode 2 and `"plugin"` for OpenCode ≥1.18.29 — [npm opencode-ai](https://registry.npmjs.org/opencode-ai); [Langfuse opencode docs](https://langfuse.com/integrations/developer-tools/opencode.md)
- Token Optimizer reports its warnings through the V1 `experimental.chat.system.transform` path, "bridged to the V2 context hook". This shows the plugin API is changing between opencode V1 and V2 — [token-optimizer.dev](https://token-optimizer.dev/platforms/opencode/)
- pantheon-org/agentic-context is an independent-looking review site with 17 tool analyses and 17 benchmark reproductions. Its synthesis finds that "few claims are verified" and that most savings figures are "as reported". It names common pitfalls: heuristic tokenizers (rtk chars/4), bytes counted as tokens, accounting errors, extreme baselines, copied benchmark tables, and hidden costs (cold start, tools/list overhead, index-time LLM costs) — [pantheon synthesis](https://pantheon-org.github.io/agentic-context/synthesis/)

### Inferences
- No existing tool targets the OpenSpec stage structure (proposal → specs → design → tasks → apply) with per-stage context budgets. The closest pieces are sdd-skills (selective loading, per-phase context clearing), BMAD sharding, and spec-kit-token-analyzer (measurement). This is the gap a hackathon entry can fill.
- Licenses for anything a SberTech team would vendor or redistribute:
  - DCP is AGPL.
  - context-mode is ELv2.
  - RTK's engine and proxy are BUSL-1.1.
  - Taskmaster is MIT with Commons Clause ([npm](https://registry.npmjs.org/task-master-ai)).
  - Sleev uses a custom license.
  - Serena's license may have changed to GPL.
  - The MIT/Apache options are safer to embed: OpenSlimedit, Magic Context, tokenscope, Headroom, caveman, rtk-oss, repomix, codebase-memory-mcp and claude-context.

### Gaps
- Exact star counts and last-commit dates could not be read from the GitHub API (blocked). Figures come from rendered pages via a summarizing fetch.
- Sleev's README and the opencode-snip/snip repo page could not be read (rate limited). Their mechanisms are known only from npm metadata and the Upsun post.

## Q2. opencode-native context management: built-in compaction, DCP, Magic Context, OpenSlimedit, others

### Takeaway
opencode already has configurable summary compaction (and a V1 prune of old tool output). DCP and Magic Context replace or extend it with model-driven or background compression that is aware of prompt caching. OpenSlimedit cuts the fixed per-call overhead (tool schemas, read formatting) and has the most transparent small benchmark (−22% to −45% total tokens across 5 models, with per-task regressions).

### Cited Findings
- **opencode built-in compaction (V2 docs).**
  - Settings: `compaction.auto` (default true); `compaction.background` (default true, summary pre-written; unused summaries are still billed); `compaction.keep.tokens` (default 15000 kept verbatim); `compaction.buffer` (default "15%", minimum 16k); `agents.compaction.model`, which can be a cheaper model; and provider `compaction.type` "native" vs "summary".
  - The docs state that compaction "can't free space taken by fixed instructions and tool schemas". V1 used "tail-turn and pruning behavior" that V2 replaces — [opencode compaction docs](https://opencode.ai/docs/compaction.md)
- **opencode V1 prune flag.** V1 had a `compaction.prune` flag next to `compaction.auto`. Magic Context's setup disables both — [Magic Context](https://github.com/cortexkit/magic-context)
- **Kilo Code (an opencode-family agent).** Kilo describes a lighter prune pass between turns. It clears old tool outputs outside a 40,000-token recency window and replaces them with "[Old tool result content cleared]". Other settings: `compaction.preserve_recent_tokens` (25% of usable context, clamped 2,000–8,000), `tail_turns` 2, and a separate `agent.compaction.model` — [Kilo docs](https://kilo.ai/docs/customize/context/context-condensing)
- **DCP mechanism.**
  - It "Automatically reduces token usage in OpenCode by managing conversation context" and does not alter session history. Pruned content is swapped for placeholders before requests go out.
  - Features: a `compress` tool (range mode, plus experimental message mode with nested summaries); deduplication of repeated tool calls with identical args, keeping the latest; and purge of errored tool inputs after 4 turns.
  - Config: `compress.maxContextLimit` 100000 / `minContextLimit` 50000, `nudgeFrequency`, `protectedTools`, `turnProtection`. `/dcp` opens the control panel — [DCP GitHub](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
- **DCP and prompt caching.** The README reports cache hit rates of about 85% with DCP vs 90% without. It gives no token-savings figures and says savings "outweigh" cache costs "in most cases, especially in long sessions". Development has slowed, and new features land first in Sleev (`npm i -g sleev`), a local proxy — [DCP GitHub](https://github.com/Opencode-DCP/opencode-dynamic-context-pruning)
- **DCP savings claim, as relayed by Upsun.** Upsun's opencode token-optimization post quotes "50–70% reduction on long sessions" for DCP, "60–90%" for opencode-snip on bash-heavy sessions, and "11–45%" for OpenSlimedit. These come from plugin docs and are not Upsun's own measurements. Upsun recommends pinning versions, adding one plugin at a time, and checking with `/dcp stats` — [Upsun](https://developer.upsun.com/posts/ai/opencode-token-optimization). Conflict: the current DCP README fetched gives no numbers.
- **Magic Context mechanism.**
  - A background "historian" agent compresses old history into tiered "compartments". It can run on a cheaper or local model.
  - `ctx_expand` restores original ranges, and `ctx_reduce` drops stale output only at cache-safe moments.
  - It extracts decisions and constraints into project memory, has an optional "dreamer" consolidation agent, and shows a TUI sidebar with a context breakdown.
  - Setup sets `compaction.auto=false, prune=false`. There are no quantified savings claims — [Magic Context](https://github.com/cortexkit/magic-context)
- **OpenSlimedit mechanism.** It shortens built-in tool descriptions (saving input on every call), uses relative paths, and strips read-output boilerplate. It lets `oldString` be a line range such as "55-64". It adds no tools and no system prompt — [OpenSlimedit](https://github.com/ASidorenkoCode/openslimedit)
- **OpenSlimedit benchmark.**
  - Setup: 4 edit tasks, 1 iteration each, separate sessions to avoid caching.
  - Total token change vs baseline:
    - GPT 5.3 Codex: 77,494 → 42,509 (−45.1%)
    - Claude Sonnet 4.5: −32.6%
    - GPT 5.2 Codex: −26.7%
    - Minimax M2.5 Free: −24.8%
    - Claude Opus 4.6: −21.8%
  - Per-task regressions: Minimax multi-edit +248%, GPT 5.2 Codex single-edit +75%, Sonnet large-file +44%.
  - Large-file scaling: Minimax 11–19%, GPT 5.3 Codex 23–59% (5 runs per size) — [OpenSlimedit](https://github.com/ASidorenkoCode/openslimedit)
- **Token Optimizer for opencode.** Features: quality scoring with 7 signals, per-model-family MRCR curves for the context-fill signal, mode-aware "Smart Compaction", checkpoints, nudges for lean output and fresh sessions, loop detection, and the `token_status` and `token_dashboard` tools.
  - Bash output compression and JSONL trim/dedup are "not yet ported" to opencode.
  - No savings numbers — [token-optimizer.dev](https://token-optimizer.dev/platforms/opencode/)
- **opencode-plugin-openspec.** Adds an "OpenSpec Architect" planning agent with write access only to `openspec/**`, `specs/**`, `project.md` and `AGENTS.md`; the rest of the code stays read-only. It has no token features — [GitHub](https://github.com/Octane0411/opencode-plugin-openspec)

### Inferences
- Compaction settings alone are a zero-code baseline lever for the A/B demo: a cheaper compaction model is not allowed if the model must stay fixed, but the buffer and `keep.tokens` can be tuned. The fixed tool-schema and instruction overhead is untouched by compaction, which is why the OpenSlimedit approach stacks with it.
- The DCP and Magic Context cache-hit trade-off (85% vs 90%) matters for providers that discount cached tokens. A stage-aware approach that clears context at stage boundaries and loads only the needed artifacts can avoid mid-session cache invalidation entirely.

### Gaps
- No independent end-to-end benchmark of DCP, Magic Context or OpenSlimedit on a full feature was found.
- DCP's "50–70%" claim could not be traced to a current primary source.

## Q3. Command/tool-output compressors (RTK, Headroom, context-mode, snip) and how credible their savings are

### Takeaway
Vendor claims are large: RTK 60–90%, context-mode 98%, Headroom about 20% for coding agents and 42–57% in its own scenarios. Two independent paired studies found RTK produced about 0% end-to-end savings, and sometimes cost more, on frontier models. The reasons: cached reads dominate the bill, built-in Read/Grep bypass the Bash hook, and extra turns erase the gains. Headroom has the most careful self-reported methodology (provider tokenizer, accuracy benchmarks) but no independent replication yet.

### Cited Findings
- **RTK: what it is.** A single Rust binary that "filters and compresses command outputs before they reach your LLM context". It covers 100+ commands (git, cargo/npm/pytest/go test, ls/tree/cat/grep/rg, docker, kubectl, aws, terraform…) with under 10ms overhead. It uses four strategies: smart filtering, grouping, truncation and deduplication — [RTK GitHub](https://github.com/rtk-ai/rtk)
- **RTK: claims and integration.**
  - Claims 60–90% reduction on common dev commands.
  - Token counts are estimated as bytes/4 with no tokenizer. The README itself notes that savings dilute because bash output is only part of input.
  - Integrations: Claude Code (PreToolUse hook); OpenCode and OpenClaw (TypeScript plugins); Codex, Cursor, Gemini, Cline/Roo, Kilo and more.
  - The hook only fires on Bash calls, not Read/Grep/Glob.
  - `rtk gain` reports estimated savings.
  - There is an optional BUSL proxy (`rtk claude`), and `rtk-oss` is an Apache-only build — [RTK GitHub](https://github.com/rtk-ai/rtk)
- **Independent test: Quesma, 11 Sep 2026.**
  - Setup: Terminal-Bench 2.1, 1,740 attempts, 5 runs with and 5 without RTK per task. Claude Code + Fable 5.0, and OpenCode 1.18.25 + DeepSeek V4 Pro.
  - Results: total spend −5% for Fable (from one task; under 1% on others), +5% for DeepSeek/OpenCode. Pass rate 84→83% and 71→69%.
  - On DeepSeek, terminal-output characters fell 9% but prompt tokens rose 9%, with 18% more turns.
  - Cache reads were 94–98% of input tokens but only 26–30% of the bill.
  - `rtk gain` claimed 349.2M tokens saved. One looping `find` rewrite bug cost about 9× baseline (fixed in 0.46.0).
  - Conclusion: "a niche optimization" — [Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/)
- **Independent test: JetBrains AI blog, Jul 2026.**
  - Setup: Claude Code 2.1.201, claude-sonnet-5, SkillsBench 86 tasks, about 425 trials, about USD 320, paired with Wilcoxon and sign tests.
  - Low effort: median cost +7.6% (p=0.004), with +13.8% turns. High effort: +0.1% (p=0.99). Quality unchanged.
  - The hook sees about a third of Bash calls and a fifth of tool-result characters. The maximum possible saving was about 3% of input tokens.
  - rtk's analytics claimed 96.2M tokens saved while the bill went up.
  - Recommendation: measure paired billing — [JetBrains](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/)
- **Headroom: what it is.**
  - "Compress tool outputs, logs, files, and RAG chunks before they reach the LLM."
  - Components: ContentRouter → SmartCrusher (JSON), CodeCompressor (AST-aware), Kompress-v2-base (prose); CacheAligner (flags KV-cache-breaking content, "never rewrites prompts"); reversible CCR with a `headroom_retrieve` tool; and an opt-in output shaper.
  - Deploy as a library (`compress(messages, model=...)`), a proxy (`headroom proxy --port 8787`), `headroom wrap <agent>`, an MCP server, or a LiteLLM callback. OpenCode is listed among supported clients — [Headroom GitHub](https://github.com/chopratejas/headroom)
- **Headroom: self-reported savings.**
  - About 20% for coding agents and 60–95% for JSON.
  - Scenarios: code search 21%, SRE debugging 57%, codebase exploration 42%, issue triage 30%, all with the provider tokenizer.
  - Accuracy: GSM8K 0.870→0.870, TruthfulQA 0.53→0.56 (N=100), SQuAD v2 97% at 19% compression, BFCL 97% at 32%.
  - Telemetry is on by default (`HEADROOM_OFFLINE=1` disables it).
  - Not independently verified — [Headroom GitHub](https://github.com/chopratejas/headroom). Quesma says it plans a similar Headroom benchmark — [Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/)
- **context-mode: what it is.** An MCP server plus hooks:
  - `ctx_execute` runs code in a sandboxed subprocess and only stdout enters context.
  - `ctx_index` chunks markdown into SQLite FTS5/BM25 with RRF and fuzzy matching.
  - Session events are logged to SQLite and retrieved by BM25 after compaction.
  - OpenCode install: `"plugin": ["context-mode"]` — [context-mode GitHub](https://github.com/mksglu/context-mode)
- **context-mode: claims and verification.** Headline "315 KB becomes 5.4 KB. 98% reduction", measured in bytes — [context-mode GitHub](https://github.com/mksglu/context-mode). pantheon-org rates context-mode as the "preferred budget-enforcement option": summarization 95–100% verified, but with an undisclosed cold start of 1–4s per call, retrieval savings of 44–93% as reported, and license ELv2 — [pantheon synthesis](https://pantheon-org.github.io/agentic-context/synthesis/)
- **opencode-snip.** Prefixes shell commands with the `snip` CLI proxy, a Go binary, to filter git/go/cargo/npm/docker output. Claimed 60–90% on bash-heavy sessions — [Upsun](https://developer.upsun.com/posts/ai/opencode-token-optimization); [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
- **A related independent result (Writer, Jul 2026).** Harness-level techniques — search via a subagent that returns a summary, a static prompt prefix for caching, history stored outside context and injected on demand, hard limits on tokens and steps — cut average tokens per task 38% (14.2k→8.8k) and cost 41% on 22 enterprise (non-coding) tasks. Success rose 78→81% (not significant) — [devby.io](https://devby.io/ru/news/issledovateli-nashli-sposob-ekonomit-do-38-tokenov-bez-poteri-kachestva); paper [arXiv 2607.06906](https://arxiv.org/abs/2607.06906)

### Inferences
- In an SDD apply stage with heavy test runs (`npm test`, `pytest`), an output filter on test-runner output alone (pass/fail summary plus failing-test tracebacks) is likely the useful slice of RTK. Its effect must be reported as billed and cache-weighted tokens, because both independent studies showed byte savings do not map to bills.
- With weaker or smaller models (DeepSeek on opencode in Quesma), compression produced more turns. "Must work on small LLMs" therefore requires a guard: never hide failing-test details, and always allow retrieval of the raw output (as Headroom CCR and Magic Context `ctx_expand` do).

### Gaps
- No independent end-to-end benchmark of Headroom, context-mode or opencode-snip was found as of Nov 2026.

## Q4. Code retrieval / repo context tools (Serena, code graphs, vector search, packers, repo maps)

### Takeaway
Structural retrieval (LSP/AST graphs) consistently beats grep-and-read on hard multi-file tasks in the available studies. The best independent-ish data is a Russian Habr benchmark: Serena-only passed 6/6 at about 79k tokens vs a Codex-like grep+read config at about 861k. Most vendor numbers (codebase-memory 10×, claude-context 40%, agent-lsp 5–34×) are self-reported. Repo packers (repomix `--compress`, aider repo-map) give a cheap "skeleton" view suited to design/proposal stages.

### Cited Findings
- **Habr: "Какой тул лучше собирает контекст для AI-агента? Сравниваем 21 подход от ripgrep до RAG и LSP" (Jun 2026, Артем Летюшев).**
  - Setup: 21 tool configs in Agno, with gpt-4.1-mini as the agent and gpt-5.4-nano as the judge. Metric: Success Per Token (SPT).
  - Medium task: ugrep was cheapest at about 2,697 tokens; the Gemini-like read_all config used 175,208 and failed.
  - Hard task (6 reps): Serena-only 6/6 at about 79k tokens; Codex-like 6/6 (judge 0.85) at about 861k; Serena+Semble 0.79 at about 120k; read_all-style configs 0/6.
  - Conclusion: grep suits small fixes, LSP/graph tools suit complex changes, and reading everything causes "context explosion" — [Habr](https://habr.com/ru/articles/1042880/)
- **The Habr benchmark repo.** letya999/tools-token-economy is public, with 0 stars and no license stated. It is config-driven (`configs/codebase.yaml`, `configs/tasks/*.yaml`, `configs/tools.yaml`) and measures Success, SPT, Waste% (tokens read but unused), TTT and 7 judge dimensions — [GitHub](https://github.com/letya999/tools-token-economy)
- **Serena.**
  - An LSP-backed MCP with symbol lookup and editing by name path. 44 tool classes, 34 enabled by default.
  - Token efficiency is "unverified" (no benchmark harness). The `max_answer_chars` default of 150,000 characters is not a token budget. Cold start is slow on large projects.
  - Verdict: adopt for navigation and editing, but do not treat efficiency claims as benchmarked — [pantheon Serena analysis](https://pantheon-org.github.io/agentic-context/analysis/oraios-serena/)
- **codebase-memory-mcp.**
  - A native C binary with 162 vendored tree-sitter grammars, SQLite+FTS5, hybrid LSP and bundled Nomic embeddings. 17 MCP tools; opencode is named in its session-daemon section.
  - It cites arXiv 2603.27277 (31 repos): 10× fewer tokens and 2.1× fewer tool calls vs file-by-file exploration. An earlier 5-query test: about 3,400 vs 412,000 tokens. It ships `docs/MEASURING_SAVINGS.md` — [GitHub](https://github.com/DeusData/codebase-memory-mcp)
  - pantheon rates its claim "~90–99% vs grep (directional); live queries verified (~1,095 tokens); no runnable harness" — [pantheon synthesis](https://pantheon-org.github.io/agentic-context/synthesis/)
- **claude-context (Zilliz).** Hybrid BM25+dense search with AST chunking and Merkle-tree incremental indexing. Requires Milvus/Zilliz Cloud and an embedding provider (OpenAI, Voyage, Ollama, Gemini). Claims "~40% token reduction" at equal retrieval quality in a "controlled evaluation" (an `evaluation` directory exists). OpenCode is not named — [GitHub](https://github.com/zilliztech/claude-context)
- **Graph-family verdicts (pantheon).**
  - code-review-graph (7.6k stars, MIT, 8.2× as reported, with a harness) is the "default choice" in the graph family.
  - codegraph's benchmark table was "copied from code-review-graph".
  - jcodemunch-mcp claims 95% but is non-OSI.
  - osgrep: about 20% cost (as reported).
  — [pantheon synthesis](https://pantheon-org.github.io/agentic-context/synthesis/)
- **agent-lsp (vendor-adjacent).** Claims LSP saves 5×–34× bytes vs grep/read across 13 tasks, 4 codebases and 3 languages, with a reproducible Go script. The author built agent-lsp. It measures input bytes only — [DEV](https://dev.to/daynablackwell/we-measured-it-lsp-saves-ai-agents-5-34x-tokens-vs-grep-427)
- **repomix `--compress`.** Experimental. It uses tree-sitter to keep signatures, interfaces, types and class structure while removing implementation bodies, and can combine with `--remove-comments`. No published reduction percentages. MIT — [repomix docs](https://repomix.com/guide/code-compress)
- **aider repo-map.** A "concise map of your whole git repository" with key classes and functions, ranked with a graph-ranking algorithm over file dependency edges. Budget is `--map-tokens` (default 1k) and expands when no files are in chat — [aider docs](https://aider.chat/docs/repomap.html)

### Inferences
- For an OpenSpec pipeline:
  - Proposal and design stages can use a compressed skeleton (repomix `--compress`, or a repo map within a fixed budget) instead of the agent's exploratory reads.
  - The apply stage can use symbol-level retrieval (Serena or codebase-memory-mcp) scoped to files referenced in `tasks.md`/`design.md`.
- The Habr harness (SPT, Waste%) is a ready-made metric design for the hackathon's before/after report.

### Gaps
- No independent replication of the codebase-memory-mcp arXiv results was found.
- Serena's tool-definition token overhead is not quantified anywhere found.

## Q5. Output-side reduction (caveman and similar) and prompt-compression libraries (LLMLingua)

### Takeaway
caveman-style terse-output skills reliably shorten prose, but JetBrains measured only 8.5% fewer output tokens on agentic tasks (vs 65% advertised) with no quality loss. Learned prompt compression (LLMLingua-2) achieves 2–5× on general text, but research shows code tolerates compression differently and signatures must be protected. The library itself is stale on PyPI (last release Apr 2024).

### Cited Findings
- **caveman: components.** "Say less" (code, commands, paths and errors stay verbatim; prompts are never rewritten), "Read less" (compresses logs, JSON, CSV, YAML and test output), `/caveman-compress` for memory files, and `/caveman-stats`. Supported agents include Claude Code, Codex, Gemini CLI and OpenCode. Apache-2.0 — [caveman README](https://raw.githubusercontent.com/JuliusBrussee/caveman/HEAD/README.md)
- **caveman: vendor numbers.**
  - Output tokens on 10 developer questions: 6,983 baseline, 4,334 "answer concisely", 4,119 `/caveman`, 2,693 `/ultracave`.
  - Input: 33.2% fewer across 54 Claude Code runs (18/18 correct).
  - Memory files: 6,198 → 4,138 tokens.
  - Counting uses tiktoken o200k.
  - The README links a HONEST-NUMBERS doc — [caveman README](https://raw.githubusercontent.com/JuliusBrussee/caveman/HEAD/README.md)
- **caveman: pantheon critique.** The "~75%" headline is unverified, and the committed eval median is about 53% vs a terse-prompt control using a character proxy. The honest comparison is "skill vs terse, not skill vs baseline". There is no fidelity evaluation, only a single run per arm, and a tokenizer mismatch. Recommendation: avoid Ultra mode in production — [pantheon caveman analysis](https://pantheon-org.github.io/agentic-context/analysis/juliusbrussee-caveman/)
- **caveman: JetBrains test.**
  - Setup: Claude Code 2.1.200, claude-sonnet-5, 86 SkillsBench tasks, about 240 trials.
  - Output fell 592k → 542k tokens (−8.5%). Cost was about 10% cheaper per task in expectation, though raw totals were higher because of one outlier.
  - Quality: 8 better / 10 worse / 64 ties, p=0.82.
  - Conclusion: the 65% figure applies to chat Q&A, not agentic work where code and tool calls dominate — [JetBrains](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/)
- **Headroom output shaper.** `HEADROOM_OUTPUT_SHAPER=1` appends a terseness note to the system prompt. Output savings are "estimates… unless you enable a holdout control" — [Headroom GitHub](https://github.com/chopratejas/headroom)
- **LLMLingua-2.** Frames task-agnostic compression as token classification with small encoders (XLM-RoBERTa-large, mBERT). Reports 2×–5× compression, 3–6× faster than prior compressors, and 1.6–2.9× lower end-to-end latency on MeetingBank, LongBench, ZeroScrolls, GSM8K and BBH — [arXiv 2403.12968](https://arxiv.org/abs/2403.12968). The latest PyPI `llmlingua` is 0.2.2 (2024-04-09) — [PyPI](https://pypi.org/pypi/llmlingua/json)
- **"The Perplexity Paradox" (arXiv 2602.15843, Jan 2026).**
  - Code generation tolerates prompt compression at r ≥ 0.6, while chain-of-thought degrades.
  - High-perplexity code syntax is kept, but critical low-perplexity numbers get pruned.
  - Re-injecting function signatures raised pass rate from 5.3% to 39.3%.
  - Task-aware adaptive compression (TAAC) cut cost 22% at 96% quality.
  - MBPP pass rate ranged from 3.6% at r=0.3 to 54.6% at r=1.0 — [arXiv 2602.15843](https://arxiv.org/abs/2602.15843)

### Inferences
- In SDD, output tokens are generated in artifact-writing stages (proposal/specs/design/tasks). A terse style for artifacts (sdd-skills does this with tables and one-line bullets) may save more there than in apply, but it must not drop requirement scenarios. Pair it with `openspec validate` and a requirement-coverage check.
- LLMLingua-style lossy compression of specs is risky for the 100%-requirement-coverage constraint, because numbers and identifiers in requirements are exactly what perplexity-based pruning drops.

### Gaps
- No study was found that applies LLMLingua to SDD artifacts or spec files.

## Q6. Spec-driven frameworks and OpenSpec ecosystem: token cost evidence and token-saving features

### Takeaway
Independent 2026 data shows SDD adds token overhead. In Uvik's benchmark the spec phase was 28–44% of tokens, with OpenSpec the leanest at about 105k spec-phase tokens median and BMAD the heaviest at about 227k. RuStore found SDD tools cost more than its in-house skills chain, mostly from cache reads as each stage re-reads earlier artifacts. Existing token-saving features in SDD tools include sharding (BMAD), per-phase model hints and context clearing (sdd-skills), and per-stage measurement with quality gates (spec-kit-token-analyzer).

### Cited Findings
- **Uvik SDD benchmark (run 15 Oct 2026, updated 2 Nov 2026).**
  - Setup: 50 brownfield Python tickets, claude-sonnet-5.
  - Median spec-phase / build-phase tokens:

    | Arm | Spec phase | Build phase |
    |---|---|---|
    | Spec Kit | 147,206 | 286,138 |
    | Kiro | 130,986 | 276,962 |
    | BMAD | 227,212 | 290,429 |
    | OpenSpec | 104,924 | 265,717 |
    | No spec (build only) | — | 331,936 |

  - The spec phase averaged 35.1% of tokens.
  - OpenSpec: merge rate 84%, $2.71 per merged ticket, spec drift 2.4%.
  - SDD helped on features, data pipelines and tickets touching ≥3 files, but not on bug fixes or refactors.
  - Limitations: one team, Python only, one model — [Uvik](https://uvik.net/blog/spec-driven-development-benchmark/)
- **RuStore Android team blog (17 Sep 2026).**
  - Compared Spec Kit 0.16.0 and OpenSpec 1.9.0 (propose → apply) vs an in-house skills chain on Opus 5.
  - Both SDD tools used more input tokens and produced bulkier artifacts. Most of the increase was cache reads from each stage re-reading earlier artifacts.
  - The in-house chain stayed cheaper, and cost was one reason not to migrate.
  - Exact numbers are only in screenshots — [RuStore blog](https://rustore.ru/developer/blog/spec-kit-i-openspec-v-realnom-android-proekte-testiruem-sdd-na-zadachah-rustore)
- **OpenSpec.**
  - The OPSX workflow: `/opsx:explore`, `/opsx:propose` (creates `openspec/changes/<name>/` with proposal.md, specs/, design.md, tasks.md), `/opsx:apply` and `/opsx:archive`.
  - The expanded profile adds `/opsx:new`, `/opsx:continue`, `/opsx:ff`, `/opsx:verify`, `/opsx:bulk-archive` and `/opsx:onboard`.
  - It has community schemas and "Stores (beta)".
  - The README advises "clearing context before implementation" and keeping good context hygiene. It calls itself "lighter" than Spec Kit, with no quantitative token claims — [OpenSpec GitHub](https://github.com/Fission-AI/OpenSpec)
- **OpenSpec MCP tool-schema cost (PolicyLayer, computed 2026-06-07).** 848 tokens for 11 tools (o200k tokenizer), ranked #2352 of 3,213 MCP servers; the median server is 1,905 — [PolicyLayer](https://policylayer.com/token-cost/openspec)
- **sdd-skills (jorgeferrando).**
  - OpenSpec-style phases (explore → propose → spec → design → tasks → apply → verify → archive) for Claude Code, using an `openspec/` directory.
  - Techniques: per-skill `model_hint` (opus/sonnet/haiku); artifact chain plus context clearing between phases ("clearing after tasks is the most important point"); selective loading of steering files per subagent (about 8KB → 3KB); a fixed cacheable prefix; terse output; English artifacts.
  - Its numbers (60–70% from model tiering, 30% from English) are unsourced — [sdd-skills docs](https://jorgeferrando.github.io/sdd-skills/concepts/token-optimization/)
- **spec-kit Token Consumption Analyzer (v0.1.0, MIT).**
  - Records per-stage token metrics (specify/plan/tasks/implement: input, output, cache read, cache creation) from the CLI JSON, and compares baseline vs variant runs.
  - Quality score weights: section completeness 0.30, depth 0.25, cross-reference accuracy 0.20, actionability 0.15, format 0.10.
  - Acceptance gates: >10% token reduction, quality delta > −0.1.
  - Example: a "lean" preset cut total tokens by about 46.8% with a small quality drop.
  - `estimate-tokens.sh` uses chars/4 — [spec-kit community](https://speckit-community.github.io/extensions/token-analyzer); repo [coderandhiker/spec-kit-token-analyzer](https://github.com/coderandhiker/spec-kit-token-analyzer)
- **BMAD document sharding.** Splits large markdown at `##` headings into a folder with `index.md`, so workflows load only the sections they need. Uses `/bmad:core:tools:shard-doc` or `npx @kayvan/markdown-tree-parser`. The example is a PRD of about 50k tokens; no measured saving — [BMAD docs mirror](https://alexeyv.github.io/BMAD-METHOD/how-to/customization/shard-large-documents)
- **Versions and licenses.** bmad-method 6.12.4 (2026-10-14, MIT); cc-sdd 3.1.0 (2026-09-23, MIT); task-master-ai 0.43.1 (2026-03-31, "MIT WITH Commons-Clause") — [npm bmad-method](https://registry.npmjs.org/bmad-method); [npm cc-sdd](https://registry.npmjs.org/cc-sdd); [npm task-master-ai](https://registry.npmjs.org/task-master-ai)

### Inferences
- The largest SDD-specific waste is repeated re-reading of the full artifact set at every stage and every apply turn (RuStore). That points to the following levers, none of which is packaged as an opencode/OpenSpec plugin today:
  - Per-task "context slices": inject only the spec requirements and design sections that a task references, as BMAD sharding and sdd-skills selective loading do.
  - Context clearing at stage boundaries.
  - Lean artifact templates via OpenSpec custom schemas.
- spec-kit-token-analyzer's design maps almost one-to-one onto the hackathon's required report (tokens by stage, before/after, quality gate). Porting it to OpenSpec stages (propose / specs / design / tasks / apply / verify) is a low-risk component.

### Gaps
- No OpenSpec-specific token-optimization plugin or schema was found.
- The search for "openspec opencode plugin token" surfaced only the planning-agent plugin, plus minor items not verified (openspec-superpowers-opencode, @devcxl/opencode-spec).
- Kiro, Tessl, Agent OS and cc-sdd token-saving features were not researched in depth.

## Q7. Measuring tokens by stage (observability), independent of the agent

### Takeaway
Several opencode-native meters exist: tokenscope (per-session breakdown with cache analysis and subagents), the Langfuse plugin, an OTel exporter, and tokscale. A proxy meter (LiteLLM proxy → Langfuse) is provider-agnostic. Per-stage attribution of an OpenSpec pipeline still has to be added: tag each stage's session or trace, or run each stage as a separate session.

### Cited Findings
- **opencode-tokenscope.**
  - Separates recorded usage (fresh input, cache reads/writes, output, reasoning, cost) from content estimates by category (system, user, assistant, tool output).
  - Includes cache hit-rate analysis, recursive subagent usage, and estimates for tool definitions, instructions and skills.
  - Tokenizers: js-tiktoken plus Hugging Face tokenizers, with a labelled fallback.
  - Command: `/tokenscope`. Requires @opencode-ai/plugin ≥1.1.48 — [GitHub](https://github.com/ramtinJ95/opencode-tokenscope)
- **Langfuse plugin.** `@langfuse/opencode-observability-plugin` (≥0.5.0) creates one trace per user turn, with generations, nested tool calls, retries and compaction output, tagged with `environment` and `userId`. It sends prompts and tool I/O to Langfuse (a privacy concern). Langfuse also offers an "OpenCode with the AI Gateway" option — [Langfuse docs](https://langfuse.com/integrations/developer-tools/opencode.md)
- **LiteLLM proxy and other meters.**
  - The LiteLLM proxy integrates with Langfuse tracing, including OTel. Langfuse has LiteLLM proxy cookbooks — [Langfuse LiteLLM](https://langfuse.com/integrations/gateways/litellm); [LiteLLM docs](https://docs.litellm.ai/docs/observability/langfuse_otel_integration)
  - opencode-plugin-otel is an "OpenTelemetry telemetry exporter for opencode sessions, mirroring Claude Code monitoring signals" (MPL-2.0, 2.1.0) — [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode); [npm](https://registry.npmjs.org/@devtheops/opencode-plugin-otel)
  - Opencode Telemetry does "cost rollups across agent orchestration chains" in SQLite — [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
- **Measure the bill, not the tool's own counter.** Both JetBrains and Quesma warn that tool self-reports (`rtk gain`) measure the tool's own counterfactual, not the bill. They recommend paired, billing-based measurement with multiple trials (k>1) — [JetBrains rtk](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/); [Quesma](https://quesma.com/blog/does-rtk-make-ai-coding-cheaper/); [JetBrains caveman](https://blog.jetbrains.com/ai/2026/07/speak-to-ai-agents-like-cavemen-tosave-tokens/)

### Inferences
- For the hackathon report: run each OpenSpec stage as a tagged opencode session, or route through a LiteLLM proxy with per-stage metadata. Report fresh input, cache read, cache write and output separately, plus cache-weighted cost. Run k≥3 per arm, since single runs were shown to mislead (JetBrains early 10-task −29.5% vs −8.5% at scale).

### Gaps
- It was not verified whether opencode-plugin-otel emits per-generation token counts with stage attributes.
- It was not verified whether ccusage supports opencode (ccusage 20.0.51 exists on npm: [npm](https://registry.npmjs.org/ccusage)).

## Q8. Prior Russian-language / hackathon material on token-efficient SDD

### Takeaway
No prior hackathon solution specifically on token-efficient OpenSpec/SDD was found. The relevant Russian material is the RuStore Spec Kit vs OpenSpec comparison (qualitative: SDD costs more, mainly re-reads), the Habr 21-tool context benchmark with an open harness, and vc.ru posts on RTK and MCP-based Claude Code savings.

### Cited Findings
- The RuStore blog (17 Sep 2026) tested Spec Kit and OpenSpec on RuStore Android tasks — [RuStore](https://rustore.ru/developer/blog/spec-kit-i-openspec-v-realnom-android-proekte-testiruem-sdd-na-zadachah-rustore)
- The Habr 21-approach context-tool benchmark (Jun 2026) has an open repo, letya999/tools-token-economy — [Habr](https://habr.com/ru/articles/1042880/); [GitHub](https://github.com/letya999/tools-token-economy)
- vc.ru posts found but not read:
  - "Инструмент для экономии на Claude Code — до 90% дешевле" (about RTK) — [vc.ru](https://vc.ru/ai/3047760-instrument-rtk-dlya-ekonomii-na-claude-code)
  - "Как я сократил расход токенов в Claude Code на 75,5% с 17 локальными MCP — и почему byte saving недостаточно" — [vc.ru](https://vc.ru/dev/2945685-sokrashchenie-raskhoda-tokenov-v-claude-code-s-lokalnymi-mcp)
  - "Как сократить расход токенов в Claude Code: от мемов до инженерии" — [vc.ru](https://vc.ru/anetrebskii/2857194-kak-snizit-rashod-tokenov-v-claude-code)

### Inferences
- The SberTech case appears novel in targeting OpenSpec stages specifically. Reusing the RuStore observation (re-reads dominate) and the Habr SPT/Waste% metrics would ground the report in local, Russian-language evidence.

### Gaps
- The vc.ru posts, the teletype "ai token economy" post and the other Habr links (1044482, 994028, 987614) were found in search but not read.
- A pasqualepillitteri.it Russian roundup (Caveman, Ponytail, rtk, pxpipe, Headroom) was blocked by an anti-bot page.
- Telegram channels were not searched directly.
