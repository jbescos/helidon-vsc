# Helidon VS Code Extension Handoff

## Hackathon context

### Helidon AI Hackathon

#### Overview
The Helidon team is organizing a three-day hackathon focused on using AI to solve large, meaningful tasks under tight time constraints.
The goal is not only to make strong progress on the assigned task, but also to demonstrate how AI was used throughout the process: planning, implementation, problem-solving, and iteration.

#### Schedule
- Start: Monday, March 23, 2026, 18:00 CET / 10:00 AM PST
- End: Thursday, March 26, 2026, 18:00 CET / 10:00 AM PST
- Tasks were revealed during the kickoff meeting on Monday, March 23
- A results meeting will take place on Thursday, March 26

#### Participation
Participation is mandatory for all Helidon team developers.
Participants are expected to work full time on the hackathon task.

#### AI usage rules
AI is expected to be used for:
- design and solution exploration
- implementation planning
- execution
- troubleshooting
- iteration and refinement

#### Communication / sharing results
All hackathon communication happens in `#helidon-ai-hackathon`.
Final results should be shared there with:
- summary of outcome
- explanation of AI usage
- links to source code/materials
- design plan
- implementation/execution plan
- what worked well
- challenges and lessons learned

#### Presentations
Each participant presents for 10–15 minutes and should explain:
- what they built
- approach
- AI contribution
- challenges
- lessons learned

#### What success looks like
Strong submissions show:
- meaningful progress
- effective use of AI
- clear thinking
- honest reflection
- well-structured final presentation

---

## Original assignment
Design and implement a VS Code extension for Helidon that supports configuration completion and other features commonly found in VS Code extensions for frameworks such as Spring, Quarkus, and Micronaut.

Original statement also said:
- use the same language server as the official Java extension for VS Code
- prepare a demo of the main capabilities

**Important note for the next conversation:**
Per latest user instruction, **ignore the Java-language-server integration for now** and treat it as a **last refactoring step**, not the current focus.

---

## Current repository
Main repo under development:
- `/home/jbescos/workspace/helidon-vsc`

Example/demo project:
- `/home/jbescos/workspace/helidon-vsc-example`

Related repos examined:
- `/home/jbescos/workspace/helidon`
- `/home/jbescos/workspace/helidon-build-tools`
- `/home/jbescos/workspace/helidon-extensions`
- `/home/jbescos/workspace/intellij-obsolete-plugins/helidon`

---

## What has been completed so far

### 1. Research / comparison work
We explored comparable tooling and references:
- Quarkus / MicroProfile feature baseline
- Spring / Micronaut at a high level
- JetBrains Helidon plugin docs and sources
- legacy Helidon IDE support in `helidon-build-tools`

### 2. Config support MVP in VS Code extension
Implemented in `helidon-vsc`:
- completion for `application.properties`
- hover for known properties
- completion for `application.yaml` / `application.yml`
- hover for known YAML keys

### 3. Metadata work
Implemented and refactored:
- started with mocked metadata
- moved metadata to external files
- then aligned the metadata structure toward the IntelliJ/Helidon-style structured shape
- parser/flattening logic converts structured metadata into flat keys for current VS Code providers

Current metadata files:
- `src/metadata/helidon-config-metadata.json`
- `src/metadata.ts`

### 4. Example/demo project
Created a dummy project for manual testing:
- `/home/jbescos/workspace/helidon-vsc-example`

It contains:
- `pom.xml`
- `src/main/resources/application.properties`
- `src/main/resources/application.yaml`
- `src/main/java/io/helidon/examples/demo/Main.java`
- `README.md`

### 5. Project generation command
Implemented a first project generation feature using Helidon archetypes.

Command:
- `Helidon: Generate Project`

Current behavior:
- prompts for target folder
- prompts for groupId
- prompts for artifactId
- prompts for base package
- prompts for archetype
- prompts for version
- invokes Maven archetype generation
- opens generated project after success

Supported archetypes currently:
- `helidon-quickstart-se`
- `helidon-quickstart-mp`
- `helidon-bare-se`

### 6. Portability cleanup
- removed `src/legacyIntegrationNotes.ts`
- ensured local absolute-path notes are not part of runtime extension code

---

## Commits created so far
- `07f23e6` — Add Helidon config completion and hover MVP
- `d5f3b80` — Add Helidon YAML config completion and hover
- `2c1127a` — Align metadata format with Helidon IntelliJ model
- `7dbf5ae` — Add Helidon project generation command

---

## Important findings from IntelliJ plugin sources
JetBrains plugin sources were found in:
- `/home/jbescos/workspace/intellij-obsolete-plugins/helidon`

Key findings:
- IntelliJ plugin supports:
  - new project wizard
  - properties completion/docs/inspection
  - YAML completion/docs/inspection
  - endpoints integration
- It uses a structured metadata pipeline based on:
  - `HelidonConfigMetadataParser.kt`
  - `HelidonConfigMetadataBuilder.kt`
  - `HelidonMetaConfigKeyManager.kt`
- It discovers Helidon `config-metadata.json` files in `META-INF` and builds IDE keys from them

This influenced the current metadata refactor in our VS Code extension.

---

## What is intentionally NOT the focus right now
Per latest decision with the user:
- **Do not focus now on integrating with the same language server as `redhat.java`**
- treat that as a future/last refactoring step

So for the next conversation, do **not** center the work around JDT LS integration unless explicitly requested again.

---

## Current feature status

### Implemented
- [x] `application.properties` completion
- [x] `application.properties` hover
- [x] `application.yaml` / `application.yml` completion
- [x] `application.yaml` / `application.yml` hover
- [x] external metadata file
- [x] structured metadata model inspired by IntelliJ plugin
- [x] example/demo project
- [x] Helidon project generation command using archetypes

### Not implemented yet
- [ ] diagnostics / inspections / quick fixes in VS Code
- [ ] endpoint discovery / display
- [ ] richer Java-side Helidon features
- [ ] optional `.vscode/` helper generation command
- [ ] final refactoring toward same Java LS as `redhat.java` (deferred)

---

## Recommended next tasks
Suggested next priorities for the new conversation:
1. **Diagnostics / inspections** for properties and YAML (carefully, to avoid false positives)
2. **Quick fixes** where safe
3. **Endpoint discovery / demo** support
4. Optional **“.vscode helper files”** command if desired
5. Only later: **same Java language server integration** as a final refactor

If diagnostics are tackled, be conservative because stale metadata can create false positives.

---

## Manual verification flow
1. Open `/home/jbescos/workspace/helidon-vsc`
2. Press `F5`
3. In Extension Development Host, open `/home/jbescos/workspace/helidon-vsc-example`
4. Test:
   - `application.properties`
   - `application.yaml`
   - command palette → `Helidon: Generate Project`

---

## Current important source files in `helidon-vsc`
- `src/extension.ts`
- `src/helidonConfig.ts`
- `src/metadata.ts`
- `src/metadata/helidon-config-metadata.json`
- `src/generator.ts`
- `src/test/extension.test.ts`
- `README.md`
- `package.json`

---

## Suggested first action in the next conversation
Read this file first, then continue with one concrete next milestone (probably diagnostics/inspections or endpoint support), while keeping Java-language-server integration deferred until later.
