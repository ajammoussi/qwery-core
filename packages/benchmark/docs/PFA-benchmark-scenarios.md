## **Database Selection**
keep in mind this is not the actual reality 100%, while most of this was true, the number of scenarios in each db and case differ from what was implemented, therefore you need to verify from the codebase. and the output should not be in this technical spec format, but in a research-oriented researc-paper like literature style that is both explanatory, clear, concise yet detailed enough for a technical jury to understand.

Here's the reasoning for each choice:

**Database 1 — E-commerce (primary, \~60% of sessions)**

This is the richest domain for stressing all three failure modes simultaneously. Revenue analysis naturally accumulates filters over long sessions (date ranges, regions, customer segments), table names are close enough to cause entity confusion (`orders` vs `order_items`, `customers` vs `sellers`), and the investigative pattern ("why did Q3 drop?") produces exactly the kind of multi-hypothesis exploratory sessions that expose context rot.

Don't create this from scratch. Use a schema inspired by **TPC-H** (the standard SQL benchmark) or the **Olist Brazilian E-Commerce dataset** (available on Kaggle, real data, 8 tables). The key tables you need: `orders`, `order_items`, `customers`, `products`, `categories`, `sellers`, `payments`, `reviews`. Generate 200k–500k rows of synthetic data on top if using TPC-H structure without real data — use `dbgen`. The scale matters: queries must actually take different amounts of time and return meaningfully different results so the agent has real analytical variance to work with.

**Database 2 — SaaS/B2B Analytics (secondary, \~40% of sessions)**

This tests a completely different analytical vocabulary: funnel analysis, cohort analysis, churn, MRR, DAU/MAU, feature adoption. The joins are different (event tables are wide, time-series heavy), the aggregations are different (window functions, retention curves), and the domain language is different enough that entity confusion between the two databases won't bleed into your evaluation. Core tables: `accounts`, `users`, `subscriptions`, `plans`, `events`, `feature_usage`, `invoices`. This must be fully synthetic since no good public SaaS analytics dataset exists with the right schema shape — generate it with Python using realistic distributions (e.g., churn rates \~5% monthly, power-law feature usage distributions).

**Why not logistics?** It shares too many analytical patterns with e-commerce (orders, shipments, regions, delivery times) without adding a meaningfully distinct failure mode surface. The entropy gain doesn't justify the extra session design effort.

---

## **Conversation Types**

You need 5 conversation types, covering the full failure mode surface. Each type is designed to stress at least one distinct metric from the spec. Here's the full taxonomy:

**Type 1 — Root Cause Investigation (RCI)** The user starts with a vague performance anomaly and progressively drills down through multiple competing hypotheses, most of which turn out to be dead ends. The session is long (40–50 turns) and naturally accumulates filters, table references, and established constraints. This is the primary stress test for *Filter Persistence Rate* (FPR) and *Entity Recall* (ER).

Session arc: anomaly stated → first hypothesis explored → dead end → correction/pivot → second hypothesis → confirming sub-query → drill by dimension → another dead end → final root cause identified → summary query. The compression boundary will typically fall somewhere in the dead-end exploration phase, making it the hardest test: the model must remember which hypotheses were already ruled out.

*Prompts to expect inside this type:*

* Opening: `"Revenue dropped 18% in Q3 compared to Q2. Can you help me understand why?"`  
* Schema probe: `"What date columns do we have on the orders table?"`  
* First hypothesis: `"Let's check if this is a volume problem — show me total orders per week for Q2 and Q3"`  
* Filter establishment (must persist): `"From now on, let's only look at completed orders, not cancelled or pending"` — this is one of your mandatory corrections  
* Dead-end recognition: `"That doesn't show a clear pattern. Let's try a different angle"`  
* Pivot: `"Actually, let's look by product category instead of region"`  
* Anaphoric reference crossing compression: `"Remember the weekly order volume we looked at earlier? Can you add average order value to that same breakdown?"`  
* Callback (15+ turns ago): `"What was the exact number of completed orders in week 28? I think I saw something interesting there earlier"`  
* Correction that must persist: `"You keep using created_at for the order date — always use order_date instead for all our analyses"`  
* Final: `"Now give me everything on one dashboard: weekly orders, AOV, and revenue for Q2 and Q3, only completed orders, using order_date"`

