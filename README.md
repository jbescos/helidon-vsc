# Helidon VS Code Extension

`helidon-vsc` adds Helidon-aware editing, navigation, endpoint discovery, and project lifecycle commands to VS Code.

## Current Scope

This extension currently covers:

- Helidon configuration support in `.properties` and YAML files
- Java support for Helidon `Config.get("...")` keys
- Helidon endpoint discovery, with JAX-RS source parsing and Java-semantic routing support when available
- Project generation, run, debug, and stop actions

## Requirements

- Visual Studio Code `1.110.0` or newer
- `Language Support for Java(TM) by Red Hat` (`redhat.java`)
- `Tools for MicroProfile` (`redhat.vscode-microprofile`) is installed alongside this extension through the extension pack manifest so VS Code can reuse LSP4MP where it applies
- `Extension Pack for Java` is recommended if you want run/debug support
- Open the Helidon project as a VS Code workspace folder so the Java extension can resolve classpaths
- Optional: `helidon` on `PATH` for the Helidon CLI wizard
- Optional: Maven or Gradle installed for project generation and run/debug

## Java Language Server Integration

The requirement to use the same language server as the official Java extension is satisfied by integrating with `Language Support for Java(TM) by Red Hat` (`redhat.java`).

That extension already owns the Java language-server integration in VS Code and is the supported entry point for JDT LS features such as classpath resolution, Java project import, launch/debug configuration resolution, and workspace commands.

Because of that, `helidon-vsc` does not bundle or launch a separate `java-language-server`. Doing so would duplicate the Java workspace model, risk conflicting project state, and move the extension away from the Java stack that VS Code users already rely on.

In practice, `helidon-vsc` reuses the Java tooling that `redhat.java` exposes:

- Java classpath and metadata loading comes from the Red Hat Java extension API
- Java workspace commands are executed through the Red Hat Java extension and wait for its language server when an API instance is available
- Helidon endpoint discovery contributes a small JDT LS bundle through `contributes.javaExtensions`, so `io.helidon.vscode.resolveEndpoints` runs inside the same Java workspace model that the official Java extension already owns
- the contributed JDT bundle is packaged as an OSGi singleton and rebuilt with a content-derived bundle version so JDT LS can replace stale copies when the Helidon integration changes
- if endpoint discovery hits a missing `io.helidon.vscode.resolveEndpoints` delegate handler, `helidon-vsc` asks the Red Hat Java extension to reload the contributed bundles once and retries semantic discovery before falling back
- Java run/debug uses the same Java debugger launch flow as the VS Code Java tooling
- MicroProfile support is delegated to `redhat.vscode-microprofile` where that stack is already deeper than Helidon-specific custom features

## Features

### 1. Helidon `.properties` support

When `Tools for MicroProfile` is present, `helidon-vsc` intentionally backs off exact `application.properties` and exact `microprofile-config.properties` so those files can be served by the deeper MicroProfile language support. `helidon-vsc` keeps support for Helidon-specific `microprofile-config-<profile>.properties` files either way.

Works in:

- exact `application.properties`
- exact `microprofile-config.properties`
- `microprofile-config-<profile>.properties`, for example `microprofile-config-dev.properties`
- untitled editors with matching names such as `untitled:/application.properties`, `untitled:/microprofile-config.properties`, and `untitled:/microprofile-config-dev.properties`

Not recognized:

- `application-dev.properties`
- `applicationdev.properties`
- `application.properties.bak`

What you get:

- completion for Helidon config keys
- hover documentation from Helidon metadata
- diagnostics for unknown keys, malformed indexes, invalid nesting, invalid boolean/integer/long values, placeholder typos, and duplicate Helidon keys
- quick fixes for typos, missing list indexes, malformed index syntax, safe path rewrites, and default-backed value replacements
- go-to-definition from `${...}` placeholders to matching config keys in the workspace

Example:

```properties
# typing `server.` offers Helidon keys such as `server.port`
server.

# unknown key typo
server.prt=8080

# malformed and missing list indexes
logging.loggers[].name=demo
logging.loggers.name=demo

# invalid nesting under a scalar property
server.port.value=8080

# invalid value with a metadata-backed default
metrics.enabled=maybe

# placeholder validation and navigation
server.port=${server.prt}

# custom roots are left alone
custom.value=test

# duplicate Helidon key detection
server.port=8080
server.port=8081
```

Expected behavior:

- `server.` suggests keys such as `server.port`
- `server.prt` gets a warning and offers `Change to 'server.port'`
- `logging.loggers[].name` offers `Replace with '[0]'`
- `logging.loggers.name` offers `Change to 'logging.loggers[0].name'`
- `server.port.value` warns that `server.port` does not support nested keys
- `metrics.enabled=maybe` offers `Replace with default 'false'`
- `${server.prt}` is validated like any other Helidon key
- `custom.value` is ignored because `custom` is not a known Helidon config root
- duplicate Helidon keys are flagged in supported properties files

### 2. Helidon YAML support

Works in:

