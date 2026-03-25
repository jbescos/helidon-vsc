import {
	HelidonEndpointCodeLensProvider,
	HelidonEndpointsTreeDataProvider,
	HelidonPathParameterDefinitionProvider,
} from './endpoints';
import * as vscode from 'vscode';
import {
	collectHelidonDiagnostics,
	HelidonConfigCodeActionProvider,
	HelidonPropertiesCompletionProvider,
	HelidonPropertiesHoverProvider,
	HelidonYamlCompletionProvider,
	replaceHelidonConfigProperties,
} from './helidonConfig';
import { generateHelidonProject, generateHelidonProjectWithCliWizard, generateHelidonRunFiles } from './generator';
import {
	collectHelidonJavaDiagnostics,
	HelidonConfigPlaceholderDefinitionProvider,
	HelidonJavaConfigCompletionProvider,
	HelidonJavaConfigDefinitionProvider,
	HelidonJavaConfigHoverProvider,
} from './javaConfig';
import {
	hasJavaExtensionInstalled,
	getJavaExtensionApi,
	loadHelidonConfigMetadataFromJavaClasspaths,
} from './javaMetadata';

const INITIAL_METADATA_RETRY_DELAY_MS = 2000;
const INITIAL_METADATA_MAX_ATTEMPTS = 15;

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Helidon');
	output.appendLine('Helidon VS Code extension is active.');
	const diagnostics = vscode.languages.createDiagnosticCollection('helidon-vsc');
	const endpointsProvider = new HelidonEndpointsTreeDataProvider();
	const endpointsView = vscode.window.createTreeView('helidonEndpoints', {
		treeDataProvider: endpointsProvider,
		showCollapseAll: true,
	});
	let missingJavaExtensionWarningShown = false;
	let metadataUnavailableWarningShown = false;
	let metadataBootstrapComplete = false;
	let metadataRetryAttempts = 0;
	let metadataRetryTimer: ReturnType<typeof setTimeout> | undefined;

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		[
			{ scheme: 'file', pattern: '**/application*.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/application*.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
		],
		new HelidonPropertiesCompletionProvider(),
		'.',
		'$'
	);

	const yamlCompletionProvider = vscode.languages.registerCompletionItemProvider(
		[{ language: 'yaml', scheme: 'file' }, { language: 'yaml', scheme: 'untitled' }],
		new HelidonYamlCompletionProvider(),
		'.',
		'$'
	);

	const javaCompletionProvider = vscode.languages.registerCompletionItemProvider(
		[{ language: 'java', scheme: 'file' }, { language: 'java', scheme: 'untitled' }],
		new HelidonJavaConfigCompletionProvider(),
		'"'
	);

	const hoverProvider = vscode.languages.registerHoverProvider(
		[
			{ scheme: 'file', pattern: '**/application*.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/application*.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
			{ language: 'yaml', scheme: 'file' },
			{ language: 'yaml', scheme: 'untitled' },
		],
		new HelidonPropertiesHoverProvider()
	);

	const javaHoverProvider = vscode.languages.registerHoverProvider(
		[{ language: 'java', scheme: 'file' }, { language: 'java', scheme: 'untitled' }],
		new HelidonJavaConfigHoverProvider()
	);

	const placeholderDefinitionProvider = vscode.languages.registerDefinitionProvider(
		[
			{ scheme: 'file', pattern: '**/application*.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/application*.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
			{ language: 'yaml', scheme: 'file' },
			{ language: 'yaml', scheme: 'untitled' },
		],
		new HelidonConfigPlaceholderDefinitionProvider()
	);

	const javaDefinitionProvider = vscode.languages.registerDefinitionProvider(
		[{ language: 'java', scheme: 'file' }, { language: 'java', scheme: 'untitled' }],
		new HelidonJavaConfigDefinitionProvider()
	);

	const endpointCodeLensProvider = vscode.languages.registerCodeLensProvider(
		[{ language: 'java', scheme: 'file' }, { language: 'java', scheme: 'untitled' }],
		new HelidonEndpointCodeLensProvider(endpointsProvider)
	);

	const pathParameterDefinitionProvider = vscode.languages.registerDefinitionProvider(
		[{ language: 'java', scheme: 'file' }, { language: 'java', scheme: 'untitled' }],
		new HelidonPathParameterDefinitionProvider(endpointsProvider)
	);

	const codeActionProvider = vscode.languages.registerCodeActionsProvider(
		[
			{ scheme: 'file', pattern: '**/application*.properties' },
			{ scheme: 'file', pattern: '**/microprofile-config.properties' },
			{ scheme: 'untitled', pattern: '**/application*.properties' },
			{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
			{ language: 'yaml', scheme: 'file' },
			{ language: 'yaml', scheme: 'untitled' },
		],
		new HelidonConfigCodeActionProvider(),
		{
			providedCodeActionKinds: HelidonConfigCodeActionProvider.providedCodeActionKinds,
		}
	);

	const generateProjectCommand = vscode.commands.registerCommand('helidon-vsc.generateProject', async () => {
		await generateHelidonProject();
	});

	const generateProjectCliWizardCommand = vscode.commands.registerCommand(
		'helidon-vsc.generateProjectCliWizard',
		async () => {
			await generateHelidonProjectWithCliWizard();
		}
	);

	const generateRunFilesCommand = vscode.commands.registerCommand('helidon-vsc.generateRunFiles', async () => {
		await generateHelidonRunFiles();
	});

	const reloadExtensionCommand = vscode.commands.registerCommand('helidon-vsc.reloadExtension', async () => {
		await vscode.commands.executeCommand('workbench.action.reloadWindow');
	});

	const openEndpointCommand = vscode.commands.registerCommand(
		'helidon-vsc.openEndpoint',
		async (uri: vscode.Uri, range?: vscode.Range) => {
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document, { preview: false });
			if (range) {
				editor.selection = new vscode.Selection(range.start, range.end);
				editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
			}
		}
	);

	const refreshEndpointsView = async () => {
		endpointsProvider.refresh();
		if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
			endpointsView.message = 'Open a Helidon workspace to discover endpoints.';
			return;
		}

		const endpointCount = await endpointsProvider.endpointCount();
		endpointsView.message =
			endpointCount === 0 ? 'No Helidon endpoints found in workspace Java sources.' : undefined;
	};

	const refreshEndpointsCommand = vscode.commands.registerCommand('helidon-vsc.refreshEndpoints', async () => {
		await refreshEndpointsView();
	});

	const refreshDiagnostics = (document: vscode.TextDocument) => {
		const issues = [...collectHelidonDiagnostics(document), ...collectHelidonJavaDiagnostics(document)];
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

	const clearMetadataRetry = () => {
		if (!metadataRetryTimer) {
			return;
		}

		clearTimeout(metadataRetryTimer);
		metadataRetryTimer = undefined;
	};

	const scheduleMetadataRetry = (reason: string) => {
		if (metadataBootstrapComplete || metadataRetryTimer || metadataRetryAttempts >= INITIAL_METADATA_MAX_ATTEMPTS) {
			return;
		}

		metadataRetryAttempts += 1;
		output.appendLine(
			`Scheduling Helidon metadata retry ${metadataRetryAttempts}/${INITIAL_METADATA_MAX_ATTEMPTS}: ${reason}`
		);
		metadataRetryTimer = setTimeout(() => {
			metadataRetryTimer = undefined;
			void refreshMetadataFromJavaClasspaths();
		}, INITIAL_METADATA_RETRY_DELAY_MS);
	};

	let javaClasspathWatcherRegistered = false;
	const refreshMetadataFromJavaClasspaths = async () => {
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		output.appendLine(`Refreshing Helidon metadata for ${workspaceFolders.length} workspace folder(s).`);
		replaceHelidonConfigProperties([]);
		if (workspaceFolders.length === 0) {
			output.appendLine('No workspace folders are open.');
			refreshAllDiagnostics();
			return;
		}

		const javaApi = await getJavaExtensionApi();
		if (!javaApi) {
			output.appendLine('Java extension API is unavailable.');
			refreshAllDiagnostics();
			if (!hasJavaExtensionInstalled()) {
				await showMissingJavaExtensionWarning();
			} else {
				if (!metadataBootstrapComplete) {
					scheduleMetadataRetry('Java extension API is not ready yet.');
				}
				if (metadataRetryAttempts >= INITIAL_METADATA_MAX_ATTEMPTS) {
					await showMetadataUnavailableWarning(
						'Language Support for Java by Red Hat is installed, but its project API is not available yet. Open a Java workspace and wait for initialization to finish.'
					);
				}
			}
			return;
		}

		const classpathMetadata = await loadHelidonConfigMetadataFromJavaClasspaths(javaApi, workspaceFolders);
		output.appendLine(`Loaded ${classpathMetadata.length} Helidon metadata entries from Java classpaths.`);
		replaceHelidonConfigProperties(classpathMetadata);
		refreshAllDiagnostics();

		if (classpathMetadata.length > 0) {
			metadataBootstrapComplete = true;
			clearMetadataRetry();
		} else if (!metadataBootstrapComplete) {
			scheduleMetadataRetry('No Helidon metadata found yet; waiting for Java classpath import to settle.');
		}

		if (classpathMetadata.length === 0 && metadataRetryAttempts >= INITIAL_METADATA_MAX_ATTEMPTS) {
			output.appendLine('No Helidon metadata was found on the current Java classpath.');
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
	void refreshEndpointsView();

	const openDocumentDiagnostics = vscode.workspace.onDidOpenTextDocument(refreshDiagnostics);
	const changeDocumentDiagnostics = vscode.workspace.onDidChangeTextDocument((event) => {
		refreshDiagnostics(event.document);
		if (event.document.languageId === 'java') {
			void refreshEndpointsView();
		}
	});
	const closeDocumentDiagnostics = vscode.workspace.onDidCloseTextDocument((document) => {
		diagnostics.delete(document.uri);
	});
	const workspaceFoldersChanged = vscode.workspace.onDidChangeWorkspaceFolders(() => {
		void refreshMetadataFromJavaClasspaths();
		void refreshEndpointsView();
	});
	const javaFileCreated = vscode.workspace.onDidCreateFiles((event) => {
		if (event.files.some((file) => file.path.endsWith('.java'))) {
			void refreshEndpointsView();
		}
	});
	const javaFileDeleted = vscode.workspace.onDidDeleteFiles((event) => {
		if (event.files.some((file) => file.path.endsWith('.java'))) {
			void refreshEndpointsView();
		}
	});
	const javaFileRenamed = vscode.workspace.onDidRenameFiles((event) => {
		if (
			event.files.some(
				(file) => file.oldUri.path.endsWith('.java') || file.newUri.path.endsWith('.java')
			)
		) {
			void refreshEndpointsView();
		}
	});

	context.subscriptions.push(
		diagnostics,
		output,
		endpointsView,
		new vscode.Disposable(clearMetadataRetry),
		completionProvider,
		yamlCompletionProvider,
		javaCompletionProvider,
		hoverProvider,
		javaHoverProvider,
		placeholderDefinitionProvider,
		javaDefinitionProvider,
		endpointCodeLensProvider,
		pathParameterDefinitionProvider,
		codeActionProvider,
		generateProjectCommand,
		generateProjectCliWizardCommand,
		generateRunFilesCommand,
		reloadExtensionCommand,
		openEndpointCommand,
		refreshEndpointsCommand,
		openDocumentDiagnostics,
		changeDocumentDiagnostics,
		closeDocumentDiagnostics,
		workspaceFoldersChanged,
		javaFileCreated,
		javaFileDeleted,
		javaFileRenamed,
	);

	void refreshMetadataFromJavaClasspaths();
}

export function deactivate() {}
