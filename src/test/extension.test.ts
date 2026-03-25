import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip = require('jszip');

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	collectHelidonPropertiesDiagnostics,
	collectHelidonYamlDiagnostics,
	findHelidonConfigProperty,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
	replaceHelidonConfigProperties,
} from '../helidonConfig';
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
		defaultValue: '8080',
		description: 'Server port',
	},
	{
		key: 'logging.loggers.0.name',
		type: 'java.lang.String',
		description: 'Logger name',
	},
	{
		key: 'logging.level',
		type: 'java.lang.String',
		description: 'Logging level',
	},
	{
		key: 'logging.loggers.0.level',
		type: 'java.lang.String',
		description: 'Logger level',
	},
	{
		key: 'security.providers.0.oidc.client-id',
		type: 'java.lang.String',
		description: 'OIDC client id',
	},
];

function seedTestMetadata(): void {
	replaceHelidonConfigProperties(TEST_PROPERTIES);
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

	test('non application YAML file names are ignored', async () => {
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse('untitled:/values.yaml'));
		assert.strictEqual(isHelidonYamlDocument(document), false);
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
});
