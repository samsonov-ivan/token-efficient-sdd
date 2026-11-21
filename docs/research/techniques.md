# Techniques for reducing LLM token consumption in agentic coding / Spec-Driven Development (SDD) pipelines without quality loss (state as of Nov 2026)

Scope reminder: OpenSpec pipeline (proposal/specs/design/tasks -> coding agent implements 8–12 tasks -> 3–5 review iterations -> verification). Constraints: same model/provider, no cutting requirements or stages, 100% requirement coverage + green tests, must work on small and large LLMs. Each section lists measured evidence (Cited Findings) separately from my own reasoning (Inferences). Dates of sources are given in brackets.

---

## Q1. Which stages dominate token spend in coding agents (justification for where to optimise)

### Takeaway
Measured studies agree that INPUT tokens (re-reading of accumulated history, tool outputs, files) dominate, not code generation; in a multi-agent "waterfall" pipeline the iterative code-review stage alone was ~59% of tokens. In single-agent repair loops, exploration and fixing dominate rounds, and repeated file reads/edits are a major waste signal.

### Cited Findings
- Tokenomics study [Jan 20, 2026; MSR 2026; ChatDev + GPT-5, 30 tasks from ProgramDev]: "the iterative Code Review stage accounts for the majority of token consumption for an average of 59.4% of tokens"; other phases: Code Completion 26.8% (only 6 tasks), Documentation 20.1%, Testing 10.3% (12 tasks), Coding 8.6%, Design 2.4%. (Phase averages are over different task subsets and sum to ~127%, so they are not a strict partition.) — [Salim et al., Tokenomics, arXiv 2601.14470](https://arxiv.org/html/2601.14470)
- Same study: overall split input 53.9% / output 24.4% / reasoning 21.6% (≈2:1 input:output). Per phase (input/output/reasoning %): Design 60.4/3.6/36.0; Coding 6.9/58.0/35.1; Code Review 51.4/24.7/23.9; Testing 60.8/20.7/18.4; Documentation 80.2/8.3/11.5. Coding is the only phase where output dominates. Authors: "the primary cost of agentic software engineering lies not in initial code generation". Preliminary: one framework, one model. — [arXiv 2601.14470](https://arxiv.org/html/2601.14470)
- "How Do AI Agents Spend Your Money?" [2026; NeurIPS 2026 listing; OpenHands on SWE-bench Verified, 8 models incl. Claude Sonnet 3.7/4/4.5, GPT-5/5.2, Qwen3-Coder-480B, Kimi-K2, Gemini-3-Pro, 4 runs/problem]: input tokens, not output, drive cost "even when token caching is enabled"; cache reads dominate token volume and dollar cost in every phase; output priced ~80× cache reads for Sonnet 4.5. — [Bai et al., arXiv 2604.22750](https://arxiv.org/pdf/2604.22750); [NeurIPS 2026 page](https://neurips.cc/virtual/2026/170688)
- Same paper: phase share of rounds — Setup 9.98%, Explore 30.37%, Fix 33.53%, Validate 16.59%, Closeout 9.53%; cost spikes come from actions that add new content (repository exploration, test execution, final summaries); higher-cost models (Qwen3-Coder, Sonnet 4, Kimi-K2) show ~50% repeated file actions; higher-cost failed runs show sharply more repeated file views/edits; accuracy peaks at intermediate cost and saturates/degrades at the highest cost; runs on the same task can differ up to 30× in tokens (abstract; Section 3 gives ~2× per model — internal inconsistency). Agentic tasks use ~1000× more tokens than code chat/reasoning (abstract; Section 3 gives 3500×/1200×, also inconsistent). — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)
- Manus production agent [Jul 18, 2025]: average input-to-output ratio "around 100:1"; tasks average ~50 tool calls; KV-cache hit rate called "the single most important metric for a production-stage AI agent". — [Manus blog, Yichao 'Peak' Ji](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Agentic code review cost depends on code quality [Oct 15, 2026; 465 agent-authored PRs from 246 repos, frozen five-agent review-and-fix pipeline, 3 LLMs]: "each CodeHealth point was associated with 3.5% to 6.1% lower token cost"; agents "iterated more on unhealthy code without writing more comments". — [Heander et al., arXiv 2610.21914](https://arxiv.org/abs/2610.21914)

### Inferences
- For the SberTech SDD pipeline, the likely ranking of spend is: (1) review iterations (3–5 × re-reading spec + code + diffs; Tokenomics' 59.4% is the closest analogue), (2) implementation loop of 8–12 tasks where each task re-reads spec/design/project context and test logs (Explore+Fix ≈ 2/3 of rounds in Bai et al.), (3) verification (test logs), (4) artifact generation (proposal/specs/design/tasks — Design was only 2.4% in ChatDev). This ordering is an inference from analogous systems, not a measurement of OpenSpec; the team should measure it with per-stage token logging (this also earns the 15% "justification" criterion).
- Because input dominates (2:1 in ChatDev, 100:1 in Manus), techniques that cut re-read input (caching, context masking, spec slicing, log compression, diff-scoped review) have more leverage than output-side tricks, except in the Coding phase where output ≈58%.
- Repeated file views are a direct waste indicator: a "files already read this session" cache/notes file is cheap to add.

### Gaps
- No published per-stage token breakdown for OpenSpec / Spec Kit / Kiro-style SDD pipelines was found.
- Tokenomics is a single-framework, single-model preliminary study; Bai et al. has internal numeric inconsistencies (30× vs 2×; 1000× vs 3500×).

---

## Q2. Prompt caching: mechanics, per-provider pricing, prompt structure, and how to count "saved" tokens

### Takeaway
All major providers (and GigaChat) now offer prefix caching with 90–98% discounts on cache hits; it requires a byte-identical prefix, so the pipeline must be structured as stable-prefix + append-only. Caching reduces billed tokens/cost and latency, but NOT raw processed tokens or context-window load — report both metrics separately.

### Cited Findings
**Anthropic (Claude API docs, current Nov 2026)**
- Cache write 1.25× base input price for 5-min TTL, 2× for 1-hour TTL; cache read 0.1× base input (exceptions: Opus 5.5 and Sonnet 5.5 0.05×; Fable/Mythos 5.1–5.2 0.025×). — [Claude prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Minimum cacheable prompt: 512 tokens (Opus 5.5, Sonnet 5.5, Haiku 5.5, etc.), 1,024 (Sonnet 4.5/4.6/5, Opus 4/4.1/4.8), 2,048 (Opus 4.7), 4,096 (Opus 4.5/4.6, Haiku 4.5); shorter prompts silently not cached. Up to 4 explicit breakpoints; automatic caching via a top-level `cache_control={"type":"ephemeral"}` that moves the breakpoint forward as conversation grows (not supported on Bedrock runtime). Prefix order: tools -> system -> messages. Lookback window 20 blocks. — [Claude docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Cache invalidators: changing tool definitions invalidates everything; web-search/citations toggles and speed setting invalidate system+messages; tool_choice, images, thinking parameters invalidate messages; effort setting can invalidate. Usage fields: `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`; total_input = cache_read + cache_creation + input_tokens. With 1-hour cache "cache hits are not deducted against your rate limit". — [Claude docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

**OpenAI (docs, current Nov 2026)**
- Cached input "discounted up to 95%". For GPT-5.6+: minimum 1,024 visible input tokens; reads 0.1× (0.05× on GPT-6.1/6.2 variants); writes 1.25× for default 30-min TTL and 2.5× for 12-hour TTL; `prompt_cache_options.ttl` "30m"/"12h". Earlier models: no write charge, `in_memory` retention ~5–10 min inactivity up to 1 h, `24h` retention option; implicit breakpoints at 2,048-token intervals for GPT-5.5; cached tokens reported in `usage.input_tokens_details.cached_tokens` (rounded down to multiple of 128 on earlier models). `prompt_cache_key` helps routing (~15 req/min per key suggested) but "does not ... guarantee a cache hit". Guidance: "Put stable developer instructions and shared reference material first"; dynamic content (timestamps, user text) at the end; "Cache reuse requires the entire rendered prefix to match." — [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)

**Google Gemini (docs, current Nov 2026)**
- Implicit caching "enabled by default for all Gemini 2.5 and newer models"; minimum 2,048 tokens (2.5 Flash/Pro), 4,096 (Gemini 3.x / 4 Argon); savings passed automatically (no % stated on caching page). Explicit caching not supported in the Interactions API or for "Gemini 4 Argon and onward". — [Gemini caching docs](https://ai.google.dev/gemini-api/docs/caching)
- Pricing: cached input = 10% of input (90% discount): Gemini 2.5 Pro $0.125 vs $1.25/M (≤200k), 2.5 Flash $0.03 vs $0.30, 3.1 Pro Preview $0.20 vs $2.00, 3 Flash Preview $0.05 vs $0.50; explicit-cache storage $4.50/M tokens/hour (Pro) or $1.00 (Flash); not available on free tier. — [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

**DeepSeek (docs, current Nov 2026)**
- Context caching on disk is on by default, no code changes; hit only if request "fully matches a cache prefix unit"; usage fields `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; "best-effort", no 100% hit guarantee; cache cleared "within a few hours to a few days". — [DeepSeek KV cache guide](https://api-docs.deepseek.com/guides/kv_cache)
- Prices per 1M (off-peak/peak): deepseek-flash (V4.1-Flash-1017) cache hit $0.003/$0.006 vs miss $0.15/$0.30 (≈98% discount); deepseek-v4-pro hit $0.022/$0.044 vs miss $0.66/$1.32 (≈96.7%). — [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)

**GigaChat (Sber developer docs)**
- Optional `X-Session-ID` header caches the conversation context (arbitrary string; if omitted the server assigns a uuid4). If cached data with partially matching context is found for the same ID, it is not recomputed. Cached tokens "are not counted in the cost calculation" and are reported in `precached_prompt_tokens` of POST /chat/completions response. The docs state custom headers are supported only in GigaChat Python libraries (presumably raw HTTP also works, but not stated). No explicit discount rate published. — [GigaChat: работа с историей чата](https://developers.sber.ru/docs/ru/gigachat/guides/keeping-context); see also [Подсчет токенов](https://developers.sber.ru/docs/ru/gigachat/guides/counting-tokens)

**Practitioner guidance**
- Manus: cached Claude Sonnet input $0.30/MTok vs $3 uncached (10×); a single-token change invalidates the cache from that point; common mistake = precise timestamp at the start of system prompt; keep context append-only; make JSON serialization deterministic (key ordering); mask tools via logits rather than removing tool definitions mid-task. — [Manus blog, Jul 18, 2025](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Bai et al.: even with caching, cache reads dominate dollar cost in every phase of SWE-bench runs — i.e. caching alone does not make input cheap enough to ignore. — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)

### Inferences
- Prompt layout for the SDD pipeline (all stages): [tool defs, fixed] -> [system prompt + agent rules, fixed] -> [project context: repo map/AGENTS.md, fixed per run] -> [OpenSpec artifacts: proposal/specs/design/tasks, fixed per change] -> [stage-specific instruction] -> [append-only working history]. Keeping spec+context in the shared prefix lets every task and every review iteration hit the cache. Stage-specific/variable text (task ID, timestamps, diffs) must come after the last breakpoint.
- Conflict between caching and context pruning: masking/clearing old tool outputs rewrites history and invalidates the cache after the edit point (Anthropic docs list content changes as invalidators; Manus recommends append-only). Mitigation: prune in batches (e.g., only when a threshold is hit, as Anthropic's context editing does) and keep a long stable prefix before the pruned zone.
- Measurement recommendation for the 35% "savings" criterion — report three numbers per run: (a) raw processed input+output tokens (context load; caching does NOT reduce this), (b) billed-equivalent tokens = uncached_input + w_write·cache_write + w_read·cache_read + output·(output/input price ratio), (c) currency cost. Caching should be reported as a billed/cost saving, distinct from "real" token reduction (masking, slicing, compression) to avoid double-counting and to be honest with judges. On GigaChat, `precached_prompt_tokens` are free, so billed savings = cached share of prompt tokens.
- Caching is universal across model sizes (it is an infrastructure feature, quality-neutral by construction: same tokens, same outputs), which makes it the safest high-impact item for the "quality" and "universality" criteria — provided the provider/model in use supports it (small self-hosted models need vLLM/SGLang prefix caching — not researched here).
- TTL matters: OpenSpec review iterations separated by human/CI waits > 5 min will miss a 5-min cache; use 1-h (Anthropic) / 12-h (OpenAI GPT-5.6+) TTL where available, after checking write-cost multipliers (2×/2.5×) break even (needs ≥2 reads at 0.1× to beat 1.25× write; more for 2×).

### Gaps
- GigaChat: no published discount percentage beyond "not counted in cost", no TTL, minimum length, or cache-hit guarantees found; behaviour for different GigaChat model sizes (Lite/Pro/Max, GigaChat 2/3) not documented in the page fetched.
- DeepSeek prefix unit size (64 tokens in older docs) not stated in the current page.
- No independent measurement of real cache hit rates for coding agents across providers was found (beyond Bai et al. stating cache reads dominate).

---

## Q3. Context management in agents: observation masking vs summarization, tool-result clearing, compaction, sub-agents, context rot

### Takeaway
Simple observation masking (replacing old tool outputs with placeholders, keeping the last ~10 turns) roughly halves agent cost on SWE-bench Verified with no significant solve-rate loss, matching LLM summarization, which elongates trajectories. Long contexts measurably degrade accuracy ("context rot"), so pruning can improve quality, especially for small models — but small non-thinking models showed the largest drop in one configuration.

### Cited Findings
- The Complexity Trap [JetBrains Research et al.; arXiv 2508.21433, v3; SWE-agent, SWE-bench Verified 500, 250-turn limit; OM window M=10; LLM-Summary summarises N=21 turns, keeps M=10]: per-instance cost and solve rates (Raw -> OM -> LLM-Summary):
  - Qwen3-32B (non-thinking): 17.0% -> 15.0% -> 16.0%; cost $1.12 -> $0.55 (−50.9%) -> $0.50 (−55.4%)
  - Qwen3-32B (thinking): 23.0 -> 24.6 -> 24.8; $0.51 -> $0.46 (−9.8%) -> $0.51 (0%)
  - Qwen3-Coder-480B: 53.4 -> 54.8 -> 53.8; $1.29 -> $0.61 (−52.7%) -> $0.64 (−50.4%)
  - Gemini 2.5 Flash: 32.8 -> 35.6 -> 36.0; $0.41 -> $0.18 (−56.1%) -> $0.24 (−41.5%)
  - Gemini 2.5 Flash (thinking): 40.4 -> 36.4 -> 31.4; $0.56 -> $0.24 (−57.1%) -> $0.25 (−55.4%)
  - 95% bootstrap CIs ≈ ±3–4 points. Abstract: OM "halves cost relative to the Raw Agent while matching, and sometimes slightly exceeding, the solve rate of LLM-Summary". — [arXiv 2508.21433v3](https://arxiv.org/html/2508.21433v3)
- Same paper: LLM summarization elongates trajectories (Gemini 2.5 Flash: 52 turns vs 44 OM vs 50 Raw; Qwen3-Coder: +15% vs Raw, +13% vs OM) because summaries hide "stop" signals; summary generation costs up to 7.2% of instance cost; a hybrid (OM first, summarise later) cut cost a further 7% vs OM and 11% vs LLM-Summary (Qwen3-Coder-480B, SWE-bench Verified-50). Generalises to OpenHands (Gemini 2.5 Flash, 50-instance subset). — [arXiv 2508.21433](https://arxiv.org/abs/2508.21433)
- SWE-agent ACI ablation [NeurIPS 2024; GPT-4 Turbo, SWE-bench Lite]: keeping only the last 5 observations (older collapsed) 18.0% resolved vs full history 15.0%. — [Yang et al., SWE-agent, arXiv 2405.15793v3](https://arxiv.org/html/2405.15793v3)
- Anthropic context editing + memory tool [Sep 29, 2025]: context editing "automatically clears stale tool calls and results from within the context window when approaching token limits"; in a 100-turn web-search eval it reduced token consumption by 84%; context editing alone +29% performance, with memory tool +39% over baseline (internal agentic-search eval, not code). — [Claude: Managing context on the Developer Platform](https://claude.com/resources/articles/context-management)
- Anthropic "Effective context engineering for AI agents" [Sep 29, 2025] (guidance/opinion, not measured): goal = "smallest possible set of high-signal tokens"; "tool result clearing" is "one of the safest lightest touch forms of compaction"; compaction in Claude Code keeps summary + five most recently accessed files; structured note-taking (NOTES.md/to-do) outside context; just-in-time retrieval with "lightweight identifiers" (paths, queries); sub-agents may use "tens of thousands of tokens or more" but return condensed summaries "often 1,000-2,000 tokens". — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Manus [Jul 2025] (practitioner experience): use file system as externalised memory; compression must be restorable (drop page content but keep URL/path); "recitation" via rewriting todo.md keeps goals at the end of context; keep errors/stack traces in context ("leave the wrong turns in the context"). — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- ACON [Microsoft; Oct 2025; ICLR/ICML 2026 listings]: optimised compression guidelines for history+observations reduce peak tokens by 26–54% while improving task success over compression baselines (AppWorld, OfficeBench, Multi-objective QA); compressor can be distilled into smaller models; enables smaller LMs "up to 46% performance improvement by mitigating context distraction". — [Kang et al., arXiv 2510.00615](https://arxiv.org/abs/2510.00615v2)
- Chroma "Context Rot" [Jul 14, 2025; 18 LLMs incl. GPT-4.1, Claude 4, Gemini 2.5, Qwen3]: performance "grows increasingly unreliable as input length grows" even with constant task complexity; distractors compound degradation; on LongMemEval (306 prompts) all models scored significantly higher on focused prompts (~300 tokens) than full prompts (~113k tokens). — [Chroma research](https://www.trychroma.com/research/context-rot)
- Lost in the Middle [TACL; Jul 2023, rev. Nov 2023]: performance is U-shaped — highest when relevant info is at beginning or end, "significantly degrades" in the middle of long contexts. — [Liu et al., arXiv 2307.03172](https://arxiv.org/abs/2307.03172)

### Inferences
- For the pipeline: apply observation masking to the implementation and review loops (keep last ~5–10 tool outputs verbatim; replace older ones with a one-line placeholder "[output of `pytest -q` omitted; 3 failures, see notes]"). Expected ~50% cost reduction on the agentic loops based on Complexity Trap numbers; this is the single best-evidenced "real token" reduction.
- Small models: OM worked for Qwen3-32B thinking (+7% rel.) and Gemini Flash non-thinking (+8.5%), but Qwen3-32B non-thinking dropped 17.0 -> 15.0 and Gemini Flash thinking 40.4 -> 36.4 (within/near CI). So validate on the actual small model; window size M is the tuning knob. ACON suggests compression can even help small models by reducing distraction.
- Prefer masking over LLM summarisation: cheaper, deterministic, no extra LLM call, no trajectory elongation, and keeps requirement IDs intact (summaries can drop them — risk for 100% coverage).
- Sub-agent isolation fits the review stage: per-file or per-requirement reviewers with fresh small contexts return compact structured findings to the orchestrator (see Q5 OpenCodeReview). Caveat: each sub-agent re-pays the shared prefix (mitigated by caching).
- Context rot / lost-in-the-middle mean that slicing and pruning are quality-positive, not merely cost-saving — a strong argument for the 25% quality criterion; place the task's own requirements at the end (near the instruction), per the U-shape.

### Gaps
- No study measured masking specifically in spec-driven pipelines or against requirement-coverage metrics.
- Anthropic's 84% figure is from a web-search eval, not coding; no code-specific number published there.

---

## Q4. Code retrieval instead of whole-file reading (repo maps, LSP/symbol navigation, AST chunking, learned pruning)

### Takeaway
Showing the model a windowed/structured view of code instead of whole files improves both cost and quality (SWE-agent: full-file viewer cut resolve rate 18.0 -> 12.7). Learned pruners report 23–54% token reduction on SWE-bench Verified with equal or better success; LSP-based navigation vendors claim 2–34× savings vs grep+read (self-reported).

### Cited Findings
- SWE-agent ACI ablation [GPT-4 Turbo, SWE-bench Lite]: file viewer 100-line window 18.0% (default) vs 30 lines 14.3% vs full file 12.7%; summarized search results 18.0% vs iterative search 12.0% vs no search 15.7%. — [arXiv 2405.15793v3](https://arxiv.org/html/2405.15793v3)
- aider repo map: concise map of the repository with key files, most-referenced identifiers, signatures and "critical lines" of each definition; files ranked by "a graph ranking algorithm" over a file-dependency graph; default budget `--map-tokens` 1k tokens, dynamically resized (grows when no files are in chat). No measured savings published on that page. — [aider repo map docs](https://aider.chat/docs/repomap.html)
- SWE-Pruner [Jan 23, 2026, v4 May 7, 2026]: agent states a goal hint; a 0.6B "skimmer" selects relevant lines from context; "23-54% token reduction on agent tasks like SWE-Bench Verified while even improving success rates"; up to 14.84× compression on single-turn LongCodeQA; authors note perplexity-based methods (LongLLMLingua) can break code syntax/logic. — [Wang et al., arXiv 2601.16746](https://arxiv.org/abs/2601.16746)
- SWE-Pruner Pro [~Jul 2026]: lightweight head on the coder model's own prefill hidden states labels lines keep/prune; "saves up to 39% of prompt and completion tokens while preserving task quality"; on SWE-bench Verified input tokens −13.5% for Qwen3-Coder-Next (resolve 335/500 vs 341 unpruned, −1.2 pt) and +7.4% for MiMo-V2-Flash (resolve 345 vs 326, +3.8%). Requires access to model internals. — [arXiv 2607.18213 (HF page)](https://huggingface.co/papers/2607.18213.md)
- LongCodeZip [Oct 1, 2025; ASE 2025]: code-specific (function-level then block-level) compression, "up to a 5.6x compression ratio without degrading task performance" on code completion, summarization, QA; outperforms general-text pruners like LLMLingua (no per-baseline numbers in abstract). — [arXiv 2510.00446](https://arxiv.org/abs/2510.00446v1)
- agent-lsp vendor benchmark (self-reported, undated): LSP JSON responses vs grep+Read bytes, 1 token ≈ 4 bytes; overall savings 5× (Go, 15K LOC), 13× (Hono TS, 24K), 2× (FastAPI, 33K), 5× (Next.js, 196K; section totals suggest 2× — inconsistent), 34× (Consul Go, 319K); rename operations 92–1,441×; "Savings scale with codebase size"; LSP startup cost excluded. — [agent-lsp token-savings guide](https://raw.githubusercontent.com/blackwell-systems/agent-lsp/main/./docs/guide/token-savings.md)
- Bai et al.: ~50% of file actions are repeated in higher-cost models; repository exploration is a cost spike. — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)

### Inferences
- For OpenSpec "design.md"/"tasks.md": have the design stage emit an explicit file/symbol map per task (paths + symbols to touch). The implementation agent then reads only those symbols (LSP `find_symbol`/`references`, or line-windowed reads) rather than whole files — this is a deterministic, model-agnostic form of localization (cf. Agentless, Q7).
- A repo-map (tree-sitter signatures, ~1k tokens) as a cached shared prefix replaces repeated exploratory `ls`/`grep`/`cat` calls across 8–12 tasks.
- Learned pruners (SWE-Pruner, Squeez) require an auxiliary small model; that may conflict with "cannot change model/provider" unless an auxiliary local model is allowed — flag explicitly. SWE-Pruner Pro needs hidden-state access → not portable to API models.
- Small models benefit most from windowed views (less distraction; SWE-agent's full-file result is with a then-frontier model, so the effect on weaker models is plausibly at least as large — unverified).

### Gaps
- No primary, peer-reviewed measurement of Serena MCP token savings was found; only vendor/blog claims (e.g., dev.to posts claiming 95% or 5–34×) — treat as unverified.
- No measured savings from aider's repo map itself.

---

## Q5. Diff-only / incremental review and reducing review iterations

### Takeaway
A deterministic, diff-scoped review architecture (rule-based file/criteria selection, per-file sub-agents, reflection that sees only the diff) used 5–15× fewer tokens than general coding agents while doubling review quality on a 200-PR benchmark. Review cost also rises with code smells and iteration count, so fewer iterations (via deterministic gates and structured findings) is likely the biggest lever.

### Cited Findings
- OpenCodeReview [Aug 10–11, 2026]: "Rule-Guided Dispatch uses a multi-layer rule system to deterministically select files and review criteria"; grounded file review with a curated tool set (ReAct) instead of free exploration; file-level parallel sub-agents that recover cross-file dependencies on demand; "Independent Reflection" falsification-first filter where the reflector sees only the diff. Result vs Claude Code and Codex across six LLM backends on AACR-Bench (200 real PRs, 10 languages, 1,505 expert comments): "consuming 5-15x fewer tokens" and "up to 2.17x higher SEM-F1 (25.10% vs. 11.57%)". — [Li et al., arXiv 2608.09290](https://arxiv.org/abs/2608.09290)
- Tokenomics: iterative Code Review = 59.4% of tokens in ChatDev/GPT-5 (review is re-run each round over the whole codebase). — [arXiv 2601.14470](https://arxiv.org/html/2601.14470)
- CodeHealth study: each CodeHealth point ≈ 3.5–6.1% lower token cost in a five-agent review-and-fix pipeline; agents iterate more on unhealthy code. — [arXiv 2610.21914](https://arxiv.org/abs/2610.21914)
- Practitioner/vendor reports (not peer-reviewed, numbers unverified): tree-sitter "blast radius" graph for Claude Code review claimed 8.49× lower token bill — [dev.to post](https://dev.to/kenimo49/claude-code-review-blast-radius-token-bill-dropped-8-49x-with-a-tree-sitter-graph-3cdc); incremental review of only new commits since last review offered by Bito — [Bito blog](https://bito.ai/blog/how-to-perform-ai-powered-incremental-code-reviews-with-bito/).

### Inferences
- Review stage redesign for the pipeline: iteration 1 = full review of the change's diff (+ blast-radius symbols) against a requirement checklist derived from specs (one row per requirement/scenario ID); iterations 2..N = review only the delta since the previous iteration plus the open findings list (structured JSON: id, file, line, requirement-ID, status). Closed findings are not re-analysed. This turns O(N × codebase) into O(diff + Δ).
- Coverage guarantee: a deterministic traceability check (each requirement ID ↔ test/code reference) replaces part of LLM review and guarantees the 100% requirement coverage metric independently of model size.
- Fewer iterations: because each review iteration re-pays the whole context, cutting iterations from 5 to 3 saves ~40% of review-stage tokens by arithmetic; enabling it requires deterministic gates (Q9) so the LLM review doesn't find mechanical issues.
- Sub-agent per file / per requirement suits small models (short, focused contexts).

### Gaps
- No controlled study found quantifying savings from "delta-only" re-review across iterations specifically; OpenCodeReview is single-pass review.
- No public data on how many review iterations are typically needed vs model size.

---

## Q6. Test/log output compression

### Takeaway
Tool outputs are a main source of new input tokens (test execution is a cost spike). Failure-only, deduplicated, truncated output is effective: practitioner CLI proxies claim 60–90% reduction of command output; a 2B learned pruner removed 92% of tool-output tokens with 0.86 recall. Savings on the total bill are smaller because tool output is only one part of input.

### Cited Findings
- RTK (Rust Token Killer, open source): "CLI proxy that reduces LLM token consumption by 60-90% on common dev commands"; techniques: noise filtering, grouping (files by dir, errors by type), truncation, deduplication ("Collapses repeated log lines with counts"), failure-only test output (cargo/npm test: "Failures only, passing tests collapsed to a count"; pytest: "Failures only, traceback trimmed"; go test: "NDJSON parsed, failures only"); git log reduced to hash/author/subject. Caveats stated by the authors: savings measured on bash output only (bytes/4 estimate), "one contributor to input tokens", savings "dilute at every step"; built-in Read/Grep/Glob tools not covered; <10 ms overhead; supports 18 agent tools via hooks or AGENTS.md rules. — [rtk-ai/rtk GitHub](https://github.com/rtk-ai/rtk)
- Squeez [Apr 4, 2026]: task-conditioned tool-output pruning with LoRA-fine-tuned Qwen 3.5 2B; removes "92% of input tokens" with "0.86 recall and 0.80 F1"; beats zero-shot Qwen 3.5 35B-A3B by 11 recall points and heuristic baselines "by a wide margin"; dataset 11,477 examples from SWE-bench interactions + synthetic tool outputs. — [Kovács, arXiv 2604.04979](https://arxiv.org/abs/2604.04979)
- Bai et al.: test execution and repository exploration are among the actions causing cost spikes. — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)
- SWE-agent ACI principle: concise, summarized tool outputs (summarized search 18.0% vs iterative 12.0%). — [arXiv 2405.15793v3](https://arxiv.org/html/2405.15793v3)
- Manus caution: keep errors and stack traces in context so the model doesn't repeat mistakes. — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

### Inferences
- For the pipeline: run tests via a wrapper that emits a structured summary (JSON/JUnit -> "N passed, M failed" + for each failure: test id, assertion message, top project-frame(s) of stack trace, max K lines). Write the full log to a file and pass the path (restorable compression, per Manus/Anthropic just-in-time guidance). Same for linters (group by rule), build logs (errors only), `git diff --stat` before full diffs.
- This is deterministic, model-independent, and quality-safe if the failure details are preserved (do not trim the error message itself); for green runs the output collapses to one line — very large savings in the verification stage.
- Learned pruning (Squeez) is stronger but adds an auxiliary model; deterministic filters are the portable baseline.

### Gaps
- No peer-reviewed end-to-end measurement of failure-only test reporting on agent success rate was found; RTK's 60–90% is self-reported on command output, not billed tokens.

---

## Q7. Prompt compression (LLMLingua family, selective context) — and risks for code/spec text

### Takeaway
General prompt compressors achieve 2–5× (LLMLingua-2) and code-specific ones up to 5.6× (LongCodeZip) on benchmarks, but token-level pruning can break code syntax and drop exact identifiers; for specs with requirement IDs and normative "SHALL" statements this is a coverage risk. Prefer structure-aware, lossless-or-restorable reductions.

### Cited Findings
- LLMLingua-2 [Mar 2024; ACL Findings 2024]: task-agnostic compression via token classification distilled from GPT-4; "compression ratios of 2x-5x", "3x-6x faster than existing prompt compression methods", end-to-end latency "1.6x-2.9x" faster; evaluated on MeetingBank, LongBench, ZeroScrolls, GSM8K, BBH (no code/agent benchmarks). — [Pan et al., arXiv 2403.12968](https://arxiv.org/abs/2403.12968)
- LongCodeZip: up to 5.6× on code tasks without degrading performance; general-text pruners like LLMLingua "overlook code-specific structures". — [arXiv 2510.00446](https://arxiv.org/abs/2510.00446v1)
- SWE-Pruner authors: perplexity-based methods such as LongLLMLingua can break syntactic and logical structure in code. — [arXiv 2601.16746](https://arxiv.org/abs/2601.16746)
- Local-Splitter measurement study [Apr 14, 2026]: seven tactics (local routing, prompt compression, semantic caching, local drafting + cloud review, minimal-diff edits, structured intent extraction, batching with vendor prompt caching); local routing + prompt compression gave "45-79% cloud token savings" on edit- and explanation-heavy workloads; full set 51% on RAG-heavy; optimal subset is workload-dependent; output quality not reported in abstract. — [Agyemang et al., arXiv 2604.12301](https://arxiv.org/abs/2604.12301)

### Inferences
- In this pipeline, apply LLMLingua-style compression only to prose with low exactness requirements (e.g., proposal rationale, long logs' narrative parts), never to code, requirement IDs, acceptance scenarios, or API signatures. Structural "compression" (dedupe repeated context, remove boilerplate, convert verbose markdown to compact lists/tables) is safer.
- Note that LLMLingua requires a small auxiliary LM (e.g., XLM-RoBERTa/LLaMA-7B in the original works) — possibly in conflict with the "same provider" constraint; Local-Splitter's best result relies on local routing, which changes the model and is therefore disallowed by the case rules.
- Compressed prompts also hurt cache hit rates if compression is non-deterministic.

### Gaps
- No study found evaluating LLMLingua on requirement/spec documents or on agentic coding success rates.

---

## Q8. Spec slicing, task batching, plan-then-execute, Agentless-style fixed pipelines, ACI design

### Takeaway
Fixed, localization-first pipelines (Agentless) achieve competitive repair rates at low cost without letting the LLM drive exploration; ACI design choices (windowed views, summarised search, lint-on-edit, history collapsing) each add 3–6 points of resolve rate. No direct measurement of "spec slicing" exists, but context-rot evidence and focused-vs-full prompt results support it.

### Cited Findings
- Agentless [Jul 2024, v2 Oct 29, 2024]: "simplistic three-phase process of localization, repair, and patch validation" with no LLM-driven action planning; 32.00% (96 fixes) on SWE-bench Lite at "low cost ($0.70)" per issue, highest among open-source agents at the time. — [Xia et al., arXiv 2407.01489](https://arxiv.org/abs/2407.01489)
- SWE-agent with GPT-4 Turbo on SWE-bench Lite: average cost $1.67 per instance (different model and date than Agentless, so not a controlled comparison). Ablations: summarized search +6.0 pts vs iterative; 100-line window +5.3 vs full file; lint-on-edit +3.0 vs no lint; last-5 observations +3.0 vs full history. — [arXiv 2405.15793v3](https://arxiv.org/html/2405.15793v3)
- Chroma: focused prompts (~300 tokens) beat full prompts (~113k tokens) for all 18 models on LongMemEval. — [Chroma](https://www.trychroma.com/research/context-rot)
- Anthropic: "just-in-time" retrieval with lightweight identifiers; sub-agents return 1,000–2,000-token summaries. — [Anthropic Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Manus: todo.md recitation keeps the current goal at the end of context over ~50 tool calls. — [Manus blog](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)

### Inferences
- Spec slicing for OpenSpec: at tasks.md generation, tag each task with the requirement/scenario IDs and files/symbols it touches; per task, the agent receives (a) cached shared prefix (rules + repo map + compact spec index of all requirement IDs with one-line titles), (b) the full text only of its own requirements/scenarios and relevant design section, (c) the task. The full spec stays on disk for just-in-time lookup. This keeps 100% coverage (every ID is assigned to ≥1 task and verified by a deterministic traceability check) while cutting per-task spec input roughly in proportion to 1/(number of tasks) for the spec body. Trade-off: the shared-prefix cache helps the full-spec approach too, so slicing's billed-cost advantage is smaller than its raw-token advantage; its quality advantage (less distraction) is larger for small models.
- Task batching: group tightly coupled tasks (same files) into one agent session to avoid re-exploring the same code; keep unrelated tasks in separate fresh contexts (avoid cross-task history accumulation).
- Plan-then-execute (Agentless style): deterministic localization from design.md + repo map, then LLM edit, then deterministic validation (tests/lints) — fewer exploratory turns, which Bai et al. show are where tokens go.

### Gaps
- No direct empirical study of requirement-level spec slicing in SDD pipelines was found.
- Agentless costs on newer models/SWE-bench Verified were not retrieved in this pass.

---

## Q9. Output-side savings (edit formats, terse output, reasoning budgets) and deterministic pre-checks

### Takeaway
Diff/patch edit formats avoid regenerating whole files and can also improve quality (aider unified diffs: 20% -> 61% on a laziness benchmark for GPT-4 Turbo). Output tokens are expensive per token (e.g., ~80× cache reads for Sonnet 4.5; $10 vs $1.25/M for GPT-5) but a minority of volume, except in the Coding phase. Deterministic gates (lint-on-edit, tests, rule-based dispatch) both raise quality and remove LLM work.

### Cited Findings
- aider edit formats: "whole" is simple but "can be slow and costly" because the full file is returned; "diff" (search/replace) and "udiff" are "efficient" because only changed parts are returned; diff-fenced used mainly for Gemini; editor-diff/editor-whole for architect mode. — [aider edit formats](https://aider.chat/docs/more/edit-formats.html)
- aider unified diffs (GPT-4 Turbo 1106): baseline SEARCH/REPLACE scored 20% on the laziness benchmark (lazy comments in 12 tasks); udiff raised it to 61% and "reduced laziness by 3X" (lazy comments in 4 tasks). — [aider unified diffs](https://aider.chat/docs/unified-diffs.html)
- Tokenomics: Coding phase is 58.0% output and 35.1% reasoning — the one phase where output-side techniques matter most; reasoning is 21.6% of all tokens. — [arXiv 2601.14470](https://arxiv.org/html/2601.14470)
- Bai et al.: output ~80× price of cache reads for Sonnet 4.5; GPT-5 input $1.25/M, cached $0.125/M, output $10/M. — [arXiv 2604.22750](https://arxiv.org/pdf/2604.22750)
- Complexity Trap: thinking vs non-thinking modes change both cost and the effect of context strategies (e.g., Gemini 2.5 Flash thinking: OM −9.9% relative solve rate, LLM-Summary −22.3%). — [arXiv 2508.21433v3](https://arxiv.org/html/2508.21433v3)
- Token-Budget-Aware LLM Reasoning (TALE) [v1 Jan 2025, v6 Oct 19, 2026]: including a token budget in the prompt "effectively reduces token costs in CoT reasoning ... with only a slight performance reduction"; budget choice is crucial (no numbers on the abstract page). — [Han et al., arXiv 2412.18547](https://arxiv.org/abs/2412.18547)
- Deterministic gates: SWE-agent lint-on-edit 18.0% vs 15.0% without — linter rejects syntactically broken edits before they enter the trajectory. — [arXiv 2405.15793v3](https://arxiv.org/html/2405.15793v3); OpenCodeReview's deterministic rule-based dispatch is part of its 5–15× token reduction. — [arXiv 2608.09290](https://arxiv.org/abs/2608.09290); CodeHealth: unhealthy code (smells) predicts higher review/fix cost. — [arXiv 2610.21914](https://arxiv.org/abs/2610.21914)

### Inferences
- Use search/replace or unified-diff edits for implementation; but weaker/small models may mis-format diffs (aider keeps "whole" and format variants per model family for this reason) — make the edit format configurable per model and fall back to whole-file edits only for small files.
- Ask reviewers for structured, terse output (JSON findings with IDs, no restating code); ask implementer for no prose recap. Cap reasoning effort for mechanical stages (formatting, log triage) and keep higher effort for design/review — but changing reasoning/effort parameters can invalidate caches (Anthropic docs), so fix them per stage.
- Order of gates before any LLM review: formatter -> linter -> type checker -> unit tests -> requirement-traceability check. Only pass to the LLM the residual (failures, unresolved requirement IDs, diff). This shrinks review iterations and guarantees "green tests" deterministically.

### Gaps
- No rigorous study found measuring "terse output" instructions' effect on agentic coding quality; TALE numbers not visible on abstract page.
- No benchmark comparing edit formats on token counts directly (aider reports correctness, not tokens).

---

## Q10. Ranked catalogue for this pipeline (synthesis)

### Takeaway
Highest expected impact with low quality risk: (1) prompt caching with a stable prefix, (2) observation masking/tool-result clearing in agent loops, (3) diff-scoped, delta-only review with structured findings and deterministic gates (fewer iterations), (4) test/log compression, (5) spec slicing + symbol-level retrieval. Learned/LLMLingua compression is lowest priority due to code/spec fidelity risk and auxiliary-model requirement.

### Cited Findings
- Evidence anchors: caching discounts 90% (Gemini, Anthropic standard), up to 95% (OpenAI), ~97–98% (DeepSeek), free cached tokens (GigaChat) — [Claude](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching), [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing), [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing), [GigaChat](https://developers.sber.ru/docs/ru/gigachat/guides/keeping-context); masking ≈ −50% cost — [Complexity Trap](https://arxiv.org/html/2508.21433v3); context editing −84% tokens (search eval) — [Claude](https://claude.com/resources/articles/context-management); diff-scoped review 5–15× fewer tokens — [OpenCodeReview](https://arxiv.org/abs/2608.09290); review = 59.4% of tokens — [Tokenomics](https://arxiv.org/html/2601.14470); command output −60–90% — [RTK](https://github.com/rtk-ai/rtk); tool-output pruning −92% tokens at 0.86 recall — [Squeez](https://arxiv.org/abs/2604.04979); context pruning −23–54% on SWE-bench Verified — [SWE-Pruner](https://arxiv.org/abs/2601.16746); ACON −26–54% peak tokens — [ACON](https://arxiv.org/abs/2510.00615v2).

### Inferences
Ranked table (expected impact for THIS pipeline; my judgement combining measured numbers with pipeline structure):

| # | Technique | Pipeline stage | Reported savings (source) | Quality impact (evidence) | Main risks | Small-model fit |
|---|---|---|---|---|---|---|
| 1 | Prompt caching, stable prefix (tools->rules->repo map->OpenSpec artifacts), append-only history, deterministic serialization, long TTL across review rounds | All stages, esp. 8–12 tasks + 3–5 reviews sharing spec | 90–98% off cached input price (provider docs); raw tokens unchanged | Neutral by construction | Cache invalidation by any prefix change, TTL expiry, min length (512–4,096 tok), write premium 1.25–2.5×; must report as billed/cost not raw | Universal if provider supports it (GigaChat: X-Session-ID) |
| 2 | Observation masking / tool-result clearing (keep last M≈5–10 outputs) | Implementation & review agent loops | ≈50–57% cost cut (Complexity Trap); −84% tokens (Anthropic, search eval) | Solve rate within CI, sometimes better; SWE-agent +3 pts vs full history | Breaks cache at edit point; some small/thinking configs dropped 2–4 pts | Good; tune M; ACON shows compression can help small LMs |
| 3 | Diff-scoped, delta-only review with structured findings, per-file sub-agents, deterministic dispatch; fewer iterations | Review (3–5 iterations) | 5–15× fewer tokens + 2.17× F1 (OpenCodeReview); review was 59.4% of tokens (Tokenomics) | Positive in OpenCodeReview | Missing cross-file issues (mitigate with blast-radius symbols); must still check all requirement IDs | Good (short focused contexts) |
| 4 | Deterministic gates before LLM (format, lint, typecheck, tests, traceability matrix) | Implementation, review, verification | Indirect: lint-on-edit +3 pts (SWE-agent); healthier code 3.5–6.1% lower cost per CodeHealth point | Positive; guarantees green tests & coverage | Tooling setup per language (portability) | Excellent — model-independent |
| 5 | Test/log/command output compression (failure-only, dedupe, trimmed traces, full log to file) | Implementation loop, verification | 60–90% of command output (RTK, self-reported); 92% at 0.86 recall (Squeez, learned) | Neutral if failure details kept; Manus warns to keep errors | Over-trimming hides root cause | Excellent (deterministic) |
| 6 | Spec slicing per task + compact requirement index + just-in-time lookup; task batching by shared files | Implementation (8–12 tasks), review | No direct measurement; focused prompts beat full prompts for all 18 models (Chroma) | Likely positive (less distraction, lost-in-middle) | Missing cross-cutting requirements; mitigated by ID traceability | Strong benefit for small models |
| 7 | Symbol-level retrieval / windowed file views / repo map instead of whole files | Implementation, review | 100-line window +5.3 pts vs full file (SWE-agent); SWE-Pruner −23–54%; LSP vendors 2–34× (unverified) | Positive in SWE-agent, SWE-Pruner | Needs LSP/tree-sitter per language; learned pruners need an aux model | Good |
| 8 | Output-side: diff/search-replace edits, terse structured outputs, per-stage reasoning budgets | Coding (58% output), review reports | udiff 20%->61% laziness benchmark (aider); TALE "slight" loss | Can improve (less laziness) | Small models mis-format diffs; effort changes can invalidate cache | Mixed — keep per-model fallback |
| 9 | LLM summarisation/compaction of history | Long sessions only | −41–55% cost but +13–15% longer trajectories, up to 7.2% summary overhead (Complexity Trap) | Mixed (−22% in one config) | Drops requirement IDs; extra LLM call | Weaker than masking |
| 10 | Token-level prompt compression (LLMLingua-2, LongCodeZip) | Long prose context only | 2–5× (LLMLingua-2); 5.6× code (LongCodeZip) | Benchmark-neutral, untested on agents/specs | Breaks code syntax (SWE-Pruner authors); auxiliary model; non-deterministic -> cache misses | Unclear |

- Rough additive model (illustrative, not measured): if review ≈ 50–60% and implementation ≈ 30–40% of tokens, masking (−50% of loop tokens) + delta-only review (cutting re-reads in iterations 2..N) + log compression could reduce RAW tokens by roughly 40–60%; caching then reduces BILLED cost of the remaining input by up to ~90% of the cached share. Must be validated by the team's own per-stage logging on the same tasks, small and large model, with requirement coverage and test status recorded per run.

### Gaps
- No single study evaluates the combination of these techniques in an SDD pipeline; interactions (e.g., masking vs caching) are only qualitatively described.
- Small-model behaviour evidence is limited to Qwen3-32B / Gemini Flash (Complexity Trap) and ACON; no GigaChat-specific evaluations were found.
