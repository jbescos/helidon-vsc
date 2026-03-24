import * as vscode from 'vscode';
import {
	HelidonPropertiesCompletionProvider,
	HelidonPropertiesHoverProvider,
	isHelidonPropertiesDocument,
} from './helidonConfig';

export function activate(context: vscode.ExtensionContext) {
	console.log('Helidon VS Code extension is active.');

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		{ language: 'properties', scheme: 'file' },
		new HelidonPropertiesCompletionProvider(),
		'.'
	);

	const hoverProvider = vscode.languages.registerHoverProvider(
		{ language: 'properties', scheme: 'file' },
		new HelidonPropertiesHoverProvider()
	);

	const helloWorldCommand = vscode.commands.registerCommand('helidon-vsc.helloWorld', async () => {
		const editor = vscode.window.activeTextEditor;
		if (editor && isHelidonPropertiesDocument(editor.document)) {
			await vscode.commands.executeCommand('editor.action.triggerSuggest');
			return;
		}

		vscode.window.showInformationMessage(
			'Open an application.properties file to try Helidon configuration completion.'
		);
	});

	context.subscriptions.push(completionProvider, hoverProvider, helloWorldCommand);
}

export function deactivate() {}
