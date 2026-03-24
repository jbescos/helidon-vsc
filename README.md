# Helidon VS Code Extension

VS Code extension for Helidon that will grow into framework tooling comparable to Spring, Quarkus, and Micronaut extensions.

## Features

Current MVP feature:

- Helidon configuration completion in `application.properties`

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

Use the command palette command **Helidon: Trigger Config Completion** to manually open suggestions while testing.

## Requirements

- Visual Studio Code
- Open a Helidon-style `application.properties` file to test completions

## Extension Settings

No custom settings yet.

## Known Issues

- The current metadata catalog is static and intentionally small.
- Completion currently targets `application.properties` only.
- Hover, validation, YAML support, and Java language-server integration are planned next.

## Release Notes

### 0.0.1

- Initial project scaffold
- Added Helidon `application.properties` completion MVP

---

## For more information

* [VS Code Extension API](https://code.visualstudio.com/api)
* [VS Code Language Features](https://code.visualstudio.com/api/language-extensions/programmatic-language-features)
