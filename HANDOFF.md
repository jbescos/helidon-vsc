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

**Workflow note:**
When creating git commits for this repo, use a signed-off commit via `git commit -s`.

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
- completion for `microprofile-config.properties`
- hover for known properties
- completion for `application.yaml` / `application.yml`
- hover for known YAML keys
- conservative diagnostics for unknown Helidon config keys in supported properties/YAML files

### 3. Metadata work
Implemented and refactored:
- started with mocked metadata
- moved metadata to external files
- then aligned the metadata structure toward the IntelliJ/Helidon-style structured shape
- parser/flattening logic converts structured metadata into flat keys for current VS Code providers
- replaced bundled metadata fallback with runtime metadata loaded from Java classpaths via the `redhat.java` extension API
- reads `META-INF/helidon/config-metadata.json` from resolved directories and JARs
- parser was later fixed against real Helidon 4 metadata:
  - supports inherited config types
  - tolerates options that omit `type`
  - regression test added for real-world metadata shape

Current metadata/runtime files:
- `src/metadata.ts`
- `src/javaMetadata.ts`

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

Note:
- the earlier scaffold/testing command `Helidon: Trigger Config Completion` has been removed
- there is no JetBrains Helidon plugin equivalent for that command, and VS Code already has native suggest triggering

### 6. Portability cleanup
- removed `src/legacyIntegrationNotes.ts`
- ensured local absolute-path notes are not part of runtime extension code

### 7. Java extension integration
Implemented option A from the design discussion:
- uses `Language Support for Java(TM) by Red Hat` (`redhat.java`) as the runtime source of project classpaths
- reads Helidon metadata from dependency JARs and exploded output directories
- shows a warning when Java support is missing or when Helidon metadata is unavailable on the current classpath
- later hardened to support more startup/runtime cases:
  - explicit `redhat.java` extension dependency added in `package.json`
  - VS Code activation fixed for `java-properties` files, not only generic `properties`
  - startup retries metadata loading while Java import/classpath initialization settles
  - Java integration now accepts multiple `redhat.java` API export shapes
  - falls back to `java.execute.workspaceCommand` / `java.project.getClasspaths` when needed

Important nuance:
- this is not a custom Java LS plugin
- it consumes the public `redhat.java` extension API from TypeScript

### 8. File-scope fixes discovered during manual testing
Manual testing found two important cases:
- generated MP projects use `META-INF/microprofile-config.properties`, which is now supported
- generated `app.yaml` files from MP archetypes are Kubernetes manifests, not Helidon config files, so support for `app.yaml` / `app.properties` was intentionally reverted

### 9. Runtime/debuggability fixes from real project testing
Testing against `/home/jbescos/workspace/demo-helidon` surfaced important runtime issues and fixes:
- opening `microprofile-config.properties` originally did not activate the extension because VS Code used `java-properties`; activation now includes `onLanguage:java-properties`
- metadata was sometimes unavailable at first startup because Java classpaths were not ready yet; the extension now retries automatically for a short startup window
- a `Helidon` output channel was added for runtime debugging
- a debug command `Helidon: Reload Extension` was added to force a clean window reload during testing

### 10. First richer inspections pass
Implemented a first non-trivial diagnostics/inspection step:
- properties indexed-key syntax validation
  - missing closing bracket detection
  - missing index value detection
  - non-integer index detection
- properties key normalization now accepts bracket notation such as `logging.loggers[0].name`
- YAML duplicate key detection within the same mapping
- YAML duplicate detection intentionally does not flag the same key name repeated across different list items

Important scope note:
- duplicate-key diagnostics for Java `.properties` files are still not implemented
- this is currently intentional because `.properties` files often allow repeated keys with last-one-wins semantics, so product behavior should be decided before adding that warning

### 11. First quick-fixes/code-actions pass
Implemented a first safe code-action layer on top of the new diagnostics:
- typo correction quick fix for unknown config keys when a strong metadata match exists
  - properties example: `server.prt` -> `server.port`
  - YAML example: `prt:` -> `port:`
- malformed indexed-key fixes for properties
  - insert missing closing bracket
  - replace invalid `[]` / `[abc]` with `[0]`
- duplicate YAML key removal quick fix

Current scope note:
- typo fixes are intentionally conservative and only appear when the match is strong enough
- no quick fix yet for duplicate `.properties` keys because that inspection does not exist
- no quick fix yet for unresolved map/path validation or value/reference validation

