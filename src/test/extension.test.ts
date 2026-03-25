import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip = require('jszip');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { parseJavaHelidonRoutingEndpoints, parseJavaJaxRsEndpoints } from '../endpoints';
import {
	buildHelidonPropertiesDocumentSelectors,
	isMicroProfileManagedHelidonPropertiesFile,
	shouldUseCustomHelidonPropertiesFeatures,
} from '../extension';
import {
	collectHelidonPropertiesDiagnostics,
	collectHelidonYamlDiagnostics,
	HelidonConfigCodeActionProvider,
	findHelidonConfigProperty,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
	replaceHelidonConfigProperties,
} from '../helidonConfig';
import { collectHelidonJavaDiagnostics, parseJavaConfigReferences } from '../javaConfig';
import {
	buildHelidonLaunchConfiguration,
	buildHelidonRunTask,
	buildLegacyMavenGenerateArgs,
	buildProjectGenerationModePicks,
	extractWorkspaceUriFromTarget,
	isHelidonDebugSession,
	isHelidonTaskExecution,
	isLikelyHelidonMicroProfileProject,
	LEGACY_ARCHETYPES,
	resolveHelidonLaunchMainClass,
} from '../generator';
import { parseHelidonConfigMetadata, type HelidonConfigProperty } from '../metadata';
import { loadHelidonConfigMetadataFromJavaClasspaths, type JavaExtensionApi } from '../javaMetadata';

const TEST_METADATA_JSON = JSON.stringify([
	{
		module: 'test-module',
		types: [
			{
				type: 'example.ServerConfig',
				standalone: true,
				prefix: 'server',
				inherits: [],
				options: [
					{
						key: 'port',
						type: 'java.lang.Integer',
						description: 'Server port',
						kind: 'VALUE',
						defaultValue: '8080',
					},
					{
						key: 'max-payload-size',
						type: 'java.lang.Long',
						description: 'Max payload size',
						kind: 'VALUE',
					},
				],
			},
			{
				type: 'example.MetricsConfig',
				standalone: true,
				prefix: 'metrics',
				inherits: [],
				options: [
					{
						key: 'enabled',
						type: 'java.lang.Boolean',
						description: 'Metrics enabled',
						kind: 'VALUE',
						defaultValue: 'false',
					},
				],
			},
			{
				type: 'example.LoggingConfig',
				standalone: true,
				prefix: 'logging',
				inherits: [],
				options: [
					{
						key: 'loggers',
						type: 'example.LoggerConfig',
						description: 'Logger list',
						kind: 'LIST',
					},
				],
			},
			{
				type: 'example.SecurityConfig',
				standalone: true,
				prefix: 'security',
				inherits: [],
				options: [
					{
						key: 'providers',
						type: 'example.ProviderConfig',
						description: 'Security providers',
						kind: 'LIST',
					},
				],
			},
		],
	},
	{
		module: 'test-nested-module',
		types: [
			{
				type: 'example.LoggerConfig',
				standalone: false,
				prefix: '',
				inherits: [],
				options: [
					{
						key: 'name',
						type: 'java.lang.String',
						description: 'Logger name',
						kind: 'VALUE',
					},
					{
						key: 'level',
						type: 'java.lang.String',
						description: 'Logger level',
						kind: 'VALUE',
					},
				],
			},
			{
				type: 'example.ProviderConfig',
				standalone: false,
				prefix: '',
				inherits: [],
				options: [
					{
						key: 'oidc',
						type: 'example.OidcConfig',
						description: 'OIDC provider',
						kind: 'VALUE',
					},
				],
			},
			{
				type: 'example.OidcConfig',
				standalone: false,
				prefix: '',
				inherits: [],
				options: [
					{
						key: 'client-id',
						type: 'java.lang.String',
						description: 'OIDC client id',
						kind: 'VALUE',
					},
				],
			},
		],
	},
]);

