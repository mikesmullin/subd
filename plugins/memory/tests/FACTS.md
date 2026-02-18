# FACTS Testing Convention

This file defines how we run memory tests for the `plugins/memory` flow using natural language scenarios instead of code-based test fixtures.

## Purpose

These are **integration tests written in human language**.

- We test the full pipeline end-to-end:
  - user input
  - hook extraction/maintenance
  - `memo` persistence
  - semantic recall
  - final assistant response
- We do this with realistic prompts, not synthetic unit mocks.

## Core Idea

Each test scenario is written like an AI prompt spec:

- **Given** one natural user fact (no hint like "remember this")
- **When** a semantically related but differently worded question is asked
- **Then** recall should return the stored fact and the assistant answer should match it

## Test Cycle Convention (Single Scenario)

Run scenarios one-by-one with strict isolation.

1. Clear memory
2. Seed exactly one fact
3. Ask one paraphrased recall question
4. Verify both:
   - `memo recall` hit is semantically correct
   - final answer matches the intended fact
5. Record real I/O

### Required execution style

- Use `-v` (`subd -v -t memory-answer ...`) so hook/tool traces are visible.
- Use **one fact, one question** per scenario.
- Do not reuse exact phrasing from the seed statement in the question.
- Prefer different wording/synonyms to validate semantic retrieval (not string matching).

## Canonical Commands

```bash
memo clear # do this only once at the beginning of the test session, but not between each test (it's useful to see if agent can choose the right fact when multiple unrelated facts might be returned)
subd -v -t memory-answer "<seed fact statement>"
subd -v -t memory-answer "<paraphrased recall question>"
```

## Pass/Fail Rules

A scenario **passes** when all are true:

- Seed turn stores the fact (or acknowledges with no contradictory behavior)
- Recall turn issues `memo recall -k 6 "<question>"`
- Top recall result reflects the seeded meaning
- Final assistant answer reflects the seeded fact accurately

A scenario **fails** when any are true:

- No relevant recall result
- Recall result is unrelated to seeded fact
- Final response contradicts seeded fact
- Test depends on exact phrase overlap to work

## Scenario Template

Use this format for each scenario write-up:

```markdown
### Scenario: <short name>

- Category: <preference | personal detail | plan | professional | health | relationship | hobby | etc.>
- Seed input: "..."
- Recall question (paraphrased): "..."

Expected:
- Recall output contains: "..."
- Final answer conveys: "..."

Actual (captured from `-v` run):
- Tool recall snippet:
  ```
  [TOOL RESULT] Top 6 results for '...':
    [1] Score: ... | ...
  ```
- Final answer:
  ```
  ...
  ```

Result: PASS | FAIL
```

## Relationship to Few-Shot Examples

After a scenario passes, we may append the **actual** observed input/output pair to:

- `plugins/memory/.agent/templates/memory-answer.yaml`

This keeps the prompt examples grounded in real successful integration runs.

## Notes

- This convention intentionally behaves like prompt-driven acceptance testing.
- It complements code tests by validating real model/tool behavior under production-like prompts.