### 12. Path-shape validation pass
Implemented a conservative metadata-backed path validation step:
- scalar-property nested path diagnostics
  - example: `server.port.value`
  - reports that `server.port` does not support nested keys
- list-property missing-index diagnostics
  - example: `logging.loggers.name`
  - reports that `logging.loggers` requires an index before nested keys
- YAML equivalents work too
  - nested map content under scalar properties is flagged
  - nested mapping under list-backed properties without a list item/index is flagged

Important scope note:
- this validation relies on metadata `kind` being preserved as `VALUE` / `LIST` / `MAP`
- `MAP` properties are intentionally excluded from the scalar-path warning to avoid false positives
- quick fixes are not implemented yet for these new path-shape diagnostics

### 13. First value-validation pass
Implemented a conservative value-validation step for known scalar properties:
- boolean validation
  - example invalid value: `metrics.enabled=maybe`
- integer/long validation
  - example invalid values: `server.port=eighty`, `server.max-payload-size=12kb`
- works in both properties and YAML files
- quoted YAML scalars such as `"8080"` and `"false"` are accepted for these validations

Important scope note:
- validation is currently limited to `java.lang.Boolean`, `java.lang.Integer`, and `java.lang.Long`
- more complex types such as duration, size, enums, placeholders, or references are still not validated
- there are no quick fixes yet for invalid scalar values

### 14. First endpoint discovery/display/navigation pass
Implemented an initial endpoint feature set in the VS Code extension:
- Explorer view: `Helidon Endpoints`
- source-based discovery of JAX-RS resources in workspace Java files
- class-level and method-level `@Path` path composition
- HTTP method detection for `@GET`, `@POST`, `@PUT`, `@DELETE`, `@PATCH`, `@HEAD`, and `@OPTIONS`
- endpoint grouping by resource class
- click-through navigation from endpoint tree items back to the Java method source
- manual refresh command: `Helidon: Refresh Endpoints`

Important scope note:
- this is currently a conservative source scan, not a Java semantic model
- current coverage is JAX-RS-style resources, which works well for the demo project
- Helidon routing builder APIs, path-variable reference handling, and endpoint inlay hints are still not implemented

### 15. Metadata/model parity pass for nested list/map config shapes
Implemented a deeper metadata flattening/model pass inspired by the IntelliJ builder:
- metadata flattening no longer treats every `LIST` / `MAP` option as a terminal leaf
- synthetic indexed/map-entry keys are emitted for nested config shapes
  - list example shape: `security.providers.0.oidc.client-id`
  - map example shape: `example.labels.*`
- method signatures such as `Map<String, String>` are used when metadata omits explicit `type`
- config lookup now uses a lightweight schema tree rather than only flat-key sets

Important scope note:
- this improves list/map-aware validation and navigation, but it is still a TypeScript-side model, not IntelliJ’s full `MetaConfigKey` tree
- map-entry handling is intentionally conservative; arbitrary nested map-of-POJO/path semantics may still need refinement on real projects

### 16. Config reference/value intelligence pass
Implemented the first meaningful VS Code equivalent of the IntelliJ reference layer:
- support expanded from only `application.properties` / `application.yaml` to environment-specific Helidon config files:
  - `application-*.properties`
  - `application-*.yaml`
  - `application-*.yml`
- placeholder intelligence in config values:
  - completion inside `${...}`
  - hover inside `${...}`
  - diagnostics for invalid Helidon placeholder keys under known Helidon roots
  - go-to-definition from `${some.key}` to matching config entries in workspace Helidon config files
- value validation now skips placeholder-backed scalar values to avoid false positives during unresolved placeholder use

Important scope note:
- placeholder validation is currently key-oriented, not full value-resolution semantics
- system properties/env placeholders/default-value semantics are not deeply validated yet
- duplicate `.properties` key inspection still does not exist

### 17. Java-side Helidon config support pass
Implemented the first Java-aware Helidon support in VS Code:
- Java activation added for the extension
- detection of Helidon `Config.get("...")` string literals
- Java completion for config keys inside `Config.get("...")`
- Java hover for known Helidon config keys used in `Config.get("...")`
- Java diagnostics for invalid Helidon config keys used in `Config.get("...")`
- go-to-definition from Java `Config.get("...")` keys to matching config entries in workspace Helidon config files

Implementation files:
- `src/javaConfig.ts`

Important scope note:
- this is source-pattern-based detection, not semantic Java symbol resolution
- current matching centers on `Config.get("...")` string literals; broader Java-side APIs may still be missing

