# Helidon VS Code Extension

VS Code extension for Helidon that will grow into framework tooling comparable to Spring, Quarkus, and Micronaut extensions.

## Features

Current MVP feature:

- Helidon configuration completion in `application.properties`
- Hover documentation for known Helidon properties in `application.properties`

When editing an `application.properties` file, typing prefixes like `server.` will offer Helidon configuration keys such as:

- `server.port`
- `server.host`
- `server.features.observe.enabled`
- `logging.level`
- `security.providers.0.oidc.client-id`

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

Use the command palette command **Helidon: Trigger Config Completion** to manually open suggestions while testing.

## Requirements

- Visual Studio Code
- Open a Helidon-style `application.properties` file to test completions

## Extension Settings

No custom settings yet.

## Known Issues

- The current metadata catalog is static and intentionally small.
- The current metadata file is mocked and manually maintained.
- Completion currently targets `application.properties` only.
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