- exact `application.yaml`
- `application-<profile>.yaml`, for example `application-prod.yaml`
- untitled editors with matching names such as `untitled:/application.yaml`

Not recognized:

- `microprofile-config.yaml`
- `microprofile-config.yml`
- `application.yml`
- `application-dev.yml`
- `values.yaml`
- `applicationdev.yaml`

What you get:

- YAML key completion using Helidon metadata
- hover documentation on resolved keys
- diagnostics for unknown keys, invalid nesting, missing list indexes, invalid scalar values, placeholder typos, and duplicate YAML keys
- quick fixes for key typos, placeholder typos, and duplicate key removal

Example:

```yaml
# typing under `server:` offers keys such as `port`
server:
  prt: 8080
  port: ${server.prt}

logging:
  loggers:
    name: demo

metrics:
  enabled: maybe

custom:
  value: test
```

Another duplicate-key example:

```yaml
server:
  port: 8080
  port: 8081
```

Expected behavior:

- under `server:`, the extension suggests keys such as `port`
- `prt` gets a warning and offers `Change to 'port'`
- `${server.prt}` keeps the full key in the quick fix and offers `Change to 'server.port'`
- `logging.loggers` without a list item/index is flagged
- `metrics.enabled: maybe` is flagged as an invalid boolean value
- `custom.value` is ignored because `custom` is not a known Helidon config root
- duplicate YAML keys get a warning and offer `Remove duplicate YAML key`

### 3. Java support for `Config.get("...")`

Java matching is conservative and focuses on direct string literals passed to `Config.get(...)` on receivers that resolve to Helidon `Config` variables, fields, or static chains such as `Config.global().get(...)`.

What you get:

- completion inside string literals passed to `Config.get(...)`
- hover documentation for known Helidon keys
- diagnostics and typo quick fixes for unknown Helidon keys under known Helidon roots
- go-to-definition from `Config.get("...")` to matching keys in supported config files

Example:

`application.yaml`

```yaml
server:
  port: 8080
```

`Demo.java`

```java
import io.helidon.config.Config;

class Demo {
    void load(Config config) {
        int port = config.get("server.port").asInt();
        int broken = config.get("server.prt").asInt();
    }
}
```

Expected behavior:

- typing `config.get("server.")` offers keys such as `server.port`
- hovering `server.port` shows Helidon docs, type, and default value when available
- go-to-definition on `server.port` opens the matching YAML or properties entry
- `server.prt` gets a warning and offers `Change to 'server.port'`

### 4. Endpoint discovery in the Explorer

The extension contributes a `Helidon` view in the Explorer and groups discovered endpoints by Java class.

Supported endpoint sources:

- JAX-RS resources using `@Path` and HTTP method annotations
- Java-semantic endpoint discovery from the shared Red Hat Java toolchain, including a bundled JDT command handler for Helidon SE routing and service registrations

Example: JAX-RS resource

```java
import jakarta.ws.rs.GET;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;

@Path("/greet")
public class GreetResource {
    @GET
    public Message getDefaultMessage() {
        return null;
    }

    @Path("/{name}")
    @GET
    public Message getMessage(String name) {
        return null;
    }

    @Path("/greeting")
    @PUT
    public Response updateGreeting(Message message) {
        return null;
    }
}
```

The `Helidon` view shows entries like:

```text
GreetResource
  GET /greet
  GET /greet/{name}
  PUT /greet/greeting
```

Example: Helidon Routing service resolved through Java semantic discovery

```java
public class GreetService {
    void update(Routing.Rules rules) {
        rules.get("/", this::getDefaultMessageHandler)
             .get("/{name}", this::getMessageHandler)
             .put("/greeting", this::updateGreetingHandler);
    }

    void getDefaultMessageHandler(ServerRequest req, ServerResponse res) {
    }

    void getMessageHandler(ServerRequest req, ServerResponse res) {
    }

    void updateGreetingHandler(ServerRequest req, ServerResponse res) {
    }
}
```

Expected behavior:

- discovered endpoints appear in the `Helidon` Explorer view
- clicking an endpoint opens the matching Java source location
- Java code lenses such as `GET /{name}` appear above discovered handlers
- the view refreshes automatically on Java edits and workspace file changes
- Helidon SE routing and `HttpService` registrations are resolved from the shared JDT workspace model rather than from a regex-only source pass
- if the contributed JDT handler is temporarily unavailable, endpoint discovery asks the Java extension to reload the Helidon bundle once and retries before using the JAX-RS-only fallback

### 5. Path-parameter go-to-definition

Common path-parameter lookups in Java can jump back to route definitions in the same file.

Example:

```java
rules.get("/{name}", this::getMessageHandler);

void getMessageHandler(ServerRequest req, ServerResponse res) {
    String name = req.path().param("name");
}
```

Expected behavior:

- using Go to Definition on `"name"` in `param("name")` can navigate back to the route that contains `{name}`

### 6. Project generation

Command:

- `Helidon: Generate Project`

What it supports:

