import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	collectHelidonPropertiesDiagnostics,
	collectHelidonYamlDiagnostics,
	HELIDON_CONFIG_PROPERTIES,
	findHelidonConfigProperty,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
} from '../helidonConfig';
import { loadHelidonConfigMetadata } from '../metadata';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Helidon config metadata contains server.port', () => {
		assert.ok(HELIDON_CONFIG_PROPERTIES.some((property) => property.key === 'server.port'));
	});

	test('metadata is loaded from the external metadata source', () => {
		const metadata = loadHelidonConfigMetadata();
		assert.ok(metadata.length > 0);
		assert.ok(metadata.some((property) => property.key === 'server.port'));
		assert.ok(metadata.some((property) => property.key === 'server.features.observe.endpoints.health.path'));
	});

	test('findHelidonConfigProperty finds known Helidon property metadata', () => {
		const property = findHelidonConfigProperty('server.port');
		assert.ok(property);
		assert.strictEqual(property?.defaultValue, '8080');
	});

	test('findHelidonConfigProperty returns undefined for unknown properties', () => {
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
		const document = await vscode.workspace.openTextDocument({
			language: 'properties',
			content: ['server.prt=8080', 'custom.value=test', 'security.providers.1.oidc.client-id=demo'].join('\n'),
		});

		const diagnostics = collectHelidonPropertiesDiagnostics(document);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown Helidon configuration key 'server.prt'.");
	});

	test('yaml diagnostics warn for unknown keys under known Helidon roots', async () => {
		const document = await vscode.workspace.openTextDocument({
			language: 'yaml',
			content: [
				'server:',
				'  prt: 8080',
				'custom:',
				'  value: test',
				'security:',
				'  providers:',
				'    - oidc:',
				'        client-id: demo',
			].join('\n'),
		});

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

		const diagnostics = collectHelidonYamlDiagnostics(document);
		assert.strictEqual(diagnostics.length, 0);
	});
});
