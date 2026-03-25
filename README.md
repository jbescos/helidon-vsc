# Helidon VS Code Extension

VS Code extension for Helidon that will grow into framework tooling comparable to Spring, Quarkus, and Micronaut extensions.

## Features

Current feature set:

- Helidon configuration completion in `application.properties`, `application-*.properties`, and `microprofile-config.properties`
- Helidon configuration completion in `application.yaml`, `application.yml`, and `application-*.ya?ml`
- Hover documentation for known Helidon properties in Helidon properties/YAML config files
- Conservative diagnostics for unknown Helidon configuration keys in Helidon properties/YAML config files
- Indexed-key syntax diagnostics in `application.properties` / `microprofile-config.properties`
- Nested-path diagnostics for scalar Helidon properties
- Missing-list-index diagnostics for list-backed Helidon properties
- Value-level diagnostics for boolean and integer-like Helidon properties
- Placeholder key diagnostics, completion, hover, and go-to-definition for `${...}` references in Helidon config values
- Duplicate YAML key diagnostics in `application.yaml` / `application.yml`
- Quick fixes for unknown-key typos when a strong Helidon metadata match exists
- Quick fixes for malformed indexed properties keys
- Quick fixes to remove duplicate YAML keys
- Java completion, hover, diagnostics, and go-to-definition for Helidon `Config.get("...")` keys
- Explorer view for Helidon endpoints discovered from JAX-RS resources and Helidon routing/service patterns
- Java code lenses for discovered endpoints
- Path-parameter go-to-definition for common Helidon request path accessor usages
- Click-through navigation from endpoint entries back to Java source methods
- Helidon project generation via the Helidon CLI wizard when `helidon` is installed
- Built-in Helidon Maven archetype project generation fallback
- `Helidon: Generate Run Files` to create `.vscode/launch.json` and `.vscode/tasks.json` entries for an opened Helidon project

When editing an `application.properties` or `microprofile-config.properties` file, typing prefixes like `server.` will offer Helidon configuration keys such as:

- `server.port`
- `server.host`
- `server.features.observe.enabled`
- `logging.level`
- `security.providers.0.oidc.client-id`

When editing `application.yaml`, the extension offers YAML key suggestions using the same metadata. For example:

```yaml
server:
  features:
    observe:
      
```

and hover works on resolved YAML keys such as `port`, `host`, `enabled`, or `path` when they map to known Helidon configuration entries.

Completion items include:

- property name
- property type
- default value when known
- short documentation and example value

Hover support includes:

- property description
- property type
- default value when known
- example value

Diagnostics currently cover:

- unknown keys under known Helidon config roots such as `server`, `logging`, or `security`, which keeps custom application properties out of the warning stream
- malformed indexed properties keys such as missing `]`, empty `[]`, or non-integer indexes
- nested keys under scalar Helidon properties such as `server.port.value`
- missing indexes before nested list-backed keys such as `logging.loggers.name`
- invalid values for known boolean, integer, and long-backed properties such as `metrics.enabled=maybe` or `server.port=eighty`
- invalid placeholder keys under known Helidon config roots such as `${server.prt}`
- duplicate YAML keys within the same mapping

Quick fixes currently cover:

- typo correction for unknown keys when the metadata match is strong enough
- malformed indexed properties keys by inserting `]` or replacing invalid brackets with `[0]`
- duplicate YAML key removal

Diagnostics currently do not warn for duplicate keys in Java `.properties` files. Those files commonly use last-one-wins semantics, so duplicate-key inspection there is still undecided.

## Endpoint discovery

The extension now contributes a **Helidon Endpoints** view in the Explorer.

Current endpoint support:

- scans workspace Java files for JAX-RS resources using class-level and method-level `@Path`
- scans Helidon routing builder and service-style route declarations such as `rules.get(...)`, `routing.post(...)`, and `routing.register("/base", new Service())`
- detects HTTP methods from `@GET`, `@POST`, `@PUT`, `@DELETE`, `@PATCH`, `@HEAD`, `@OPTIONS`, and Helidon routing methods including `TRACE`
- groups endpoints by resource/service class
- opens the corresponding Java method when you click an endpoint entry
- adds Java code lenses such as `GET /greet/{name}` above discovered handlers
- lets common path-parameter usages jump back to candidate route declarations in the same file

Current limitations:

- endpoint discovery uses the bundled `java-parser` CST library rather than a semantic Java model
- endpoint discovery no longer relies on hand-written regex parsing, but it is still not backed by a full Java symbol/AST API from `redhat.java`
- service registration resolution is conservative and currently strongest when services are registered via `new ServiceType(...)`
- endpoint inlay hints are represented as VS Code code lenses rather than IntelliJ-style inline hints

## Metadata source

The extension reads Helidon metadata from the Java classpath using the `Language Support for Java(TM) by Red Hat` extension API.
It resolves the runtime classpath for the current workspace and reads `META-INF/helidon/config-metadata.json` from directories and dependency JARs.

There is no bundled fallback metadata catalog anymore. If the Java extension is missing, or the Java workspace has not finished loading, Helidon completion and hover will stay unavailable and the extension will show a warning.

## Project generation

The extension now includes **Helidon: Generate Project**.

Current behavior:

- the command always shows both project-generation paths:
  - **Helidon CLI Wizard** for richer archetype and feature selection using `helidon init`
  - **Maven Archetype Generator** as a built-in fallback
- if `helidon` is not available on `PATH`, the picker keeps the Helidon CLI option visible but disabled and explains that the CLI was not found on `PATH`

The extension also includes **Helidon: Generate Project with CLI Wizard**.

Current CLI wizard behavior:

- prompts for the target folder where the wizard should run
- opens an integrated terminal in that folder
- runs `helidon init`
- lets the Helidon CLI drive richer selection such as QuickStart / Database / Custom archetypes and the associated feature prompts
- uses an existing external `helidon` binary on `PATH`; the extension does not bundle or install the CLI itself

Current built-in Maven fallback behavior:

- prompts for target folder
- prompts for `groupId`, `artifactId`, package, legacy archetype, and version
- runs Maven archetype generation with Helidon archetypes from Maven Central
- opens the generated project in VS Code

Supported built-in fallback archetype choices right now:

- `helidon-quickstart-se`
- `helidon-quickstart-mp`
- `helidon-bare-se`
- `helidon-bare-mp`
- `helidon-database-se`
- `helidon-database-mp`

The extension also includes **Helidon: Generate Run Files**.

Current behavior:

- detects Maven or Gradle projects in the selected workspace folder
- creates or updates `.vscode/tasks.json` with `helidon: build` and `helidon: run`
- creates or updates `.vscode/launch.json` with a Java launch configuration
- reuses existing `.vscode` files instead of replacing unrelated entries

## Requirements

Runtime requirements:

- Visual Studio Code 1.110 or newer
- `Language Support for Java(TM) by Red Hat` (`redhat.java`)
- Open the Helidon project as a Java workspace in VS Code and let the Java extension finish project/classpath initialization

Notes:

- Installing `Extension Pack for Java` is also fine; it includes `redhat.java`
- This extension declares `redhat.java` as an extension dependency because Helidon metadata loading relies on its Java project/classpath API
- No separate `java-parser` installation is required by users; `java-parser` is bundled as an internal dependency used for endpoint and path-parameter parsing
- The richer Helidon project-generation wizard requires the `helidon` CLI to be installed separately and available on `PATH`

## Extension Settings

No custom settings yet.

## Known Issues

- Completion and hover support are currently scoped to Helidon-style `application*.properties`, `microprofile-config.properties`, `application*.yaml`, and `application*.yml` files.
- Completion, hover, and diagnostics depend on Java classpath metadata being available from `redhat.java`.
- If the Java workspace is still loading, Helidon metadata may appear a moment later after classpath resolution finishes.
- Diagnostics are intentionally conservative and do not yet include duplicate-key warnings for `.properties` files.
- Value validation is intentionally conservative and currently only covers scalar boolean, integer, and long-backed Helidon properties.
- The CLI-based project-generation wizard currently runs in an integrated terminal and does not yet auto-open the generated project folder after the wizard completes.
- Post-generation “add Helidon feature/dependency to an existing project” support is not implemented yet.
- Quick fixes are currently limited to typo corrections, malformed indexed keys, and duplicate YAML key removal.
- The new scalar/list path diagnostics do not yet have dedicated quick fixes.
- Java `Config.get(...)` detection is source-pattern-based and intentionally conservative rather than full Java semantic analysis.

## Release Notes

### 0.0.1

- Initial project scaffold
- Added Helidon `application.properties` completion MVP

---

## For more information

* [VS Code Extension API](https://code.visualstudio.com/api)
* [VS Code Language Features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
