import * as vscode from 'vscode';
import {
	HelidonPropertiesCompletionProvider,
	HelidonPropertiesHoverProvider,
	HelidonYamlCompletionProvider,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
} from './helidonConfig';
import { generateHelidonProject } from './generator';

export function activate(context: vscode.ExtensionContext) {
	console.log('Helidon VS Code extension is active.');

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'properties', scheme: 'file' },
		new HelidonPropertiesCompletionProvider(),
		'.'
	);

	const yamlCompletionProvider = vscode.languages.registerCompletionItemProvider(
		[{ language: 'yaml', scheme: 'file' }, { language: 'yaml', scheme: 'untitled' }],
		new HelidonYamlCompletionProvider(),
		'.'
	);

	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ language: 'properties', scheme: 'file' },
			{ language: 'yaml', scheme: 'file' },
			{ language: 'yaml', scheme: 'untitled' },
		],
		new HelidonPropertiesHoverProvider()
	);

	const helloWorldCommand = vscode.commands.registerCommand('helidon-vsc.helloWorld', async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && (isHelidonPropertiesDocument(editor.document) || isHelidonYamlDocument(editor.document))) {
			await vscode.commands.executeCommand('editor.action.triggerSuggest');
			return;
		}

		vscode.window.showInformationMessage(
			'Open an application.properties or application.yaml file to try Helidon configuration completion.'
		);
	});

	const generateProjectCommand = vscode.commands.registerCommand('helidon-vsc.generateProject', async () => {
		await generateHelidonProject();
	});

	context.subscriptions.push(
		completionProvider,
		yamlCompletionProvider,
		hoverProvider,
		helloWorldCommand,
		generateProjectCommand,
	);
}

export function deactivate() {}