**Type 2 — Iterative Refinement with Corrections (IRC)** The user builds one primary query incrementally, correcting the agent 3–4 times along the way. Each correction is explicit and must persist for all subsequent turns. The session is medium length (25–35 turns) and dense with constraint accumulation. Primary stress test: *Filter Persistence Rate* and *Correction Rate* (the in-production signal).

Session arc: initial request → agent's first attempt → first correction → refinement → second correction → more refinement → third correction → complex aggregation → user adds column → final clean query.

*Prompts to expect:*

* `"Give me a revenue breakdown by region for the last 6 months"`  
* Correction 1 (must persist): `"We should only look at customers who signed up before 2023 — they're our legacy cohort"`  
* `"Also add a column for number of distinct customers per region"`  
* Correction 2 (must persist): `"When I say region, I mean the customer's region, not the seller's region. Please always use customer region"`  
* `"Now add a month-over-month growth percentage column"`  
* Correction 3 (must persist): `"Exclude the LATAM region from all our analyses — there's a data quality issue there"`  
* Anaphoric: `"Apply the same filters we've established to show me top 10 products by revenue"`  
* Probe (testing filter memory): `"Just to confirm — what filters are we currently applying to this analysis?"`  
* `"Great. Now do the same breakdown but for Q4 only"`

**Type 3 — Parallel Thread Analysis (PTA)** The user simultaneously investigates two distinct analytical threads (e.g., "why are enterprise accounts churning" and "which features drive retention") and occasionally cross-references them. Primary stress test: *Entity Recall* and entity confusion — the model must not mix columns, filters, or results between the two threads.

Session arc: thread A opened → thread B opened → thread A deepened → cross-reference → thread B deepened → both threads compared → synthesis.

*Prompts to expect:*

* `"I want to look at two things today. First, churn rate by account tier. Second, feature adoption by cohort. Let's start with churn."`  
* Thread A: `"Show me monthly churn rate for Enterprise accounts vs SMB accounts over the last year"`  
* Thread B: `"Now let's switch to feature adoption — what's the 30-day feature activation rate for accounts who signed up in 2024?"`  
* Thread A deepened: `"Back to churn — for the Enterprise accounts that churned, what was their average contract value?"`  
* Cross-reference (critical probe): `"Is there any overlap? Do the high-churn Enterprise accounts tend to have lower feature adoption scores?"`  
* Entity confusion trap: `"Show me the same query but for the other group"` — the model must correctly resolve "other group" to the right thread's context  
* Anaphoric: `"Apply the same date range we used for the churn analysis to the feature adoption query"`  
* Callback: `"Earlier you showed me churn rate by month — what was the churn rate in March specifically? I want to cross-check something"`

**Type 4 — Deep Callback Session (DCS)** A shorter session (30–35 turns) specifically engineered to maximize the distance between information establishment and its later retrieval. At least two explicit callbacks reference results or constraints from more than 15 turns earlier, and at least one crosses the compression boundary. This is the primary stress test for *Reference Resolution Accuracy* (RRA) and the anaphoric reference metric.

Session arc: early fact established → unrelated exploration (buffer zone filling context) → explicit callback to early fact → more exploration → second callback → synthesis referencing both.

*Prompts to expect:*

* Early (turn 2–3): `"First, let me set a baseline — what was total revenue in January 2024? Note that number for me."`  
* Early filter established (turn 4): `"For this entire session, always exclude test accounts — those are accounts where email contains '+test'"`  
* Buffer zone (turns 5–20): extensive unrelated exploration of a different metric or table  
* Callback turn 20+: `"What was that January 2024 revenue number we established at the start? I need it as a baseline"`  
* Another callback turn 25+: `"You said [something from turn 8] — can you re-run that exact query with last year's data?"`  
* Anaphoric crossing boundary: `"Do the same segmentation we did before but for February"`  
* `"If January was our baseline, what percentage of that did we achieve in each subsequent month?"`