const TEST_PROPERTIES: HelidonConfigProperty[] = [
	{
		key: 'server.port',
		type: 'java.lang.Integer',
		kind: 'VALUE',
		defaultValue: '8080',
		description: 'Server port',
	},
	{
		key: 'server.max-payload-size',
		type: 'java.lang.Long',
		kind: 'VALUE',
		description: 'Max payload size',
	},
	{
		key: 'metrics.enabled',
		type: 'java.lang.Boolean',
		kind: 'VALUE',
		defaultValue: 'false',
		description: 'Metrics enabled',
	},
	{
		key: 'logging.loggers',
		type: 'list<example.LoggerConfig>',
		kind: 'LIST',
		description: 'Logger list',
	},
	{
		key: 'logging.loggers.0.name',
		type: 'java.lang.String',
		kind: 'VALUE',
		description: 'Logger name',
	},
	{
		key: 'logging.level',
		type: 'java.lang.String',
		kind: 'VALUE',
		description: 'Logging level',
	},
	{
		key: 'logging.loggers.0.level',
		type: 'java.lang.String',
		kind: 'VALUE',
		description: 'Logger level',
	},
	{
		key: 'security.providers',
		type: 'list<example.ProviderConfig>',
		kind: 'LIST',
		description: 'Security providers',
	},
	{
		key: 'security.providers.0.oidc.client-id',
		type: 'java.lang.String',
		kind: 'VALUE',
		description: 'OIDC client id',
	},
];

function seedTestMetadata(): void {
	replaceHelidonConfigProperties(TEST_PROPERTIES);
}

