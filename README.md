# Helidon VS Code Extension

VS Code extension for Helidon that will grow into framework tooling comparable to Spring, Quarkus, and Micronaut extensions.

## Features

Current MVP feature:

- Helidon configuration completion in `application.properties`
- Helidon configuration completion in `application.yaml` / `application.yml`
- Hover documentation for known Helidon properties in `application.properties`
- Hover documentation for known Helidon properties in `application.yaml` / `application.yml`
- Helidon project generation command using Helidon Maven archetypes

When editing an `application.properties` file, typing prefixes like `server.` will offer Helidon configuration keys such as:

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

## Metadata source

The current prototype no longer keeps Helidon metadata inline in TypeScript.
Instead, the extension reads it from:

- `src/metadata/helidon-config-metadata.json`

This is still mocked metadata for now, but it is structured so we can later replace it with generated Helidon metadata or metadata extracted from future Helidon artifacts.

The file now follows a more IntelliJ/Helidon-like structured shape based on modules, config types, and options, and the extension flattens that into keys for completion and hover.

Use the command palette command **Helidon: Trigger Config Completion** to manually open suggestions while testing.

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
- Open a Helidon-style `application.properties` file to test completions

## Extension Settings

No custom settings yet.

## Known Issues

- The current metadata catalog is static and intentionally small.
- The current metadata file is mocked and manually maintained.
- Completion currently targets `application.properties` only.
- Completion now also targets `application.yaml` and `application.yml`.
- Hover currently targets known static Helidon keys only.
- Hover, validation, YAML support, and Java language-server integration are planned next.

## Release Notes

### 0.0.1

- Initial project scaffold
- Added Helidon `application.properties` completion MVP

---

## For more information

* [VS Code Extension API](https://code.visualstudio.com/api)
* [VS Code Language Features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