### 18. Endpoint/routing/run-helper parity pass
Implemented the first substantial parity move beyond JAX-RS-only endpoint support:
- endpoint discovery now also scans common Helidon routing/service patterns:
  - `rules.get(...)`
  - `routing.post(...)`
  - `register("/base", new SomeService())`
- service registrations are combined with discovered service-local routes to form full endpoint paths
- endpoint code lenses were added in Java editors as the VS Code equivalent of IntelliJ’s endpoint inlay affordances
- basic path-variable navigation was added for common request accessor patterns such as `.param("name")`
- a new helper command was added:
  - `Helidon: Generate Run Files`
- run-file generation creates or updates:
  - `.vscode/tasks.json`
  - `.vscode/launch.json`

Important scope note:
- routing discovery is still source-based and conservative
- service registration resolution is strongest when the code uses direct `new SomeService(...)` patterns
- the run/bootstrap helper is the VS Code analogue of the IntelliJ run configuration bootstrap, not a full project wizard replacement

---

## Commits created so far
- `07f23e6` — Add Helidon config completion and hover MVP
- `d5f3b80` — Add Helidon YAML config completion and hover
- `2c1127a` — Align metadata format with Helidon IntelliJ model
- `7dbf5ae` — Add Helidon project generation command
- `73f9180` — Load Helidon metadata from Java classpaths
- `11ae94e` — Fix Helidon extension startup and metadata loading
- `d245d14` — Add Helidon config inspections
- `a7566fa` — Add Helidon config quick fixes
- `661a9ee` — Add Helidon path diagnostics
- `ae7f88e` — Add Helidon value validation

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

### JetBrains Helidon plugin capability summary
This section is intentionally detailed so a future conversation does not need to re-investigate the JetBrains plugin again.

#### Marketplace/descriptor-level feature summary
The JetBrains plugin advertises:
- new project wizard
- coding assistance: completion, inspections, quick fixes
- YAML/Properties config autocompletion
- application endpoints shown in the Endpoints tool window

#### Config-file support in IntelliJ
For properties files, the JetBrains plugin has:
- completion contributors
- documentation provider
- annotator/inspection support
- reference contributors
- spellchecking strategy customization
- rename veto conditions for config keys
- implicit property usage provider

For YAML files, the JetBrains plugin has:
- key completion contributors
- documentation provider
- annotator/inspection support
- reference contributors
- rename veto conditions
- JSON widget suppression
- custom icon provider

#### Inspection/quick-fix behavior in IntelliJ
The plugin goes beyond our current VS Code diagnostics.

Properties-side inspection behavior includes:
- index syntax validation
- missing closing bracket detection
- missing index value detection
- non-integer index detection
- unresolved map/path reference checks where metadata allows it
- value-reference highlighting/validation

YAML-side inspection behavior includes:
- duplicate key detection
- duplicate-key quick fix
- scalar/list value-reference highlighting
- duplicate suppression for parametrized config keys

#### Java-aware Helidon support in IntelliJ
The JetBrains plugin is not limited to config files.
It also contributes Java/UAST-aware features:
- references for Helidon endpoint path literals
- path variable reference handling
- Java-side config key references for `Config.get(...)` string literals
- endpoint/navigation support built on IntelliJ microservices APIs
- inlay hints for URL/path definitions

#### Endpoint support in IntelliJ
The JetBrains plugin integrates with IntelliJ microservices tooling:
- URL resolver factory
- endpoints provider
- endpoint/path reference contributors
- inlay hint contributor for URL paths

This is the basis for the “Endpoints tool window” capability and is one of the biggest parity gaps versus the current VS Code extension.

#### Project creation in IntelliJ
The JetBrains plugin has a richer project creation flow than our current archetype command.
Observed capabilities:
- module/project wizard integration
- Maven and Gradle project types
- Java and Kotlin language choices
- generated starter assets/templates
- generated sample sources/resources
- file templates for:
  - `pom.xml`
  - Gradle build files
  - wrapper properties
  - `microprofile-config.properties`
  - `application.yaml`
  - `logging.properties`
  - sample resource classes

#### Run/debug bootstrap in IntelliJ
The JetBrains plugin creates run configurations for new Helidon MicroProfile projects.
Observed behavior:
- only for newly created projects
- detects MP library presence
- creates application run configuration pointing at the Helidon MP main class

This is the closest JetBrains equivalent to optional future `.vscode/launch.json` / run-helper generation on our side.

#### JetBrains capabilities that are currently missing or only partially matched in VS Code
Current VS Code parity status against the JetBrains plugin:

- matched or partially matched:
  - config completion for properties
  - config completion for YAML
  - hover/documentation
  - conservative unknown-key diagnostics
  - indexed properties-key syntax diagnostics
  - scalar/list path-shape diagnostics
  - basic value-level validation for boolean and integer-like scalar properties
  - placeholder key validation/completion/navigation in config values
  - duplicate YAML key diagnostics
  - basic quick fixes/code actions for typo corrections, indexed-key fixes, and duplicate YAML key removal
  - Java-side config key references/navigation for `Config.get("...")`
  - endpoint discovery/display/navigation for JAX-RS resources
  - broader endpoint discovery for common Helidon routing/service patterns
  - endpoint code-lens-style affordances
  - basic endpoint path-variable navigation
  - project generation command
  - metadata loading from `META-INF/helidon/config-metadata.json`
  - optional run/debug bootstrap helper generation
  - richer nested list/map metadata modeling

- still missing:
  - unresolved map/path validation beyond the current conservative schema handling
  - richer value/reference validation (enums, classes, packages, durations, sizes, etc.)
  - duplicate `.properties` key handling (if desired)
  - richer code actions for the remaining inspections
  - richer project wizard parity
  - deeper run/debug/bootstrap parity

#### Important JetBrains comparison note
The JetBrains plugin does **not** appear to expose any equivalent to the removed VS Code testing command `Helidon: Trigger Config Completion`.
That command was scaffold residue on our side and should stay removed.

---

## What is intentionally NOT the focus right now
Per latest decision with the user:
- keep using the simple `redhat.java` API integration path
- do **not** pivot to a custom Java language-server plugin unless explicitly requested

So for the next conversation, do **not** center the work around a deeper JDT LS plugin integration unless explicitly requested again.

---

## Current feature status

### Implemented
- [x] `application.properties` completion
- [x] `application-*.properties` completion
- [x] `microprofile-config.properties` completion
- [x] `application.properties` hover
- [x] `application-*.properties` hover
- [x] `microprofile-config.properties` hover
- [x] `application.yaml` / `application.yml` completion
- [x] `application-*.yaml` / `application-*.yml` completion
- [x] `application.yaml` / `application.yml` hover
- [x] `application-*.yaml` / `application-*.yml` hover
- [x] conservative diagnostics for unknown Helidon keys in supported properties/YAML files
- [x] indexed properties-key syntax diagnostics (`[]`, missing `]`, non-integer index)
- [x] scalar nested-path diagnostics for unsupported child keys under leaf properties
- [x] list missing-index diagnostics for list-backed properties
- [x] value-level validation for boolean, integer, and long-backed scalar properties
- [x] placeholder diagnostics/completion/hover/navigation in Helidon config values
- [x] duplicate YAML key diagnostics
- [x] typo-correction quick fixes for strong unknown-key matches
- [x] malformed indexed-key quick fixes
- [x] duplicate YAML key removal quick fixes
- [x] endpoint discovery/display/navigation for JAX-RS Java resources
- [x] endpoint discovery/display/navigation for common Helidon routing/service Java patterns
- [x] Explorer tree view for Helidon endpoints
- [x] navigation from endpoint entries to Java source
- [x] endpoint code lenses in Java editors
- [x] basic path-variable navigation for common Helidon request path accessors
- [x] structured metadata parser inspired by IntelliJ plugin
- [x] nested list/map metadata flattening for indexed/map entry shapes
- [x] Java classpath metadata loading via `redhat.java`
- [x] parser compatibility with real Helidon 4 metadata
- [x] startup retry logic while Java import/classpath resolution finishes
- [x] activation for `java-properties` Helidon config files
- [x] activation for Java source files
- [x] Java-side `Config.get("...")` completion / hover / diagnostics / navigation
- [x] runtime debug output channel
- [x] `Helidon: Reload Extension` debug command
- [x] example/demo project
- [x] Helidon project generation command using archetypes
- [x] optional `.vscode/launch.json` / `.vscode/tasks.json` helper generation

### Not implemented yet
- [ ] duplicate `.properties` key diagnostics, if product direction wants them
- [ ] richer code actions for path-shape and value-level diagnostics
- [ ] broader Java-side Helidon config API coverage beyond current `Config.get("...")` support
- [ ] richer value/reference intelligence for config values and placeholders
- [ ] endpoint discovery for additional/non-common Helidon patterns beyond the current conservative routing scan
- [ ] richer path-variable semantics/navigation beyond the current basic accessor matching
- [ ] richer endpoint inlay/code-lens UX if needed
- [ ] richer project wizard parity
- [ ] richer run/debug/bootstrap parity beyond generated VS Code helpers
- [ ] deeper Java LS plugin integration (deferred)