function firstWorkspaceEdit(action: vscode.CodeAction): vscode.TextEdit {
	const entries = action.edit?.entries() ?? [];
	assert.strictEqual(entries.length, 1);
	assert.strictEqual(entries[0][1].length, 1);
	return entries[0][1][0];
}

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('metadata parser loads Helidon properties from metadata JSON', () => {
		const metadata = parseHelidonConfigMetadata(TEST_METADATA_JSON);
		assert.ok(metadata.some((property) => property.key === 'server.port'));
		assert.ok(metadata.some((property) => property.key === 'security.providers'));
	});

	test('metadata parser returns an empty result for invalid JSON', () => {
		assert.deepStrictEqual(parseHelidonConfigMetadata('{'), []);
	});

	test('JAX-RS endpoint parser discovers class and method paths', async () => {
		const endpoints = await parseJavaJaxRsEndpoints(`
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
		`);

		assert.deepStrictEqual(
			endpoints.map((endpoint) => ({
				className: endpoint.className,
				methodName: endpoint.methodName,
				httpMethod: endpoint.httpMethod,
				path: endpoint.path,
			})),
			[
				{ className: 'GreetResource', methodName: 'getDefaultMessage', httpMethod: 'GET', path: '/greet' },
				{ className: 'GreetResource', methodName: 'getMessage', httpMethod: 'GET', path: '/greet/{name}' },
				{ className: 'GreetResource', methodName: 'updateGreeting', httpMethod: 'PUT', path: '/greet/greeting' },
			]
		);
	});

	test('JAX-RS endpoint parser reads @Path annotation values from named arguments', async () => {
		const endpoints = await parseJavaJaxRsEndpoints(`
			import jakarta.ws.rs.GET;
			import jakarta.ws.rs.Path;

			@Path(value = "/greet")
			public class GreetResource {
			    @Path(value = "/{name}")
			    @GET
			    public Message getMessage(String name) {
			        return null;
			    }
			}
		`);

		assert.deepStrictEqual(
			endpoints.map((endpoint) => ({
				className: endpoint.className,
				methodName: endpoint.methodName,
				httpMethod: endpoint.httpMethod,
				path: endpoint.path,
			})),
			[
				{ className: 'GreetResource', methodName: 'getMessage', httpMethod: 'GET', path: '/greet/{name}' },
			]
		);
	});

	test('JAX-RS endpoint parser ignores non-endpoint Java methods', async () => {
		const endpoints = await parseJavaJaxRsEndpoints(`
			public class PlainService {
			    public String greet() {
			        return "hi";
			    }
			}
		`);

		assert.deepStrictEqual(endpoints, []);
	});

	test('Helidon routing parser discovers service-style route methods', async () => {
		const endpoints = await parseJavaHelidonRoutingEndpoints(`
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
		`);

		assert.deepStrictEqual(
			endpoints.map((endpoint) => ({
				className: endpoint.className,
				methodName: endpoint.methodName,
				httpMethod: endpoint.httpMethod,
				path: endpoint.path,
			})),
			[
				{ className: 'GreetService', methodName: 'getDefaultMessageHandler', httpMethod: 'GET', path: '/' },
				{ className: 'GreetService', methodName: 'getMessageHandler', httpMethod: 'GET', path: '/{name}' },
				{ className: 'GreetService', methodName: 'updateGreetingHandler', httpMethod: 'PUT', path: '/greeting' },
			]
		);
	});

	test('Helidon routing parser resolves local string values for route paths', async () => {
		const endpoints = await parseJavaHelidonRoutingEndpoints(`
			public class GreetService {
			    void update(Routing.Rules rules) {
			        String greetingPath = "/greeting";
			        rules.put(greetingPath, this::updateGreetingHandler);
			    }

			    void updateGreetingHandler(ServerRequest req, ServerResponse res) {
			    }
			}
		`);

		assert.deepStrictEqual(
			endpoints.map((endpoint) => ({
				className: endpoint.className,
				methodName: endpoint.methodName,
				httpMethod: endpoint.httpMethod,
				path: endpoint.path,
			})),
			[
				{ className: 'GreetService', methodName: 'updateGreetingHandler', httpMethod: 'PUT', path: '/greeting' },
			]
		);
	});

	test('Java config parser discovers Config.get string literals', () => {
		const references = parseJavaConfigReferences(`
			import io.helidon.config.Config;

			class Demo {
			    void load(Config config) {
			        config.get("server.port").asInt();
			        config.get("metrics.enabled").asBoolean();
			    }
			}
		`);

		assert.deepStrictEqual(references.map((reference) => reference.key), ['server.port', 'metrics.enabled']);
	});

	test('Java config parser ignores unrelated get calls even when Helidon Config is in scope', () => {
		const references = parseJavaConfigReferences(`
			import io.helidon.config.Config;
			import java.util.Map;

			class Demo {
			    void load(Config config, Map<String, String> values) {
			        values.get("not.a.config");
			        config.get("server.port").asInt();
			    }
			}
		`);

		assert.deepStrictEqual(references.map((reference) => reference.key), ['server.port']);
	});

	test('Java config parser recognizes Helidon Config field and static-chain receivers', () => {
		const references = parseJavaConfigReferences(`
			import io.helidon.config.Config;

			class Demo {
			    private Config field;

			    void load() {
			        this.field.get("server.port").asInt();
			        Config.global().get("metrics.enabled").asBoolean();
			    }
			}
		`);

		assert.deepStrictEqual(references.map((reference) => reference.key), ['server.port', 'metrics.enabled']);
	});

	test('findHelidonConfigProperty finds known Helidon property metadata', () => {
		seedTestMetadata();
		const property = findHelidonConfigProperty('server.port');
		assert.ok(property);
		assert.strictEqual(property?.defaultValue, '8080');
	});

	test('findHelidonConfigProperty returns undefined for unknown properties', () => {
		seedTestMetadata();
		assert.strictEqual(findHelidonConfigProperty('server.unknown'), undefined);
	});

	test('application.properties is recognized as a Helidon properties document', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'properties',
			content: 'server.',
		});

		assert.strictEqual(isHelidonPropertiesDocument(document), false);
	});

	test('only real application.properties file names are recognized', async () => {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/application.properties'));
		assert.strictEqual(isHelidonPropertiesDocument(document), true);
	});

	test('microprofile-config.properties is recognized as a Helidon properties document', async () => {
		const document = await vscode.workspace.openTextDocument(
			vscode.Uri.parse('untitled:/microprofile-config.properties')
		);
		assert.strictEqual(isHelidonPropertiesDocument(document), true);
	});

	test('microprofile-config.properties is recognized even if VS Code language mode is not properties', () => {
		const document = {
			fileName: '/tmp/microprofile-config.properties',
			languageId: 'plaintext',
		} as vscode.TextDocument;
		assert.strictEqual(isHelidonPropertiesDocument(document), true);
	});

	test('profile-specific microprofile-config properties are recognized as Helidon properties documents', () => {
		const document = {
			fileName: '/tmp/microprofile-config-dev.properties',
			languageId: 'plaintext',
		} as vscode.TextDocument;
		assert.strictEqual(isHelidonPropertiesDocument(document), true);
	});

	test('application-dev.properties is not recognized as a Helidon properties document', () => {
		const document = {
			fileName: '/tmp/application-dev.properties',
			languageId: 'plaintext',
		} as vscode.TextDocument;
		assert.strictEqual(isHelidonPropertiesDocument(document), false);
	});

	test('MicroProfile-managed Helidon properties file detection is limited to exact standard names', () => {
		assert.strictEqual(isMicroProfileManagedHelidonPropertiesFile('/tmp/application.properties'), true);
		assert.strictEqual(isMicroProfileManagedHelidonPropertiesFile('/tmp/microprofile-config.properties'), true);
		assert.strictEqual(isMicroProfileManagedHelidonPropertiesFile('/tmp/microprofile-config-dev.properties'), false);
		assert.strictEqual(isMicroProfileManagedHelidonPropertiesFile('/tmp/application-dev.properties'), false);
	});

	test('custom Helidon properties features back off exact standard names when Tools for MicroProfile is present', () => {
		assert.strictEqual(
			shouldUseCustomHelidonPropertiesFeatures({ fileName: '/tmp/application.properties' }, true),
			false
		);
		assert.strictEqual(
			shouldUseCustomHelidonPropertiesFeatures({ fileName: '/tmp/microprofile-config.properties' }, true),
			false
		);
		assert.strictEqual(
			shouldUseCustomHelidonPropertiesFeatures({ fileName: '/tmp/microprofile-config-dev.properties' }, true),
			true
		);
		assert.strictEqual(
			shouldUseCustomHelidonPropertiesFeatures({ fileName: '/tmp/application.properties' }, false),
			true
		);
	});

	test('properties selector set narrows to Helidon-only names when Tools for MicroProfile is present', () => {
		assert.deepStrictEqual(buildHelidonPropertiesDocumentSelectors(true), [
			{ scheme: 'file', pattern: '**/microprofile-config-*.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config-*.properties' },
		]);
		assert.deepStrictEqual(buildHelidonPropertiesDocumentSelectors(false), [
			{ scheme: 'file', pattern: '**/application.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config-*.properties' },
			{ scheme: 'untitled', pattern: '**/application.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config-*.properties' },
		]);
	});

	test('non application.properties file names are ignored', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'properties',
			content: 'server.',
		});

		assert.strictEqual(isHelidonPropertiesDocument(document), false);
	});

	test('application.yaml is recognized as a Helidon YAML document', async () => {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/application.yaml'));
		assert.strictEqual(isHelidonYamlDocument(document), true);
	});

	test('application.yml is not recognized as a Helidon YAML document', async () => {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/application.yml'));
		assert.strictEqual(isHelidonYamlDocument(document), false);
	});

	test('non application YAML file names are ignored', async () => {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/values.yaml'));
		assert.strictEqual(isHelidonYamlDocument(document), false);
	});

	test('application-prod.yaml is recognized as a Helidon YAML document', () => {
		const document = {
			fileName: '/tmp/application-prod.yaml',
			languageId: 'yaml',
		} as vscode.TextDocument;
		assert.strictEqual(isHelidonYamlDocument(document), true);
	});

	test('properties diagnostics warn for unknown keys under known Helidon roots', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, ['server.prt=8080', 'custom.value=test'].join('\n'), 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(diagnostics[0].message, "Unknown Helidon configuration key 'server.prt'.");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics accept bracketed indexed keys that normalize to Helidon metadata', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-indexed-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'logging.loggers[0].name=demo', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics report malformed indexed key syntax', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-index-errors-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(
				filePath,
				[
					'logging.loggers[0.name=demo',
					'logging.loggers[].name=demo',
					'logging.loggers[abc].name=demo',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 3);
			assert.deepStrictEqual(
				diagnostics.map((diagnostic) => diagnostic.message),
				[
					"Indexed Helidon configuration key is missing a closing ']'.",
					'Indexed Helidon configuration key is missing an index value.',
					'Indexed Helidon configuration key index must be an integer.',
				]
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics report nested keys under scalar properties', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-scalar-path-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'server.port.value=8080', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(
				diagnostics[0].message,
				"Helidon configuration key 'server.port' does not support nested keys."
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics report missing list indexes before nested keys', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-list-path-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'logging.loggers.name=demo', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(
				diagnostics[0].message,
				"Helidon configuration list 'logging.loggers' requires an index before nested keys."
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics report invalid boolean and integer values', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-values-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(
				filePath,
				[
					'metrics.enabled=maybe',
					'server.port=eighty',
					'server.max-payload-size=12kb',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 3);
			assert.deepStrictEqual(
				diagnostics.map((diagnostic) => diagnostic.message),
				[
					"Helidon configuration value for 'metrics.enabled' must be 'true' or 'false'.",
					"Helidon configuration value for 'server.port' must be an integer.",
					"Helidon configuration value for 'server.max-payload-size' must be an integer.",
				]
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics accept valid boolean and integer values', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-values-valid-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(
				filePath,
				[
					'metrics.enabled=true',
					'server.port=8080',
					'server.max-payload-size=-1',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics validate placeholder references under known Helidon roots', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-placeholders-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'server.port=${server.prt}', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(diagnostics[0].message, "Unknown Helidon configuration key 'server.prt'.");
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics report duplicate Helidon keys in the same file', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-duplicates-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(
				filePath,
				[
					'server.port=8080',
					'server.port=8081',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(
				diagnostics[0].message,
				"Duplicate Helidon configuration key 'server.port'. Previous declaration is on line 1."
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics normalize indexed Helidon keys when checking duplicates', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-indexed-duplicates-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(
				filePath,
				[
					'logging.loggers[0].name=demo',
					'logging.loggers.0.name=other',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 1);
			assert.strictEqual(
				diagnostics[0].message,
				"Duplicate Helidon configuration key 'logging.loggers.0.name'. Previous declaration is on line 1."
			);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties diagnostics keep duplicate warnings scoped to Helidon roots', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-custom-duplicates-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(
				filePath,
				[
					'custom.value=one',
					'custom.value=two',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			assert.strictEqual(diagnostics.length, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('yaml diagnostics warn for unknown keys under known Helidon roots', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'server:',
				'  prt: 8080',
				'custom:',
				'  value: test',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown Helidon configuration key 'server.prt'.");
	});

	test('yaml diagnostics accept inline list item keys that map to normalized metadata keys', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'logging:',
				'  loggers:',
				'    - name: demo',
				'      level: INFO',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 0);
	});

	test('yaml diagnostics report invalid boolean and integer values', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'metrics:',
				'  enabled: maybe',
				'server:',
				'  port: eighty',
				'  max-payload-size: 12kb',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 3);
		assert.deepStrictEqual(
			diagnostics.map((diagnostic) => diagnostic.message),
			[
				"Helidon configuration value for 'metrics.enabled' must be 'true' or 'false'.",
				"Helidon configuration value for 'server.port' must be an integer.",
				"Helidon configuration value for 'server.max-payload-size' must be an integer.",
			]
		);
	});

	test('yaml diagnostics accept quoted valid boolean and integer values', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'metrics:',
				'  enabled: "false"',
				'server:',
				'  port: "8080"',
				'  max-payload-size: \'-1\'',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 0);
	});

	test('yaml diagnostics validate placeholder references under known Helidon roots', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'server:',
				'  port: ${server.prt}',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown Helidon configuration key 'server.prt'.");
	});

	test('yaml diagnostics report nested keys under scalar properties', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'server:',
				'  port:',
				'    value: 8080',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Helidon configuration key 'server.port' does not support nested keys."
		);
	});

	test('yaml diagnostics report missing list indexes before nested keys', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'logging:',
				'  loggers:',
				'    name: demo',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Helidon configuration list 'logging.loggers' requires an index before nested keys."
		);
	});

	test('yaml diagnostics report duplicate keys in the same mapping', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'server:',
				'  port: 8080',
				'  port: 8081',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Duplicate YAML key 'port'.");
	});

	test('yaml diagnostics do not report duplicate keys across separate list items', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'logging:',
				'  loggers:',
				'    - name: demo',
				'    - name: other',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 0);
	});

	test('yaml diagnostics accept quoted numeric map keys used as indexed config entries', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'logging:',
				'  level: INFO',
				'  loggers:',
				'    "0":',
				'      name: io.helidon.webserver',
				'      level: DEBUG',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 0);
	});

	test('properties quick fix suggests typo correction for unknown keys', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-properties-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'server.prt=8080', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const typoFix = actions.find((action) => action.title === "Change to 'server.port'");
			assert.ok(typoFix);
			const edit = firstWorkspaceEdit(typoFix!);
			assert.strictEqual(edit.newText, 'server.port');
			assert.strictEqual(edit.range.start.line, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties quick fix replaces malformed indexed key segments', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-indexed-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'logging.loggers[].name=demo', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const indexedFix = actions.find((action) => action.title === "Replace with '[0]'");
			assert.ok(indexedFix);
			const edit = firstWorkspaceEdit(indexedFix!);
			assert.strictEqual(edit.newText, '[0]');
			assert.strictEqual(edit.range.start.character, 'logging.loggers'.length);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties quick fix rewrites nested scalar paths back to the supported key', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-path-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'server.port.value=8080', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const pathFix = actions.find((action) => action.title === "Change to 'server.port'");
			assert.ok(pathFix);
			const edit = firstWorkspaceEdit(pathFix!);
			assert.strictEqual(edit.newText, 'server.port');
			assert.strictEqual(edit.range.start.line, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties quick fix inserts a list index for missing list nesting', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-list-path-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'logging.loggers.name=demo', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const pathFix = actions.find((action) => action.title === "Change to 'logging.loggers[0].name'");
			assert.ok(pathFix);
			const edit = firstWorkspaceEdit(pathFix!);
			assert.strictEqual(edit.newText, 'logging.loggers[0].name');
			assert.strictEqual(edit.range.start.line, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties quick fix offers the metadata default for invalid boolean values', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-boolean-value-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'metrics.enabled=maybe', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const defaultFix = actions.find((action) => action.title === "Replace with default 'false'");
			assert.ok(defaultFix);
			const edit = firstWorkspaceEdit(defaultFix!);
			assert.strictEqual(edit.newText, 'false');
			assert.strictEqual(edit.range.start.line, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('properties quick fix offers the metadata default for invalid integer values', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-integer-value-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'microprofile-config.properties');
			await fs.writeFile(filePath, 'server.port=eighty', 'utf8');
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonPropertiesDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const defaultFix = actions.find((action) => action.title === "Replace with default '8080'");
			assert.ok(defaultFix);
			const edit = firstWorkspaceEdit(defaultFix!);
			assert.strictEqual(edit.newText, '8080');
			assert.strictEqual(edit.range.start.line, 0);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('yaml quick fix removes duplicate YAML key blocks', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-yaml-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'application.yaml');
			await fs.writeFile(
				filePath,
				[
					'server:',
					'  port: 8080',
					'  port: 8081',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonYamlDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const duplicateFix = actions.find((action) => action.title === 'Remove duplicate YAML key');
			assert.ok(duplicateFix);
			const edit = firstWorkspaceEdit(duplicateFix!);
			assert.strictEqual(edit.newText, '');
			assert.strictEqual(edit.range.start.line, 2);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('yaml quick fix suggests typo correction for unknown keys', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-yaml-typo-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'application.yaml');
			await fs.writeFile(
				filePath,
				[
					'server:',
					'  prt: 8080',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonYamlDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const typoFix = actions.find((action) => action.title === "Change to 'port'");
			assert.ok(typoFix);
			const edit = firstWorkspaceEdit(typoFix!);
			assert.strictEqual(edit.newText, 'port');
			assert.strictEqual(edit.range.start.line, 1);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('yaml placeholder quick fix keeps the full key suggestion', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-yaml-placeholder-quickfix-'));
		try {
			const filePath = path.join(tempRoot, 'application.yaml');
			await fs.writeFile(
				filePath,
				[
					'server:',
					'  port: ${server.prt}',
				].join('\n'),
				'utf8'
			);
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));

			seedTestMetadata();
			const diagnostics = collectHelidonYamlDiagnostics(document);
			const provider = new HelidonConfigCodeActionProvider();
			const actions =
				(await Promise.resolve(
					provider.provideCodeActions(document, diagnostics[0].range, {
						diagnostics,
						only: vscode.CodeActionKind.QuickFix,
						triggerKind: vscode.CodeActionTriggerKind.Invoke,
					})
				)) ?? [];

			const typoFix = actions.find((action) => action.title === "Change to 'server.port'");
			assert.ok(typoFix);
			const edit = firstWorkspaceEdit(typoFix!);
			assert.strictEqual(edit.newText, 'server.port');
			assert.strictEqual(edit.range.start.line, 1);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('java quick fix suggests Helidon config key corrections inside Config.get calls', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'java',
			content: [
				'import io.helidon.config.Config;',
				'class Demo {',
				'  void test(Config config) {',
				'    config.get("server.prt").asInt();',
				'  }',
				'}',
			].join('\n'),
		});

		seedTestMetadata();
		const diagnostics = collectHelidonJavaDiagnostics(document);
		const provider = new HelidonConfigCodeActionProvider();
		const actions =
			(await Promise.resolve(
				provider.provideCodeActions(document, diagnostics[0].range, {
					diagnostics,
					only: vscode.CodeActionKind.QuickFix,
					triggerKind: vscode.CodeActionTriggerKind.Invoke,
				})
			)) ?? [];

		const typoFix = actions.find((action) => action.title === "Change to 'server.port'");
		assert.ok(typoFix);
		const edit = firstWorkspaceEdit(typoFix!);
		assert.strictEqual(edit.newText, 'server.port');
		assert.strictEqual(edit.range.start.line, 3);
	});

	test('legacy generator exposes the expanded Helidon archetype list', () => {
		assert.deepStrictEqual(
			LEGACY_ARCHETYPES.map((archetype) => archetype.value),
			[
				'helidon-quickstart-se',
				'helidon-quickstart-mp',
				'helidon-bare-se',
				'helidon-bare-mp',
				'helidon-database-se',
				'helidon-database-mp',
			]
		);
	});

	test('project generation picker shows both selectable options when Helidon CLI is available', () => {
		const picks = buildProjectGenerationModePicks(true);
		assert.strictEqual(picks.length, 2);
		assert.strictEqual(picks[0].label, 'Helidon CLI Wizard');
		assert.strictEqual(picks[0].mode, 'cli-wizard');
		assert.strictEqual(picks[1].label, 'Maven Archetype Generator');
		assert.strictEqual(picks[1].mode, 'maven-archetype');
	});

	test('project generation picker keeps the CLI path visible but disabled when Helidon CLI is missing', () => {
		const picks = buildProjectGenerationModePicks(false);
		assert.strictEqual(picks.length, 2);
		assert.strictEqual(picks[0].label, 'Helidon CLI Wizard (disabled: helidon not found on PATH)');
		assert.strictEqual(picks[0].kind, vscode.QuickPickItemKind.Separator);
		assert.strictEqual(picks[0].mode, undefined);
		assert.strictEqual(picks[1].label, 'Maven Archetype Generator');
		assert.strictEqual(picks[1].mode, 'maven-archetype');
	});

	test('workspace target extraction understands direct URIs and Helidon endpoint tree payloads', () => {
		const uri = vscode.Uri.file('/tmp/demo-helidon/src/main/java/com/example/Main.java');
		assert.strictEqual(extractWorkspaceUriFromTarget(uri)?.toString(), uri.toString());
		assert.strictEqual(extractWorkspaceUriFromTarget({ uri })?.toString(), uri.toString());
		assert.strictEqual(extractWorkspaceUriFromTarget({ endpoint: { uri } })?.toString(), uri.toString());
		assert.strictEqual(extractWorkspaceUriFromTarget({ group: { uri } })?.toString(), uri.toString());
		assert.strictEqual(extractWorkspaceUriFromTarget({ viewId: 'helidonEndpoints' }), undefined);
	});

	test('Helidon debug session detection matches the generated Java launch configuration', () => {
		assert.strictEqual(
			isHelidonDebugSession({
				type: 'java',
				name: 'Launch Helidon Application',
				configuration: { type: 'java', request: 'launch', name: 'Launch Helidon Application' },
			} as vscode.DebugSession),
			true
		);
		assert.strictEqual(
			isHelidonDebugSession({
				type: 'java',
				name: 'Something Else',
				configuration: { type: 'java', request: 'launch', name: 'Something Else' },
			} as vscode.DebugSession),
			false
		);
	});

	test('Helidon task execution detection matches generated helidon tasks', () => {
		const runTask = new vscode.Task(
			{ type: 'shell' },
			vscode.TaskScope.Workspace,
			'helidon: run',
			'helidon-vsc'
		);
		const buildTask = new vscode.Task(
			{ type: 'shell' },
			vscode.TaskScope.Workspace,
			'helidon: build',
			'helidon-vsc'
		);
		const otherTask = new vscode.Task(
			{ type: 'shell' },
			vscode.TaskScope.Workspace,
			'mvn package',
			'helidon-vsc'
		);
		assert.strictEqual(isHelidonTaskExecution({ task: runTask } as vscode.TaskExecution), true);
		assert.strictEqual(isHelidonTaskExecution({ task: buildTask } as vscode.TaskExecution), true);
		assert.strictEqual(isHelidonTaskExecution({ task: otherTask } as vscode.TaskExecution), false);
	});

	test('legacy generator builds Maven archetype arguments', () => {
		assert.deepStrictEqual(
			buildLegacyMavenGenerateArgs({
				targetDirectory: '/tmp/ignored',
				groupId: 'com.acme',
				artifactId: 'demo-helidon',
				packageName: 'com.acme.demo',
				archetypeArtifactId: 'helidon-database-mp',
				version: '4.4.0',
			}),
			[
				'archetype:generate',
				'-B',
				'-DarchetypeGroupId=io.helidon.archetypes',
				'-DarchetypeArtifactId=helidon-database-mp',
				'-DarchetypeVersion=4.4.0',
				'-DgroupId=com.acme',
				'-DartifactId=demo-helidon',
				'-Dpackage=com.acme.demo',
				'-DinteractiveMode=false',
			]
		);
	});

	test('MicroProfile projects fall back to io.helidon.Main when no Java main class is discovered', () => {
		assert.strictEqual(resolveHelidonLaunchMainClass(undefined, true), 'io.helidon.Main');
		assert.strictEqual(resolveHelidonLaunchMainClass('com.example.Main', true), 'com.example.Main');
		assert.strictEqual(resolveHelidonLaunchMainClass(undefined, false), undefined);
	});

	test('launch configuration uses the Helidon build task and integrated terminal', () => {
		assert.deepStrictEqual(buildHelidonLaunchConfiguration('com.example.Main'), {
			type: 'java',
			name: 'Launch Helidon Application',
			request: 'launch',
			mainClass: 'com.example.Main',
			cwd: '${workspaceFolder}',
			console: 'integratedTerminal',
			preLaunchTask: 'helidon: build',
		});
	});

	test('Maven run task executes the resolved main class through exec-maven-plugin', () => {
		assert.deepStrictEqual(buildHelidonRunTask('maven', 'io.helidon.Main'), {
			label: 'helidon: run',
			type: 'shell',
			command: 'mvn',
			args: ['compile', 'org.codehaus.mojo:exec-maven-plugin:3.6.2:java', '-Dexec.mainClass=io.helidon.Main'],
			problemMatcher: [],
		});
	});

	test('MicroProfile project detection recognizes pom.xml markers and config layout', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-mp-'));
		try {
			await fs.writeFile(
				path.join(tempRoot, 'pom.xml'),
				'<project><dependencies><dependency><artifactId>helidon-microprofile-core</artifactId></dependency></dependencies></project>',
				'utf8'
			);
			assert.strictEqual(await isLikelyHelidonMicroProfileProject(tempRoot), true);

			const configRoot = path.join(tempRoot, 'src', 'main', 'resources', 'META-INF');
			await fs.mkdir(configRoot, { recursive: true });
			await fs.writeFile(path.join(configRoot, 'microprofile-config.properties'), 'server.port=8080\n', 'utf8');
			assert.strictEqual(await isLikelyHelidonMicroProfileProject(tempRoot), true);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('classpath metadata loader reads Helidon metadata from directories and jars', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helidon-vsc-'));
		try {
			const classesDir = path.join(tempRoot, 'classes');
			const jarPath = path.join(tempRoot, 'helidon-demo.jar');
			const metadataDir = path.join(classesDir, 'META-INF', 'helidon');
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(
				path.join(metadataDir, 'config-metadata.json'),
				JSON.stringify([
					{
						module: 'dir-module',
						types: [
							{
								type: 'example.DirConfig',
								standalone: true,
								prefix: 'example.dir',
								inherits: [],
								options: [
									{
										key: 'enabled',
										type: 'java.lang.Boolean',
										description: 'Directory metadata',
										kind: 'VALUE',
										defaultValue: 'true',
									},
								],
							},
						],
					},
				]),
				'utf8'
			);

			const archive = new JSZip();
			archive.file(
				'META-INF/helidon/config-metadata.json',
				JSON.stringify([
					{
						module: 'jar-module',
						types: [
							{
								type: 'example.JarConfig',
								standalone: true,
								prefix: 'example.jar',
								inherits: [],
								options: [
									{
										key: 'port',
										type: 'java.lang.Integer',
										description: 'Jar metadata',
										kind: 'VALUE',
										defaultValue: '7001',
									},
								],
							},
						],
					},
				])
			);
			await fs.writeFile(jarPath, await archive.generateAsync({ type: 'nodebuffer' }));

			const fakeJavaApi: JavaExtensionApi = {
				async serverReady() {},
				async getClasspaths() {
					return {
						classpaths: [classesDir, jarPath],
						modulepaths: [],
					};
				},
			};

			const metadata = await loadHelidonConfigMetadataFromJavaClasspaths(
				fakeJavaApi,
				[{ uri: vscode.Uri.file(tempRoot), name: 'workspace', index: 0 }]
			);

			assert.ok(metadata.some((property) => property.key === 'example.dir.enabled'));
			assert.ok(metadata.some((property) => property.key === 'example.jar.port'));
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	test('package manifest composes with Tools for MicroProfile for application.properties', async () => {
		const packageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
		const manifest = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
			extensionPack?: string[];
			contributes?: {
				microprofile?: {
					documentSelector?: Array<Record<string, string>>;
				};
			};
		};

		assert.ok(manifest.extensionPack?.includes('redhat.vscode-microprofile'));
		assert.deepStrictEqual(manifest.contributes?.microprofile?.documentSelector, [
			{
				scheme: 'file',
				language: 'properties',
				pattern: '**/application.properties',
			},
			{
				scheme: 'file',
				language: 'java-properties',
				pattern: '**/application.properties',
			},
			{
				scheme: 'untitled',
				language: 'properties',
				pattern: '**/application.properties',
			},
			{
				scheme: 'untitled',
				language: 'java-properties',
				pattern: '**/application.properties',
			},
		]);
	});
});
