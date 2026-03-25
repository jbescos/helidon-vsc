import * as vscode from 'vscode';
import {
	collectHelidonDiagnostics,
	HelidonPropertiesCompletionProvider,
	HelidonPropertiesHoverProvider,
	HelidonYamlCompletionProvider,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
	replaceHelidonConfigProperties,
} from './helidonConfig';
import { generateHelidonProject } from './generator';
import {
	hasJavaExtensionInstalled,
	getJavaExtensionApi,
	loadHelidonConfigMetadataFromJavaClasspaths,
} from './javaMetadata';

export function activate(context: vscode.ExtensionContext) {
	console.log('Helidon VS Code extension is active.');
	const diagnostics = vscode.languages.createDiagnosticCollection('helidon-vsc');
	let missingJavaExtensionWarningShown = false;
	let metadataUnavailableWarningShown = false;

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		[
			{ scheme: 'file', pattern: '**/application.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/application.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
		],
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
			{ scheme: 'file', pattern: '**/application.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/application.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
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
			'Open an application.properties, microprofile-config.properties, or application.yaml file to try Helidon configuration completion.'
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

	const refreshAllDiagnostics = () => {
		for (const document of vscode.workspace.textDocuments) {
			refreshDiagnostics(document);
		}
	};

	const showMissingJavaExtensionWarning = async () => {
		if (missingJavaExtensionWarningShown) {
			return;
		}

		missingJavaExtensionWarningShown = true;
		const action = await vscode.window.showWarningMessage(
			'Helidon configuration completion and documentation require Extension Pack for Java.',
			'Install Extension Pack for Java'
		);
		if (action === 'Install Extension Pack for Java') {
			await vscode.commands.executeCommand('workbench.extensions.search', 'vscjava.vscode-java-pack');
		}
	};

	const showMetadataUnavailableWarning = async (message: string) => {
		if (metadataUnavailableWarningShown) {
			return;
		}

		metadataUnavailableWarningShown = true;
		await vscode.window.showWarningMessage(message);
	};

	let javaClasspathWatcherRegistered = false;
	const refreshMetadataFromJavaClasspaths = async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		replaceHelidonConfigProperties([]);
		if (workspaceFolders.length === 0) {
			refreshAllDiagnostics();
			return;
		}

		const javaApi = await getJavaExtensionApi();
		if (!javaApi) {
			refreshAllDiagnostics();
			if (!hasJavaExtensionInstalled()) {
				await showMissingJavaExtensionWarning();
			} else {
				await showMetadataUnavailableWarning(
					'Language Support for Java by Red Hat is installed, but its project API is not available yet. Open a Java workspace and wait for initialization to finish.'
				);
			}
			return;
		}

		const classpathMetadata = await loadHelidonConfigMetadataFromJavaClasspaths(javaApi, workspaceFolders);
		replaceHelidonConfigProperties(classpathMetadata);
		refreshAllDiagnostics();

		if (classpathMetadata.length === 0) {
			await showMetadataUnavailableWarning(
				'Helidon configuration metadata is unavailable on the current Java classpath. Make sure the Helidon project has finished loading and that Helidon dependencies are present.'
			);
		}

		if (!javaClasspathWatcherRegistered && typeof javaApi.onDidClasspathUpdate === 'function') {
			javaClasspathWatcherRegistered = true;
			context.subscriptions.push(
				javaApi.onDidClasspathUpdate(() => {
					void refreshMetadataFromJavaClasspaths();
				})
			);
		}
	};

	refreshAllDiagnostics();

	const openDocumentDiagnostics = vscode.workspace.onDidOpenTextDocument(refreshDiagnostics);
	const changeDocumentDiagnostics = vscode.workspace.onDidChangeTextDocument((event) => {
		refreshDiagnostics(event.document);
	});
	const closeDocumentDiagnostics = vscode.workspace.onDidCloseTextDocument((document) => {
		diagnostics.delete(document.uri);
	});
	const workspaceFoldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		void refreshMetadataFromJavaClasspaths();
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
		workspaceFoldersChanged,
	);

	void refreshMetadataFromJavaClasspaths();
}

export function deactivate() {}