**Type 5 — Schema Navigation and Complex Join Building (SNCJ)** The user first explores the schema (asking about tables, columns, relationships), then builds progressively more complex multi-table queries. Primary stress test: *Schema Grounding Accuracy* (SGA) — the model must not hallucinate columns or table names, especially after compression has processed the early schema exploration turns.

Session arc: schema exploration → simple single-table query → join introduced → complex multi-table query → further join added → correction about join key → final complex query referencing all earlier context.

*Prompts to expect:*

* `"Before we start, walk me through what tables are available and how they relate"`  
* `"What columns does the orders table have? Specifically around timing and status"`  
* `"How do I join orders to customers? What's the key?"`  
* Establishing correction (must persist): `"The orders table has both customer_id and billing_customer_id — always use customer_id for joining to customers"`  
* `"Give me a simple count of orders per customer for last month"`  
* `"Now add in the customer's signup date from the customers table"`  
* `"Also bring in their subscription plan from the subscriptions table"`  
* Probe for schema grounding: `"Does the subscriptions table have a column for the plan start date or just the plan name?"`  
* Anaphoric: `"Add the same revenue aggregation we computed earlier to this joined query"`  
* Callback (schema): `"Earlier you mentioned the orders table has a status column — what were the possible values again?"`  
* `"Final query: join all four tables and give me revenue by plan type, segmented by customer cohort year, only completed orders, using customer_id for joins"`

---

## **Session Count and Distribution**

For a PFA, here is the right distribution — realistic in scope without compromising evaluation quality:

|  | RCI | IRC | PTA | DCS | SNCJ | Total |
| ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| E-commerce DB | 5 | 4 | 4 | 4 | 3 | **20** |
| SaaS DB | 3 | 3 | 3 | 3 | 3 | **15** |
| **Total** | 8 | 7 | 7 | 7 | 6 | **35** |

35 sessions of 30–50 turns \= \~1,200–1,750 turns total. That's a substantial but manageable corpus for a PFA. Each session needs a gold reference query for every turn that produces SQL, written by you as the "expert" — this is your EA (Execution Accuracy) ground truth.

---

## **Variety and Anti-Bias Features**

Several things you must deliberately vary to prevent evaluation bias:

**Compression boundary placement**: The point at which overflow triggers and compression fires should fall at different turn numbers across sessions (not always turn 15). In some sessions it fires early (after a few large tool result outputs), in others late (after many short turns). This tests whether the compression system is robust regardless of where in the session the boundary lands, not just in one specific scenario.

**Anaphoric reference distance**: Vary the gap between establishment and retrieval. Some references cross a boundary that's 3 turns behind, others are 20+ turns behind. The DCS type concentrates the long-distance cases, but the other types should include some medium-distance ones.

**Correction explicitness**: Some user corrections are explicit (`"always use order_date, not created_at"`), others are implicit (`"the result you got uses created_at but I need order_date"` — the agent must infer the rule). Implicit corrections are harder for the compression system to preserve because they may not be phrased as rules.

**Query result size**: Some tool outputs in the session should be very large (full table scans returning thousands of rows before aggregation), others small. Large results are the primary trigger for pruning in the current baseline, so you need sessions where pruning fires aggressively and sessions where it barely fires at all.

**Domain vocabulary overlap**: Within each database, design some sessions where column names are similar (`order_date` vs `created_at` vs `updated_at`) to stress entity confusion metrics. This is realistic — real schemas are messy.

**User persona variation**: Some users are precise and technical (`"run a window function to compute 7-day rolling average"`), others are vague (`"can you show me a trend over time?"`). The vague users produce harder sessions for compression because the intent is encoded in the conversation context, not in the literal SQL.
