import * as vscode from 'vscode';
import {
	collectHelidonDiagnostics,
	HelidonPropertiesCompletionProvider,
	HelidonPropertiesHoverProvider,
	HelidonYamlCompletionProvider,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
} from './helidonConfig';
import { generateHelidonProject } from './generator';

export function activate(context: vscode.ExtensionContext) {
	console.log('Helidon VS Code extension is active.');
	const diagnostics = vscode.languages.createDiagnosticCollection('helidon-vsc');

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

	const refreshDiagnostics = (document: vscode.TextDocument) => {
		const issues = collectHelidonDiagnostics(document);
		if (issues.length === 0) {
			diagnostics.delete(document.uri);
			return;
		}

		diagnostics.set(document.uri, issues);
	};

	for (const document of vscode.workspace.textDocuments) {
		refreshDiagnostics(document);
	}

	const openDocumentDiagnostics = vscode.workspace.onDidOpenTextDocument(refreshDiagnostics);
	const changeDocumentDiagnostics = vscode.workspace.onDidChangeTextDocument((event) => {
		refreshDiagnostics(event.document);
	});
	const closeDocumentDiagnostics = vscode.workspace.onDidCloseTextDocument((document) => {
		diagnostics.delete(document.uri);
	});

	context.subscriptions.push(
		diagnostics,
		completionProvider,
		yamlCompletionProvider,
		hoverProvider,
		helloWorldCommand,
		generateProjectCommand,
		openDocumentDiagnostics,
		changeDocumentDiagnostics,
		closeDocumentDiagnostics,
	);
}

export function deactivate() {}
