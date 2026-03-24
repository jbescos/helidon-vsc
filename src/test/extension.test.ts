import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { HELIDON_CONFIG_PROPERTIES, isHelidonPropertiesDocument } from '../helidonConfig';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Helidon config metadata contains server.port', () => {
		assert.ok(HELIDON_CONFIG_PROPERTIES.some((property) => property.key === 'server.port'));
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
});