---

## Recommended next tasks
Suggested next priorities for the new conversation:
1. **Remaining richer inspections** for properties and YAML:
   - decide whether duplicate `.properties` keys should warn at all
   - expand value validation only where metadata makes it reliable enough
   - consider duration/size/enum/class/package validation only if false positives can be avoided
   - improve map-entry/path validation on real-world Helidon metadata
2. **Richer code actions** for new inspections where safe:
   - follow-on fixes for scalar/list path-shape issues
   - any safe value-level correction or normalization helpers
   - possible placeholder/config-key navigation helpers where VS Code UX supports them
3. **Endpoint support expansion**:
   - expand routing discovery for less-common Helidon patterns
   - improve path-variable awareness and richer endpoint metadata
   - decide whether current code-lens UX is enough or should be refined further
4. **Java-side Helidon features**:
   - expand beyond current `Config.get("...")` support to other Helidon config access patterns
   - refine navigation between Java usage and config definitions
   - consider diagnostics on invalid Java-side config key literals for broader APIs
5. **Value/reference intelligence**:
   - stronger value completion/validation
   - deeper placeholder/reference validation
   - list/map-aware handling
   - possibly enum/class/package-aware suggestions inspired by IntelliJ hints
6. **Project generation parity**:
   - Gradle support
   - Java/Kotlin selection
   - richer starter/template choices
7. **Run/debug bootstrap**:
   - improve generated `.vscode/launch.json`
   - improve generated `.vscode/tasks.json`
   - detect better default main classes / launch strategies on real projects
   - helper run/debug commands if useful
8. Only later: **same Java language server integration** as a final refactor

If inspections are tackled, be conservative because missing classpath metadata can still create false positives or false negatives during workspace startup.

---

## Manual verification flow
1. Open `/home/jbescos/workspace/helidon-vsc`
2. Press `F5`
3. In Extension Development Host, open `/home/jbescos/workspace/demo-helidon` or `/home/jbescos/workspace/helidon-vsc-example`
4. Test:
   - `application.properties`
   - `application-dev.properties`
   - malformed indexed properties keys such as `logging.loggers[].name=value`
   - scalar nested paths such as `server.port.value=8080`
   - list-backed paths without an index such as `logging.loggers.name=demo`
   - invalid scalar values such as `metrics.enabled=maybe` or `server.port=eighty`
   - placeholder keys such as `server.port=${server.prt}`
   - unknown-key typo quick fix such as `server.prt`
   - `src/main/resources/META-INF/microprofile-config.properties` in generated MP projects
   - `application.yaml`
   - `application-prod.yaml`
   - duplicate YAML keys in the same mapping
   - scalar nested YAML paths such as `server: { port: { value: 8080 } }`
   - list-backed YAML mappings without a list item under `logging.loggers`
   - invalid YAML scalar values such as `metrics.enabled: maybe`
   - YAML placeholder values such as `server: { port: ${server.prt} }`
   - duplicate YAML key quick fix
   - Java `Config.get("server.port")` completion / hover / navigation / invalid-key diagnostics
   - Explorer view → `Helidon Endpoints`
   - click an endpoint entry and confirm it opens the Java method
   - verify routing/service endpoints, not only JAX-RS endpoints
   - verify Java endpoint code lenses appear and open the corresponding method
   - verify common path-parameter usages such as `.param("name")` navigate back to a matching route pattern
   - output panel → `Helidon`
   - command palette → `Helidon: Refresh Endpoints`
   - command palette → `Helidon: Generate Project`
   - command palette → `Helidon: Generate Run Files`
   - command palette → `Helidon: Reload Extension` (debug only)

---

## Current important source files in `helidon-vsc`
- `src/extension.ts`
- `src/helidonConfig.ts`
- `src/javaConfig.ts`
- `src/endpoints.ts`
- `src/javaMetadata.ts`
- `src/metadata.ts`
- `src/generator.ts`
- `src/test/extension.test.ts`
- `src/test/metadata.test.ts`
- `README.md`
- `package.json`

---

## Suggested first action in the next conversation
Read this file first, then continue with one concrete next milestone (probably endpoint expansion, Java-side references, or richer config validation), while keeping Java-language-server integration deferred until later.
