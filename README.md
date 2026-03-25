# Helidon VS Code Extension

VS Code extension for Helidon that will grow into framework tooling comparable to Spring, Quarkus, and Micronaut extensions.

## Features

Current MVP feature:

- Helidon configuration completion in `application.properties` / `microprofile-config.properties`
- Helidon configuration completion in `application.yaml` / `application.yml`
- Hover documentation for known Helidon properties in `application.properties` / `microprofile-config.properties`
- Hover documentation for known Helidon properties in `application.yaml` / `application.yml`
- Conservative diagnostics for unknown Helidon configuration keys in `application.properties` / `microprofile-config.properties`
- Conservative diagnostics for unknown Helidon configuration keys in `application.yaml` / `application.yml`
- Helidon project generation command using Helidon Maven archetypes

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

Diagnostics currently warn only for unknown keys under known Helidon config roots such as `server`, `logging`, or `security`, which keeps custom application properties out of the warning stream.

## Metadata source

The extension reads Helidon metadata from the Java classpath using the `Language Support for Java(TM) by Red Hat` extension API.
It resolves the runtime classpath for the current workspace and reads `META-INF/helidon/config-metadata.json` from directories and dependency JARs.

There is no bundled fallback metadata catalog anymore. If the Java extension is missing, or the Java workspace has not finished loading, Helidon completion and hover will stay unavailable and the extension will show a warning.

## Project generation

The extension now includes **Helidon: Generate Project**.

Current MVP behavior:

- prompts for target folder
- prompts for `groupId`, `artifactId`, package, archetype, and version
- runs Maven archetype generation with Helidon archetypes from Maven Central
- opens the generated project in VS Code

Supported archetype choices right now:

- `helidon-quickstart-se`
- `helidon-quickstart-mp`
- `helidon-bare-se`

## Requirements

- Visual Studio Code
- Extension Pack for Java
- Open the Helidon project as a Java workspace in VS Code

## Extension Settings

No custom settings yet.

## Known Issues

- Completion and hover support are currently scoped to Helidon-style `application.properties`, `microprofile-config.properties`, `application.yaml`, and `application.yml` files.
- Completion, hover, and diagnostics depend on Java classpath metadata being available from `redhat.java`.
- If the Java workspace is still loading, Helidon metadata may appear a moment later after classpath resolution finishes.

## Release Notes

### 0.0.1

- Initial project scaffold
- Added Helidon `application.properties` completion MVP

---

## For more information

* [VS Code Extension API](https://code.visualstudio.com/api)
* [VS Code Language Features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
