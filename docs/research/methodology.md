# Methodology for measuring token savings and proving preserved quality in an SDD coding-agent pipeline (OpenSpec + opencode), and for showing it works across model sizes (as of Nov 2026)

Scope note: research done 2026-11-21. About 35 tool calls. Sources are primary where possible (arXiv, OTel spec, LiteLLM docs, model cards). Where a claim comes from my prior knowledge and was NOT verified this session, it is in "Inferences" and marked "(unverified, prior knowledge)".

---

## 1. Token accounting: provider usage vs local tokenizers, proxy vs agent DB, attributing tokens to stages, pitfalls

### Takeaway
Use provider-reported usage as the ground truth, broken down by type: non-cached input, cache read, cache write, output, reasoning. Capture it at two independent points: an OpenAI-compatible proxy (LiteLLM, which tags each request with stage) and opencode's own message store. Cross-checking the two is itself a strong argument for judges. Input and cache-read tokens, not output, dominate agentic coding cost. Report both raw totals and a price-weighted cost, and never a single "tokens" number.

### Cited Findings
- OpenTelemetry GenAI conventions define `gen_ai.usage.input_tokens` as "The number of tokens used in the GenAI input (prompt)" and note that it "SHOULD include all types of input tokens, including cached tokens". `gen_ai.usage.cache_read.input_tokens` ("input tokens served from a provider-managed cache") and `gen_ai.usage.cache_creation.input_tokens` ("input tokens written to a provider-managed cache") SHOULD be included in input_tokens. `gen_ai.usage.reasoning.output_tokens` ("output tokens used for reasoning") SHOULD be included in output_tokens. — [OTel GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/)
- The same registry defines `gen_ai.conversation.id` ("unique identifier for a conversation (session, thread)"), `gen_ai.agent.name`, `gen_ai.agent.id`, and `gen_ai.operation.name`. Well-known operation values: `chat`, `create_agent`, `embeddings`, `execute_tool`, `generate_content`, `invoke_agent`, `invoke_workflow`, `retrieval`, `text_completion`. On opentelemetry.io these attributes are now marked "Deprecated (moved)" to the separate `semantic-conventions-genai` repo, and the span docs are still status "Development", i.e. not stable. — [OTel GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/); [OTel gen-ai spans (moved notice)](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/index.md); [semantic-conventions-genai gen-ai-spans.md](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md)
- LiteLLM proxy supports per-request tags in three ways:
  - the `x-litellm-tags` header (comma-separated);
  - a `tags` array in the request body;
  - deployment-level `tags` in config.yaml.

  Header or body tags override deployment tags, and body tags win when both are present. Tags are stored in the `request_tags` field of `LiteLLM_SpendLogs`, alongside `request_id`, `spend` and `model`. `extra_spend_tag_headers` can track spend by custom headers, and User-Agent auto-tagging can be disabled. — [LiteLLM Request Tags](https://docs.litellm.ai/docs/proxy/request_tags)
- LiteLLM also has tag budgets, spend-tracking pages, and tutorials for granular cost tracking of Claude Code and Codex through the proxy. Their contents were not fetched. — [LiteLLM Tag Budgets](https://docs.litellm.ai/docs/proxy/tag_budgets); [LiteLLM Spend Tracking](https://docs.litellm.ai/docs/proxy/cost_tracking); [Claude Code granular cost tracking](https://docs.litellm.ai/docs/tutorials/claude_code_customer_tracking)
- opencode's stored per-message usage, as modelled by the third-party `opencode-stats` crate: `tokens.input`, `tokens.output`, `tokens.cache.read`, `tokens.cache.write`, plus a per-message `cost`. The crate reads both a SQLite and a JSON data source, which means opencode has had both storage formats across versions. That model did not show a reasoning field. — [opencode-stats models.rs](https://docs.rs/crate/opencode-stats/1.3.8/source/src/db/models.rs)
- Other tools that already parse opencode usage: `ccusage` (opencode family), `opencode-tokenscope`, `tokscale`. — [ccusage opencode](https://www.mintlify.com/ryoppippi/ccusage/family/opencode); [opencode-tokenscope](https://github.com/ramtinJ95/opencode-tokenscope); [tokscale](https://github.com/junhoyeo/tokscale)
- Bai et al. ran OpenHands on SWE-bench Verified (500 tasks), 4 runs per task, with Claude Sonnet 3.7/4/4.5, GPT-5/5.2, Qwen3-Coder-480B, Kimi-K2 and Gemini-3-Pro:
  - Input tokens, not output tokens, drive agentic cost even with caching on.
  - For Sonnet-4.5, cache reads are the largest category and the largest cost contributor in every phase. Output tokens are relatively high only in Setup.
  - Output is priced about 80x cache reads, yet cache reads still dominate total cost because the context accumulates.
  - Cost spikes come from actions that add content to context: repo exploration, file views, test execution, summaries.
  - Round shares by phase: Setup 9.98%, Explore 30.37%, Fix 33.53%, Validate 16.59%, Closeout 9.53%.

  — [Bai et al., "How Do AI Agents Spend Your Money?" (arXiv 2604.22750, NeurIPS 2026)](https://arxiv.org/pdf/2604.22750)
- The same paper: more tokens did not mean higher accuracy. Accuracy rose modestly from the cheapest run to a lower-cost run, then saturated or declined. Expensive runs had sharply more repeated file views and edits. Agentic tasks use about 1000x more tokens than code reasoning or chat (the abstract says ~1000x; Section 3 says 3500x and 1200x, which the paper does not reconcile). — [Bai et al. 2604.22750](https://arxiv.org/pdf/2604.22750)
- Recording practice: record cost, latency, model, harness, prompt, permissions and a pricing snapshot separately from success/reliability. Pin the model version, or record that the provider does not offer pinning. — [Jarmak, "Engineering Reliable Coding Agents" (arXiv 2608.13867, Aug 2026)](https://arxiv.org/pdf/2608.13867)

### Inferences
- **Recommended accounting stack (dual-source, cross-validated):**
  - (a) Put opencode behind a LiteLLM proxy as a custom OpenAI-compatible provider pointing at the same upstream model. This does not change model or provider, so the case rules are respected.
  - (b) The orchestrator sets the stage on every request: `x-litellm-tags: stage=spec,run=B07,arm=optimized,feature=todo-due-dates,task=3`. If opencode cannot inject per-stage headers, run each stage as a separate opencode session or process with its own proxy virtual key or key-level default tags (LiteLLM supports default tags on keys via `metadata.tags`).
  - (c) After each run, dump `LiteLLM_SpendLogs` and opencode's message store, then reconcile per session. If the two disagree by more than 1–2%, the cause is usually missing retries, subagent calls or title/summary calls.
- **Stage taxonomy for the report** (fixed, and identical in both arms): requirements→proposal, specs, design, tasks, implement (per task 1..N), test-run/fix loops, review iteration k (k=1..K), verification. Also add a separate "overhead" stage for title generation, session compaction/summarisation, subagents and failed/retried requests. Hiding overhead is a common credibility killer.
- **Metrics to report per stage:**
  - `uncached_input`, `cache_read`, `cache_write`, `output`, `reasoning` (as a subset of output);
  - number of LLM calls;
  - number of tool calls;
  - peak context size per call (max prompt tokens), because this matters for small models (Section 5);
  - USD or RUB cost at a frozen price sheet.

  Derive "effective tokens" as uncached_input + w_cr·cache_read + w_cw·cache_write + w_out·output, with weights from the provider price list. Show raw and effective side by side, because judges may compute savings either way.
- **Cached-token pitfall (unverified, prior knowledge):** providers differ in whether "prompt/input tokens" already include cached tokens. OpenAI-style `prompt_tokens` includes `prompt_tokens_details.cached_tokens`. Anthropic-style `input_tokens` excludes `cache_read_input_tokens` and `cache_creation_input_tokens`. Normalise to the OTel convention (input includes cached) before summing, and document which convention you used. Otherwise a caching optimisation can look like 90% savings in one view and 0% in another.
- **Reasoning-token pitfall:** reasoning tokens are billed as output and sit inside output_tokens under the OTel convention. For gpt-oss and other reasoning models, the reasoning-effort setting moves both tokens and quality a lot (see Section 5). Fix reasoning effort across arms, or treat it as an explicit, disclosed optimisation with its own ablation.
- **Retries and subagents:** count all billed requests, including HTTP retries, tool-call repair loops and subagents. Counting at the proxy catches these, while the agent DB may not. Report retry counts.
- **Local tokenizer counts** (tiktoken, HF tokenizers) are useful only for (i) pre-flight sizing of artifacts, such as "spec.md is 4,200 tokens with the Qwen tokenizer", and (ii) providers that return no usage. They are not a substitute for billed usage: chat templates, tool schemas and system prompts are added server-side (unverified, prior knowledge). If used, tokenize with the exact model's tokenizer (e.g. the HF tokenizer of Qwen3-Coder) and calibrate against a handful of provider-reported calls.
- **Proxy options:** LiteLLM (tags plus SpendLogs, no code changes in the agent) is the simplest. Langfuse and Helicone add trace UIs. mitmproxy is a fallback when the agent cannot be repointed. Emitting OTel GenAI spans (with `gen_ai.conversation.id` = run id and `gen_ai.agent.name` = stage) makes the tooling portable to other repos and agents, which supports the 10% portability criterion. Langfuse, Helicone and mitmproxy were not verified this session.

### Gaps
- Not verified this session: opencode's exact current storage path and schema (e.g. `~/.local/share/opencode/...`, SQLite vs JSON in the Nov 2026 release), whether its message record has a `reasoning` token field, whether opencode can attach custom headers per request or per agent, and the details of its `opencode stats` command, if one exists.
- The LiteLLM SpendLogs field names for cache-read/cache-write tokens and the `/spend/tags` endpoint were not confirmed (the fetched page did not cover them).
- Not fetched: Langfuse/Helicone docs, and GigaChat API usage-field semantics (cached tokens), which matter if the provider is GigaChat.

---

## 2. Experimental design for stochastic agents: runs, temperature/seed, paired comparison, CIs, tests, ablations

### Takeaway
Agent runs are noisy even at temperature 0, and token consumption is far noisier than pass rates: same-task runs vary roughly 2x on average and up to 30x. So a single A/B run proves nothing. Use at least 5, ideally 8–10, independent runs per arm on the same pinned feature, repo commit and model. Report per-run values, median and mean with bootstrap 95% CIs on the ratio of savings, and a rank test (Mann-Whitney U). Then run a one-at-a-time ablation (3–5 runs each) to attribute savings. Do a power check, and pick sample sizes where an exact test can actually reach p<0.05.

### Cited Findings
- **Bjarnason, Silva, Monperrus, "On Randomness in Agentic Evals"** (KTH; arXiv 2602.07150, v2 23 Mar 2026; ICLR 2026). Setup: SWE-bench Verified; Qwen3-32B, DeepSWE-preview and Devstral-2-123B on the nano-agent and R2E-Gym scaffolds; 10 runs per config; 60,000 trajectories; 25.58B tokens; 1.88M tool calls.
  - Single-run pass@1 spans 2.2–6.0 pp across configs, with SD about 0.7–1.8%.
  - Examples: Qwen3-32B/R2E-Gym at T=0.6 scored 23.9% ± 1.4% (range 21.4–26.4). DeepSWE/nano-agent at T=1.0 scored 31.4% ± 1.0% (range 28.8–32.4).

  — [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2); [ICLR page](https://iclr.cc/virtual/2026/10016323)
- **Temperature 0 does not remove variance:** DeepSWE at T=0 scored 20.4% ± 1.0%; Qwen3-32B/R2E-Gym at T=0 scored 22.3% ± 1.8% (range 19.8–25.2). For Qwen3-32B/nano-agent, SD went up from 0.7% (T=0.6) to 1.2% (T=0). The authors attribute this to non-determinism in inference engines and environments. — [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)
- **Trajectories diverge almost immediately:** median first divergence at token 5 (T=1.0) or 56 (T=0) for DeepSWE, and 9 (T=0.6) or 32 (T=0) for Qwen3-32B. — [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)
- **pass@k vs pass^k:** Devstral-2/nano-agent has pass@1 63.5%, pass@5 76.2%, pass^5 49.1%. The largest pass@1→pass@5 gap is 24.9 pp. Recommendations: estimate pass@1 from multiple runs, use power analysis to pick the number of runs, and report pass@k and pass^k. Power table (80% power, p<0.05): about 9 runs to detect a 2% improvement at σ=1.5%; 36 runs for 1% at σ=1.5%; 8 runs for 1% at σ=0.7%; few runs for a 10% effect. Shapiro-Wilk normality held for 11 of 12 groups. — [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)
- **Token variance:** runs on the same task can differ by up to 30x in total tokens (abstract). On average, the most expensive run is about 2x the cheapest (max/min over 4 runs). Human difficulty ratings predict cost only weakly (Kendall τ=0.32). — [Bai et al. 2604.22750](https://arxiv.org/pdf/2604.22750)
- **Jarmak (Aug 2026) on repetitions and inference:**
  - Minimum practice is 3 runs per item with per-item outcomes kept.
  - Colas et al. (2018) suggest at least 20 pilot runs to estimate variance.
  - With fewer than 10 runs, a bootstrap's false-positive rate was about 10% at nominal 5%, and a five-run comparison declared two samples of the same implementation significantly different.
  - Reimers & Gurevych (2018) found spurious "significant" differences between identical systems in up to 26% of single-score comparisons.
  - In a CodeProbe case, a +0.054 single-run gap shrank to +0.0035 (95% CI −0.0005 to +0.0074) over 3 repeats.
  - Recommendations: report every run-level score plus mean and SD; randomise nuisance sources with matched realisations; pin the model; do power analysis; use paired analysis; use McNemar for pass/fail; report the minimum detectable effect; treat insufficient resolution as "inconclusive", not "equivalent".

  — [Jarmak, arXiv 2608.13867](https://arxiv.org/pdf/2608.13867)
- **Prompt sensitivity:** meaning-preserving prompt formatting changes produced a median 7.5-point accuracy spread (up to 76 points), per Sclar et al. 2023 as cited by Jarmak. This is relevant because "optimised prompts" can change quality for reasons unrelated to tokens. — [Jarmak, arXiv 2608.13867](https://arxiv.org/pdf/2608.13867)
- **Miller (Anthropic), "Adding Error Bars to Evals"** (Nov 2024):
  1. report SEM and 95% CI = mean ± 1.96·SEM;
  2. cluster standard errors on the unit of randomisation, since clustered SEs can be over 3x naive ones;
  3. reduce within-item variance by resampling;
  4. use paired differences, since models' per-question scores correlate about 0.3–0.7 and higher correlation shrinks the SE of the difference;
  5. use power analysis.

  Miller's worked example cut the minimum detectable effect from 13.2% to 7.5% by sampling more per question (cited via Jarmak). — [Anthropic, A statistical approach to model evaluations](https://www.anthropic.com/engineering/statistical-approach-to-model-evals); [arXiv 2411.00640](https://arxiv.org/abs/2411.00640v1); [Jarmak 2608.13867](https://arxiv.org/pdf/2608.13867)

### Inferences
- **Unit of analysis.** One "run" is a full pipeline execution: requirements → verification on a fresh checkout. The primary outcome is total effective tokens per run. Secondary outcomes are per-stage tokens, calls, wall-time, quality gates passed (binary), and review iterations (count).
- **Sample sizes** (my calculation, assuming per-run log-token SD ≈ 0.3, consistent with "max/min ≈ 2x over 4 runs" in Bai et al.):
  - Detecting a 30% reduction (Δlog ≈ 0.36) at 80% power with a two-sample t-test on log tokens needs about 11 runs per arm.
  - With 5 runs per arm, the minimum detectable reduction is about 40%.
  - So: 8–10 runs per arm for the headline A/B on one model. 3–5 runs per ablation arm, reported as descriptive (effect size and CI, without significance claims). Run a 3–5-run pilot first to measure the actual SD, then decide N.
- **Exact-test resolution trap** (my calculation):
  - Mann-Whitney with 3 vs 3 has a minimum two-sided p of 2/20 = 0.10, so it can never be significant. With 5 vs 5 the minimum is 2/252 ≈ 0.008.
  - Wilcoxon signed-rank with 5 pairs has a minimum two-sided p of 2/32 = 0.0625, again never significant. You need at least 6 pairs (minimum 2/64 ≈ 0.031).
  - Choose N accordingly, and state this in the report to show statistical literacy.
- **Which statistics:**
  - Main effect: savings% = 1 − median(B)/median(A), with a percentile or BCa bootstrap 95% CI. Resample runs within each arm, 10k resamples; also compute the CI on the ratio of means.
  - Significance: Mann-Whitney U (independent runs) or a Welch t-test on log tokens.
  - Effect size: Cliff's δ (or Hodges-Lehmann shift).
  - Given the 10% bootstrap false-positive rate below 10 runs (Jarmak), pair the bootstrap with the exact rank test rather than relying on it alone.
- **When to pair.** "Paired" applies when there are multiple features or tasks. Pair by feature or task and use Wilcoxon signed-rank on per-feature mean savings. For per-task quality (tests green yes/no per task across arms), use McNemar or report pass^k.
- **Temperature and seed.** Since T=0 does not give determinism and can even raise variance (Bjarnason et al.), keep the provider's recommended sampling (e.g. Qwen3-Coder: T=0.7, top_p=0.8, top_k=20, rep. penalty 1.05) identical in both arms, set a seed where the API allows it, and rely on repetitions. Do not tune temperature per arm, because that would be a confound.
- **Controls for fairness:**
  - Identical repo commit, toolchain container, model version, system prompt baseline, opencode version and config.
  - Identical requirements text and the same set of 8–12 tasks.
  - Interleave the order of A and B runs (ABBA…) to avoid time-of-day provider effects.
  - Cap iterations identically. Record and report all failed or aborted runs; do not drop them.
- **Ablation design:**
  - (i) Baseline A.
  - (ii) A + each optimisation alone (one-at-a-time, "leave-one-in").
  - (iii) Full B.
  - (iv) B minus each optimisation (leave-one-out).

  Attribute savings as Δ tokens per optimisation from leave-one-out, because interactions make one-at-a-time effects not sum to the total. Present a waterfall chart and state the interaction residual.
- **Pre-registration.** Commit `experiment.yaml` (hypotheses, N, metrics, stats tests, stopping rule) before running B. Judges value this. Report the minimum detectable effect, as Jarmak recommends.

### Gaps
- No published variance figures were found specifically for SDD/OpenSpec pipelines or for opencode, so the token SD must be measured in a pilot.
- The bootstrap/CI discussion in Bjarnason et al. beyond the fetched part was not covered (page truncated at 100k chars).

---

## 3. Requirement traceability and coverage; spec↔design↔tasks consistency; mutation testing; code coverage

### Takeaway
OpenSpec's rigid markdown grammar (`### Requirement:` / `#### Scenario:` with SHALL/MUST and GIVEN/WHEN/THEN, plus `- [ ] N.M` tasks) makes traceability machine-checkable. Assign stable IDs to every requirement and scenario, require each test to carry the scenario ID, and write a deterministic checker that fails CI unless every scenario maps to at least one passing test and every task maps to at least one requirement. Add line/branch coverage and, more importantly, mutation score as evidence that the tests are meaningful. Coverage alone can hit 100% with a mutation score of 4%.

### Cited Findings
- **OpenSpec change folder structure.** Path: `openspec/changes/<change-name>/`, containing `proposal.md`, `design.md`, `tasks.md`, optional `.openspec.yaml`, and `specs/<domain>/spec.md` delta specs.
  - Delta specs use `## ADDED Requirements` / `## MODIFIED Requirements` / `## REMOVED Requirements`.
  - Each requirement is `### Requirement: <name>` with a behaviour statement using SHALL/MUST (absolute), SHOULD (recommended) or MAY (optional).
  - Each requirement has one or more `#### Scenario: <name>` blocks with GIVEN/WHEN/THEN bullets. Good scenarios "are testable, cover happy paths and edge cases".
  - `proposal.md` has `## Intent`, `## Scope` and `## Approach`.
  - Tasks are a checklist such as `- [ ] 1.1 Create ThemeContext...`, with hierarchical numbering, each small enough for one session.
  - Archive merges deltas into `openspec/specs/` and moves the change to `changes/archive/` with a date prefix.

  — [OpenSpec docs/concepts.md](https://raw.githubusercontent.com/Fission-AI/OpenSpec/e062b9572be933564ba3899d059377dfa1393e32/docs/concepts.md)
- OpenSpec has a CLI `validate` command (with a strict mode referenced in community docs and third-party validators). Its exact checks were not fetched. — [OpenSpec user manual (community)](https://forceinjection.github.io/OpenSpec-practise/docs-en/openspec-user-manual.html); [cflx validation.rs](https://docs.rs/crate/cflx/latest/source/src/openspec_cmd/validation.rs)
- **Coverage is misleading.** "Some test suites achieve 100% coverage but only 4% mutation score". MUTGEN (mutation-guided LLM test generation) significantly outperforms EvoSuite and vanilla prompting on mutation score across 204 subjects. — [Wang, Xu, Briand, Liu, "Mutation-Guided Unit Test Generation with a LLM" (arXiv 2506.02954, v8 Apr 2026)](https://arxiv.org/abs/2506.02954)
- A comprehensive study exists on LLMs for mutation testing itself, i.e. generating mutants (not fetched in detail). — [arXiv 2406.09843](https://arxiv.org/html/2406.09843v5)

### Inferences
- **Stable IDs.** The pipeline (both arms) should emit IDs such as `REQ-<cap>-<n>` and `SCN-<cap>-<n>.<m>`, either in the heading (`### Requirement: REQ-todo-3 Due dates`) or as an HTML comment, so the OpenSpec grammar is preserved. Tasks then reference them: `- [ ] 2.1 Implement due-date validation (REQ-todo-3; SCN-todo-3.1, 3.2)`.
- **Linking tests to scenarios (pick one, keep it identical in both arms):**
  - pytest: `@pytest.mark.req("SCN-todo-3.1")` registered in `pytest.ini`, or an ID in the test name `test_SCN_todo_3_1_rejects_past_date`. Collect with `pytest --collect-only -q` plus JUnit XML (`--junitxml`) so the outcome is joined to the ID.
  - Jest/Vitest: put the ID in the title (`it('[SCN-todo-3.1] rejects past date', …)`) and use `--json` output.
  - Go/Java: a name prefix, or JUnit 5 `@Tag`/`@DisplayName`.
  - Gherkin: if scenarios are rendered as `.feature` files (pytest-bdd, Cucumber), the mapping is 1:1 by scenario name.
- **Deterministic `trace-check` script.** It parses the specs with regex on `^### Requirement:` and `^#### Scenario:`, plus tasks.md and the test report. It outputs a traceability matrix (CSV/Markdown/HTML): requirement → scenarios → tasks → tests → status. It fails the build if any of these hold:
  - a scenario has no linked test;
  - a linked test is not passing;
  - a task has no requirement reference;
  - a requirement has no task;
  - a test references an unknown ID (an orphan);
  - any requirement or scenario present in the baseline arm's input spec is missing in the optimised arm's spec. This is the "no cutting requirements" guard: diff the requirement and scenario ID sets and their normalised text hashes against the requirements given as input.

  Also run `openspec validate --strict` (verify flags in the CLI).
- **Consistency checks:**
  - Deterministic: every capability in proposal Scope has a spec, every REQ is referenced in design.md or tasks.md, every file listed in design's "File Changes" appears in the git diff, and every task checkbox is ticked.
  - LLM-judge (secondary only): a "does design contradict spec?" check with a fixed rubric, run with ≥2 judges and multiple samples, reported with agreement stats (see Section 4). Never use the LLM judge as the gate. Use it only as an additional signal.
- **Code coverage.** Use `coverage.py`/`pytest-cov` (line + branch), `c8`/`istanbul` for JS, JaCoCo for Java. Report coverage of changed lines (diff coverage) for the feature, not whole-repo coverage.
- **Mutation testing as a quality signal.** Use mutmut (Python), Stryker (JS/TS/C#) or PIT (Java), restricted to the files changed by the feature to keep runtime manageable. Report mutation score for A vs B. If B's tests are cheaper but kill as many mutants, that is strong proof of "quality not degraded". (Tool details not verified this session.)
- **Hidden held-out acceptance suite.** Write 15–30 black-box tests per demo feature from the requirements before any agent runs, store them outside the agent's workspace, and run them after verification in both arms. This is the most credible quality signal because neither arm's agent can game it. Report the pass rate per run and pass^k across runs.

### Gaps
- Not fetched: the exact `openspec validate` rules and flags, OpenSpec's native support for requirement IDs (if any), and the mutmut/Stryker/PIT docs.
- No published study was found that uses mutation score to compare token-optimised vs baseline agent pipelines.

---

## 4. Measuring review iterations and review quality; LLM-as-judge pitfalls; hidden test suite

### Takeaway
Count review iterations mechanically: number of review rounds until the reviewer returns "approve" AND all gates are green, capped at 5, with findings classified by severity. Do not let the review LLM be the quality arbiter. LLM judges show position bias, verbosity bias, self-enhancement and about 14% test-retest flip rates, so judge-based quality claims need multiple trials, order randomisation and two judges. Ground truth should come from tests (agent-written + hidden), traceability and mutation score.

### Cited Findings
- Zheng et al. (MT-Bench / Chatbot Arena, NeurIPS 2023 D&B) found position bias, verbosity bias and self-enhancement bias in LLM judges, plus limited reasoning ability. A GPT-4 judge agrees with human preferences over 80% of the time, about the same as human-human agreement. — [arXiv 2306.05685](https://arxiv.org/abs/2306.05685)
- **Yagubyan, "The Coin Flip Judge?"** (arXiv 2606.13685, Apr 2026):
  - Mean pairwise flip rate is 13.6% at T=1.0, and 28% of questions exceed a 20% flip rate (max 56%).
  - Pointwise ICC(2,1) is 0.58 (GPT-4o-mini) and 0.77 (GPT-4.1-mini).
  - T=0 cut flip rates by 79% and 43% but did not eliminate them.
  - GPT-4o-mini picked the first-presented response on 72% of questions (p=0.024).
  - Cross-judge agreement was 76% (κ=0.51).
  - Semantically equivalent prompts changed majority outcomes 25% of the time.
  - Recommendations: at least 10 trials at T=0 (20 for publication), randomise position, report ICC and κ, use at least two judges.

  — [arXiv 2606.13685](https://arxiv.org/pdf/2606.13685)
- Expensive agent runs show sharply more repeated file views and edits, i.e. unproductive loops. Problems with higher input-token cost had lower accuracy. — [Bai et al. 2604.22750](https://arxiv.org/pdf/2604.22750)

### Inferences
- **Review-iteration metric.** Define it as the number of reviewer→fixer cycles until approval and all gates pass. Report the median and the distribution across runs per arm, and the per-round findings by severity (blocker/major/minor). If the optimised arm needs more review iterations, show that the token savings are net of those extra iterations: total pipeline tokens are the primary metric, so this is automatic.
- **Guard against the optimised reviewer becoming lenient.** Replay all final diffs (A and B) through one fixed "audit reviewer" prompt that is identical for both arms. Run it N≥10 times with randomised order, and report the blocker counts found. Better still, use the deterministic gates (tests, trace-check, lint/type-check, mutation score) as the primary quality evidence and treat the LLM audit as secondary.
- **Blinding.** When an LLM judge compares A vs B diffs pairwise, strip arm labels, randomise position, and use a judge from a different model family than the agent, which reduces the self-enhancement risk flagged by Zheng et al.
- **Hidden suite.** Report the hidden-test pass rate per run, the fraction of runs with 100% hidden pass (pass^k-style), and the per-requirement failure heatmap.

### Gaps
- No literature was found quantifying review-iteration counts in LLM agent pipelines or OpenSpec workflows.
- No source was found on LLM-as-judge reliability specifically for code-review findings (as opposed to chat responses).

---

## 5. Universality across model sizes: small vs large models in agentic coding; why shorter context helps small models more

### Takeaway
Long inputs degrade all models. At 32K tokens, 11 of 13 long-context models fall below 50% of their short-context baseline on NoLiMa, and Chroma shows degradation across all 18 models tested. Small or low-reasoning-effort models also start from much lower agentic baselines and often run with reduced context windows locally. So context and token reduction is plausibly not just neutral but quality-positive for small models. Demonstrate this by running the same A/B on at least one small open model (e.g. Qwen3-Coder-30B-A3B, gpt-oss-20b, Devstral Small 2) and one large model, keeping the model fixed within each A/B pair.

### Cited Findings
- **NoLiMa** (ICML 2025): 13 LLMs claiming ≥128K context were tested. At 32K, 11 of 13 drop below 50% of their short-context baselines. GPT-4o goes from 99.3% to 69.7%. Reasoning and CoT models still struggle at long lengths. The authors attribute the drop to attention difficulty when question and needle share no literal match. — [arXiv 2502.05167](https://arxiv.org/abs/2502.05167)
- **Chroma "Context Rot"** (14 July 2025):
  - 18 LLMs (GPT-4.1, Claude 4, Gemini 2.5, Qwen3…), 194,480 calls; "models do not use their context uniformly".
  - On LongMemEval, focused prompts (~300 tokens) beat full prompts (~113k tokens) for all models.
  - Distractors reduce performance, and four distractors reduce it further than one.
  - Lower needle-question similarity degrades faster with length.
  - Even a repeated-words copy task degrades with length.
  - The report concludes that context engineering, i.e. how information is presented, matters.

  — [Chroma research: Context Rot](https://www.trychroma.com/research/context-rot); [code](https://github.com/chroma-core/context-rot)
- **gpt-oss model card** (5 Aug 2025):

  | Benchmark | 120b (low/med/high) | 20b (low/med/high) |
  |---|---|---|
  | SWE-bench Verified | 47.9 / 52.6 / 62.4 | 37.4 / 53.2 / 60.7 |
  | Aider Polyglot | 24.0 / 34.2 / 44.4 | 16.6 / 26.6 / 34.2 |
  | Tau-Bench Retail | 49.4 / 62.0 / 67.8 | 35.0 / 47.3 / 54.8 |

  Active parameters: 5.1B (120b) and 3.6B (20b). Context: 131,072 tokens. — [gpt-oss model card arXiv 2508.10925](https://arxiv.org/html/2508.10925v1)
- **Qwen3-Coder-30B-A3B-Instruct:** 30.5B total / 3.3B active parameters, native 256K context (YaRN extension to 1M), non-thinking only, "excels in tool calling" with a special function-call format. Recommended sampling: T=0.7, top_p=0.8, top_k=20, repetition_penalty=1.05. The card advises reducing context to e.g. 32,768 on OOM. — [HF model card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct)
- **SWE-bench Verified baselines in Zhao et al.** (Feb 2026; OpenHands for their own agent): Qwen3-Coder-30B-A3B-Instruct 51.6; Qwen3-30B-A3B-Instruct 22.0; GLM-4.7-Flash (30B-A3B) 59.2; SWE-smith-32B 40.2; Skywork-SWE-32B 47.9; SWE-Mirror-LM-32B 52.2. — [arXiv 2602.09892](https://arxiv.org/pdf/2602.09892)
- **SWE-bench Verified compiled by Modal** (Jul 2026; scaffolds mostly not stated): Qwen3-Coder-Next (80B-A3B) 70.6%; DeepSeek-V3.2 70%; Devstral Small 2 (24B) 68.0%; Devstral 2 (123B) 72.2%; SWE-Swiss-32B 60.2%; DeepSWE-Preview 42.2% (avg of 16 runs); SWE-agent-LM-32B 40.2%. — [Modal: best open-source models for SWE-bench](https://modal.com/resources/best-open-source-models-swe-bench-coding-agents)
- **Model efficiency differs widely.** Kimi-K2 and Sonnet-4.5 used over 1.5M more tokens on average than GPT-5 on SWE-bench Verified, even on tasks all models solved. Kimi-K2 used about 2M more tokens on failed tasks than on solved ones. — [Bai et al. 2604.22750](https://arxiv.org/pdf/2604.22750)
- **Variance holds across sizes:** Qwen3-32B, DeepSWE (32B) and Devstral-2-123B all show 0.7–1.8% SD in pass@1 across runs. — [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)

### Inferences
- **Why optimisations should help small models more.** (a) Small local deployments are often run at 32K context for memory reasons, as the Qwen card suggests, so a bloated SDD context (full specs + design + all tasks + repo map + tool outputs) can overflow or force compaction. (b) Degradation with length (NoLiMa, Chroma) compounds with a lower baseline. (c) Low-reasoning or small models fail more on tool-call formatting, and failed tool calls trigger retries that add tokens.
  - Expected pattern: on small models, the optimised arm saves tokens AND improves gate pass rate or reduces review iterations. On large models, it saves tokens with quality flat. This is a hypothesis to test, not established.
- **Model matrix for the 15% "different sizes" criterion** (the model stays fixed within each A/B):
  - Small: Qwen3-Coder-30B-A3B or gpt-oss-20b via vLLM/Ollama/OpenRouter.
  - Large: the case's target model (e.g. GigaChat-Max or another provider model), or gpt-oss-120b / Qwen3-Coder-480B / Devstral 2.

  Keep N≥5 per arm per model, and report per-model savings% with CIs plus the quality gates. Plot savings% vs model size (or SWE-bench score) to show the effect is not model-specific.
- **Optimisations most likely to transfer across sizes:**
  - Stage-scoped context: pass only the relevant requirement and scenario IDs and the files for the current task, instead of the full change folder.
  - Compact artifact formats (structured specs without prose duplication).
  - Tool-output truncation and summarisation (test logs, file views), which targets the cache-read/input-dominated cost found by Bai et al.
  - Avoiding repeated file views.
  - Reusing a stable prefix for caching.

  Changing the model, reasoning effort or provider is out of bounds per the case rules, so do not present reasoning-effort reduction as an optimisation unless it is disclosed and allowed.
- **Version pinning.** Record the exact model revision and quantisation (e.g. Q4_K_M vs FP8) and the inference engine version, since engine non-determinism drives variance (Bjarnason et al.).

### Gaps
- No primary sources were fetched for the Qwen2.5-Coder 7B/14B/32B agentic scores, Berkeley Function-Calling Leaderboard numbers, Terminal-Bench, LiveCodeBench or RULER, or for GigaChat agentic benchmarks.
- No study was found that directly measures "token/context reduction improves small-model agentic success" in an SDD-like pipeline. The claim is inferred from long-context benchmarks.
- The Qwen3-Coder-30B-A3B SWE-bench figure (51.6) comes from a third-party paper's baseline table, not the Qwen blog (not fetched), and the scaffold for that baseline was not stated.

---

## 6. Choosing the demo feature/repo and building a reproducible harness quickly

### Takeaway
Pick a small, well-specified feature in a small, test-friendly repo, e.g. adding due dates, tags and filtering to a TODO REST API, or a subcommand to a CLI tool, that naturally yields 8–12 tasks and 3–5 OpenSpec requirements with 2–4 scenarios each. Use a hidden acceptance suite written in advance. Run every repetition in a fresh container from a pinned commit (git worktree or `git clean -fdx && git reset --hard <sha>`), with the agent, proxy and test runner versions pinned.

### Cited Findings
- The evaluation harness is the apparatus that checks out the repository, invokes the agent, applies changes, runs tests and produces the score. The repository revision, dependencies, tool permissions, time limits and scoring logic are part of the experimental unit, and differing across arms invalidates pairing. — [Jarmak 2608.13867](https://arxiv.org/pdf/2608.13867)
- The SWE-agent and SWE-bench ecosystem (scaffolds such as SWE-agent, OpenHands, nano-agent, R2E-Gym) evaluates agents by running repository test suites in isolated environments. Bjarnason et al. used nano-agent and R2E-Gym, and Zhao et al. used OpenHands. — [SWE-agent paper 2405.15793](https://arxiv.org/pdf/2405.15793); [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2); [arXiv 2602.09892](https://arxiv.org/pdf/2602.09892)

### Inferences
- **Feature criteria:**
  - (a) Expressible as 3–5 requirements with 8–15 scenarios.
  - (b) Implementable in 8–12 tasks: model, migration, validation, endpoint(s), filtering, error handling, docs, tests.
  - (c) Has a fast test suite (under 30 s) so many runs are affordable.
  - (d) No external services needed.
  - (e) Some cross-cutting edge cases (validation, timezones, pagination) so quality differences can show.

  Good candidates: a FastAPI/Express TODO API ("due dates + overdue filter + sorting"), a Python Click/Typer CLI ("export/import with JSON/CSV and validation"), or a small library feature. Prepare a second repo in another language (e.g. Python → TypeScript) for the portability criterion.
- **Harness skeleton** (one command per run, `run.sh --arm A|B --model M --seed S --run-id R`):
  1. Create a git worktree at the pinned SHA, or start a Docker container from a pinned image.
  2. Start the LiteLLM proxy with run-scoped tags.
  3. Run the pipeline stages (openspec + opencode headless), each stage as its own tagged session.
  4. Run gates: agent tests, hidden suite, `trace-check`, `openspec validate`, coverage, mutation testing (changed files only).
  5. Export SpendLogs and opencode DB → `runs/<id>/usage.jsonl`.
  6. Tear down.

  Store every artifact (specs, diffs, logs, usage) per run. A matrix runner (e.g. `make bench N=10 MODELS="small large" ARMS="A B"`) produces `results.csv`.
- **Reproducibility:** pin the opencode version, OpenSpec CLI version, model revision and quantisation, inference engine, and container image digest. Freeze the price sheet. Publish `experiment.yaml` and `results.csv` so judges can re-run analysis.
- **Budget planning:** 2 arms × 2 models × 8 runs = 32 full pipeline runs for the headline result, plus about 4–6 ablation arms × 3–5 runs on one model (preferably the small one, which is cheaper and more sensitive).

### Gaps
- Not fetched: the SWE-bench harness docs (Docker image layering, `run_evaluation`), Terminal-Bench harness design, or examples of git-worktree-based agent benchmarking. Harness specifics above are practitioner inference.

---

## 7. Presenting results convincingly to technical judges

### Takeaway
Lead with one headline number that carries a CI ("−43% effective tokens, 95% CI [−51%, −35%], N=10 vs 10, Mann-Whitney p=0.0002, same model, same feature, all quality gates green in 10/10 runs of both arms"). Then show where the savings come from (per-stage stacked bars, ablation waterfall), then the quality-parity evidence (traceability matrix, hidden tests, mutation score, review iterations), then universality (the same chart for a small and a large model). Show every run, not just means.

### Cited Findings
- Report every run-level score plus mean and SD, inspect per-item outcomes, report the minimum detectable effect, and treat insufficient resolution as inconclusive. — [Jarmak 2608.13867](https://arxiv.org/pdf/2608.13867)
- Report mean differences, standard errors, confidence intervals and correlations when comparing. — [Anthropic statistical approach](https://www.anthropic.com/engineering/statistical-approach-to-model-evals)
- Report pass@k and pass^k with k>1 rather than single-run pass@1. — [arXiv 2602.07150](https://arxiv.org/html/2602.07150v2)
- Cost spikes concentrate in actions that inject content into context (exploration, file views, test outputs, summaries). Input and cache-read tokens dominate cost. — [Bai et al. 2604.22750](https://arxiv.org/pdf/2604.22750)

### Inferences
- **Slide and report sequence:**
  1. Setup card: model(s), versions, repo SHA, feature, N, pre-registered metrics.
  2. Headline: savings% with CI, raw and cost-weighted.
  3. Per-stage stacked bars (A vs B), each bar split into uncached input / cache read / cache write / output / reasoning. This directly answers the 15% "which stages consume most" criterion.
  4. A Sankey of where tokens flow (stage → token type → cost) for the baseline, to justify optimisation targets.
  5. Ablation waterfall from A total to B total, one bar per optimisation, plus an interaction residual.
  6. Strip or dot plot of every run's total tokens per arm with median and CI, which shows the variance honestly.
  7. Quality-parity table per arm:
     - requirement/scenario coverage (must be 100% in all runs);
     - per-task tests green;
     - hidden suite pass rate;
     - mutation score;
     - diff coverage;
     - review iterations (median, IQR);
     - openspec validate status.
  8. Model-size panel: the same headline and quality table for small vs large.
  9. Portability: the same harness on a second repo, with fewer runs (N=3–5) as a smoke test.
  10. Threats to validity: single feature, provider nondeterminism, prompt sensitivity (Sclar et al. via Jarmak), price-sheet assumptions.
- **What convinces technical judges:** the raw data and a one-command re-run, both arms with identical model/provider/settings (explicitly addressing the "forbidden: changing model/provider" rule), honest inclusion of failed runs, the requirement-ID diff showing nothing was cut, and the proxy and agent-DB token reconciliation.
- **Cost table:** tokens by type × frozen price → cost per run and per feature, plus projected monthly savings at a stated volume. Keep projections clearly labelled as such.

### Gaps
- No published guidance specific to hackathon judging of LLM cost optimisation was found. The presentation recommendations are synthesised from the evaluation-methodology literature above.