- `Helidon CLI Wizard` when `helidon` is available on `PATH`
- `Maven Archetype Generator` as a built-in fallback
- the CLI option stays visible but disabled when the CLI is missing
- the `Helidon` Explorer view toolbar exposes the same command as a Create Project button

Example: Helidon CLI wizard

1. Run `Helidon: Generate Project`
2. Choose `Helidon CLI Wizard`
3. Select a target directory
4. The extension opens an integrated terminal and runs:

```bash
helidon init
```

Example: Maven fallback

```text
groupId: com.example
artifactId: demo-helidon
package: com.example.demohelidon
archetype: helidon-quickstart-se
version: 4.4.0
```

The extension runs Maven archetype generation and opens the generated project folder in VS Code.

Built-in fallback archetypes:

- `helidon-quickstart-se`
- `helidon-quickstart-mp`
- `helidon-bare-se`
- `helidon-bare-mp`
- `helidon-database-se`
- `helidon-database-mp`

### 7. Run, debug, and stop commands

Commands:

- `Helidon: Run Project`
- `Helidon: Debug Project`
- `Helidon: Stop Project`

What it does:

- detects Maven or Gradle projects in the selected workspace folder
- resolves a Java main class and falls back to `io.helidon.Main` for likely Helidon MicroProfile projects
- creates or updates `.vscode/tasks.json` with `helidon: build` and `helidon: run`
- creates or updates `.vscode/launch.json` with `Launch Helidon Application`
- exposes Run and Debug in the status bar when a workspace is open, and Stop while a Helidon session or task is active
- adds Run, Debug, and Stop to Explorer folder context menus and the `Helidon` view toolbar

Example generated files for a Maven project:

`.vscode/tasks.json`

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "helidon: build",
      "type": "shell",
      "command": "mvn",
      "args": ["package"]
    },
    {
      "label": "helidon: run",
      "type": "shell",
      "command": "mvn",
      "args": [
        "compile",
        "org.codehaus.mojo:exec-maven-plugin:3.6.2:java",
        "-Dexec.mainClass=com.example.Main"
      ]
    }
  ]
}
```

`.vscode/launch.json`

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "java",
      "name": "Launch Helidon Application",
      "request": "launch",
      "mainClass": "com.example.Main",
      "cwd": "${workspaceFolder}",
      "console": "integratedTerminal",
      "preLaunchTask": "helidon: build"
    }
  ]
}
```

Gradle projects use `./gradlew build` and `./gradlew run` instead.

Example stop flow:

1. Start `Helidon: Run Project` or `Helidon: Debug Project`
2. Use `Helidon: Stop Project` from the Command Palette, Explorer context menu, or status bar
3. The extension stops matching Helidon Java debug sessions first and falls back to terminating Helidon tasks when needed

## Metadata Source

Helidon config keys and documentation are loaded from `META-INF/helidon/config-metadata.json` on the Java runtime classpath using the Red Hat Java extension API.

Example:

- if the workspace resolves Helidon dependencies that expose `server.port` and `metrics.enabled`, those keys become available for completion, hover, diagnostics, and quick fixes after Java classpath initialization finishes

There is no bundled fallback metadata catalog in this repo. If the Java workspace is not ready, Helidon config assistance can stay unavailable until classpath resolution completes.

## Extension Settings

There are no custom extension settings yet.

## Development

Install dependencies and build:

```bash
npm install
npm run compile
```

`npm run compile` rebuilds the contributed JDT bundle first. The generated jar is stamped with a content-based OSGi bundle version so local changes are picked up by JDT LS reloads.

Run the test suite:

```bash
npm test
```

Open the repo in VS Code and press `F5` to start an Extension Development Host.

## Known Limitations

- config filename matching is exact and conservative: supported names are exact `application.properties`, exact `microprofile-config.properties`, `microprofile-config-<profile>.properties`, exact `application.yaml`, and `application-<profile>.yaml`; files such as `application-dev.properties`, `application.yml`, `microprofile-config.yaml`, and `values.yaml` are not recognized
- when `Tools for MicroProfile` is installed, `helidon-vsc` intentionally defers exact `application.properties` and exact `microprofile-config.properties` to that extension to avoid overlapping completion/hover/diagnostic providers; `helidon-vsc` still owns `microprofile-config-<profile>.properties`, YAML, Java `Config.get("...")`, and endpoint features
- Java `Config.get("...")` support uses Java AST matching rather than a broad text regex now, but it still does not use full JDT symbol resolution and remains limited to direct string literals
- endpoint discovery prefers the shared Java language-server flow; if the Helidon JDT delegate handler is missing it attempts one contributed-bundle reload and retry, but the built-in source fallback remains limited to JAX-RS annotations and does not infer Helidon SE routing chains
- duplicate `.properties` keys are diagnosed, but there is no quick fix to remove them yet
- YAML quick fixes are conservative and do not attempt structural rewrites for nested/list path issues
- the Helidon CLI wizard currently runs in an integrated terminal and does not auto-open the generated project folder after `helidon init`
- run/debug main-class resolution is conservative; if no main class can be resolved and the project does not look like a Helidon MicroProfile project, the command will not start
