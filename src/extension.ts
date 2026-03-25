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
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
	replaceHelidonConfigProperties,
} from './helidonConfig';
import {
	debugHelidonProject,
	extractWorkspaceUriFromTarget,
	generateHelidonProject,
	isHelidonDebugSession,
	isHelidonTaskExecution,
	runHelidonProject,
} from './generator';
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
const MICROPROFILE_EXTENSION_ID = 'redhat.vscode-microprofile';
const MICROPROFILE_MANAGED_HELIDON_PROPERTIES_PATTERN =
	/(?:^|[\\/])(?:application|microprofile-config)\.properties$/iu;

function hasMicroProfileExtensionInstalled(): boolean {
	return vscode.extensions.getExtension(MICROPROFILE_EXTENSION_ID) !== undefined;
}

export function isMicroProfileManagedHelidonPropertiesFile(fileName: string): boolean {
	return MICROPROFILE_MANAGED_HELIDON_PROPERTIES_PATTERN.test(fileName);
}

export function buildHelidonPropertiesDocumentSelectors(
	hasMicroProfileExtension: boolean,
): vscode.DocumentFilter[] {
	const fileSelectors: vscode.DocumentFilter[] = [
		{ scheme: 'file', pattern: '**/microprofile-config-*.properties' },
	];
	const untitledSelectors: vscode.DocumentFilter[] = [
		{ scheme: 'untitled', pattern: '**/microprofile-config-*.properties' },
	];

	if (hasMicroProfileExtension) {
		return [...fileSelectors, ...untitledSelectors];
	}

	return [
		{ scheme: 'file', pattern: '**/application.properties' },
		{ scheme: 'file', pattern: '**/microprofile-config.properties' },
		...fileSelectors,
		{ scheme: 'untitled', pattern: '**/application.properties' },
		{ scheme: 'untitled', pattern: '**/microprofile-config.properties' },
		...untitledSelectors,
	];
}

export function shouldUseCustomHelidonPropertiesFeatures(
	document: Pick<vscode.TextDocument, 'fileName'>,
	hasMicroProfileExtension: boolean,
): boolean {
	return !hasMicroProfileExtension || !isMicroProfileManagedHelidonPropertiesFile(document.fileName);
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Helidon');
	output.appendLine('Helidon VS Code extension is active.');
	const hasMicroProfileExtension = hasMicroProfileExtensionInstalled();
	output.appendLine(
		hasMicroProfileExtension
			? 'Tools for MicroProfile detected; helidon-vsc defers exact application.properties and microprofile-config.properties to it and keeps Helidon-only properties, YAML, Java, and endpoint features.'
			: 'Tools for MicroProfile is not installed; helidon-vsc registers its full custom properties support.'
	);
	const helidonPropertiesDocumentSelectors = buildHelidonPropertiesDocumentSelectors(hasMicroProfileExtension);
	const runStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	runStatusBarItem.name = 'Helidon Run Project';
	runStatusBarItem.text = '$(run) Helidon';
	runStatusBarItem.tooltip = 'Run the current Helidon project';
	runStatusBarItem.command = 'helidon-vsc.runProject';
	const debugStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
	debugStatusBarItem.name = 'Helidon Debug Project';
	debugStatusBarItem.text = '$(debug) Helidon';
	debugStatusBarItem.tooltip = 'Debug the current Helidon project';
	debugStatusBarItem.command = 'helidon-vsc.debugProject';
	const stopStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	stopStatusBarItem.name = 'Helidon Stop Project';
	stopStatusBarItem.text = '$(debug-stop) Helidon';
	stopStatusBarItem.tooltip = 'Stop the current Helidon project';
	stopStatusBarItem.command = 'helidon-vsc.stopProject';
	const diagnostics = vscode.languages.createDiagnosticCollection('helidon-vsc');
	const endpointsProvider = new HelidonEndpointsTreeDataProvider();
	const endpointsView = vscode.window.createTreeView('helidonEndpoints', {
		treeDataProvider: endpointsProvider,
		showCollapseAll: true,
	});
	const helidonDebugSessions = new Map<string, vscode.DebugSession>();
	let missingJavaExtensionWarningShown = false;
	let metadataUnavailableWarningShown = false;
	let metadataBootstrapComplete = false;
	let metadataRetryAttempts = 0;
	let metadataRetryTimer: ReturnType<typeof setTimeout> | undefined;

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		helidonPropertiesDocumentSelectors,
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
			...helidonPropertiesDocumentSelectors,
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
			...helidonPropertiesDocumentSelectors,
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
			...helidonPropertiesDocumentSelectors,
			{ language: 'yaml', scheme: 'file' },
			{ language: 'yaml', scheme: 'untitled' },
			{ language: 'java', scheme: 'file' },
			{ language: 'java', scheme: 'untitled' },
		],
		new HelidonConfigCodeActionProvider(),
		{
			providedCodeActionKinds: HelidonConfigCodeActionProvider.providedCodeActionKinds,
		}
	);

	const generateProjectCommand = vscode.commands.registerCommand('helidon-vsc.generateProject', async () => {
		await generateHelidonProject();
	});

	const runProjectCommand = vscode.commands.registerCommand(
		'helidon-vsc.runProject',
		async (target?: unknown) => {
			await runHelidonProject(target);
		}
	);

	const debugProjectCommand = vscode.commands.registerCommand(
		'helidon-vsc.debugProject',
		async (target?: unknown) => {
			await debugHelidonProject(target);
		}
	);

	const isWorkspaceFolderTarget = (target: unknown): target is vscode.WorkspaceFolder =>
		typeof target === 'object' &&
		target !== null &&
		'uri' in target &&
		target.uri instanceof vscode.Uri &&
		'name' in target &&
		typeof target.name === 'string' &&
		'index' in target &&
		typeof target.index === 'number';

	const resolveWorkspaceFolderFromTarget = (target: unknown): vscode.WorkspaceFolder | undefined => {
		if (isWorkspaceFolderTarget(target)) {
			return target;
		}

		const uri = extractWorkspaceUriFromTarget(target);
		return uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
	};

	const isWorkspaceFolderScope = (
		scope: vscode.Task['scope']
	): scope is vscode.WorkspaceFolder =>
		typeof scope === 'object' && scope !== null && 'uri' in scope && scope.uri instanceof vscode.Uri;

	const taskExecutionMatchesWorkspaceFolder = (
		execution: vscode.TaskExecution,
		workspaceFolder: vscode.WorkspaceFolder | undefined
	): boolean => {
		if (!workspaceFolder) {
			return true;
		}

		return isWorkspaceFolderScope(execution.task.scope)
			? execution.task.scope.uri.toString() === workspaceFolder.uri.toString()
			: false;
	};

	const stopProjectCommand = vscode.commands.registerCommand(
		'helidon-vsc.stopProject',
		async (target?: unknown) => {
			const targetUri = extractWorkspaceUriFromTarget(target);
			const workspaceFolder = resolveWorkspaceFolderFromTarget(target);
			if (targetUri && !workspaceFolder) {
				await vscode.window.showWarningMessage(
					'The selected folder is not an open VS Code workspace folder. Open it as a workspace folder to use Helidon stop actions from Explorer.'
				);
				return;
			}

			const matchingSessions = [...helidonDebugSessions.values()].filter(
				(session) =>
					!workspaceFolder || session.workspaceFolder?.uri.toString() === workspaceFolder.uri.toString()
			);
			if (matchingSessions.length > 0) {
				for (const session of matchingSessions) {
					await vscode.debug.stopDebugging(session);
				}
				return;
			}

			const matchingTaskExecutions = vscode.tasks.taskExecutions.filter(
				(execution) =>
					isHelidonTaskExecution(execution) &&
					taskExecutionMatchesWorkspaceFolder(execution, workspaceFolder)
			);
			if (matchingTaskExecutions.length > 0) {
				for (const execution of matchingTaskExecutions) {
					execution.terminate();
				}
				return;
			}

			await vscode.window.showInformationMessage(
				workspaceFolder
					? `No active Helidon run/debug session was found in ${workspaceFolder.name}.`
					: 'No active Helidon run/debug session was found.'
			);
		}
	);

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

	const updateStatusBarItems = () => {
		if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
			runStatusBarItem.hide();
			debugStatusBarItem.hide();
			stopStatusBarItem.hide();
			return;
		}

		runStatusBarItem.show();
		debugStatusBarItem.show();
	};

	const updateRunningContext = async () => {
		const hasActiveHelidonExecution =
			helidonDebugSessions.size > 0 ||
			vscode.tasks.taskExecutions.some((execution) => isHelidonTaskExecution(execution));
		await vscode.commands.executeCommand('setContext', 'helidonVsc.canStopProject', hasActiveHelidonExecution);
		if (hasActiveHelidonExecution) {
			stopStatusBarItem.show();
			return;
		}

		stopStatusBarItem.hide();
	};

	const refreshDiagnostics = (document: vscode.TextDocument) => {
		const shouldCollectHelidonDocumentDiagnostics =
			isHelidonYamlDocument(document) ||
			(isHelidonPropertiesDocument(document) &&
				shouldUseCustomHelidonPropertiesFeatures(document, hasMicroProfileExtension));
		const issues = [
			...(shouldCollectHelidonDocumentDiagnostics ? collectHelidonDiagnostics(document) : []),
			...collectHelidonJavaDiagnostics(document),
		];
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
	if (vscode.debug.activeDebugSession && isHelidonDebugSession(vscode.debug.activeDebugSession)) {
		helidonDebugSessions.set(vscode.debug.activeDebugSession.id, vscode.debug.activeDebugSession);
	}
	updateStatusBarItems();
	void updateRunningContext();

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
		updateStatusBarItems();
		void updateRunningContext();
	});
	const debugSessionStarted = vscode.debug.onDidStartDebugSession((session) => {
		if (isHelidonDebugSession(session)) {
			helidonDebugSessions.set(session.id, session);
		}
		void updateRunningContext();
	});
	const debugSessionTerminated = vscode.debug.onDidTerminateDebugSession((session) => {
		helidonDebugSessions.delete(session.id);
		void updateRunningContext();
	});
	const taskStarted = vscode.tasks.onDidStartTask(() => {
		void updateRunningContext();
	});
	const taskEnded = vscode.tasks.onDidEndTask(() => {
		void updateRunningContext();
	});
	const javaFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.java');
	const javaFileChanged = javaFileWatcher.onDidChange(() => {
		void refreshEndpointsView();
	});
	const javaFileCreated = javaFileWatcher.onDidCreate(() => {
		void refreshEndpointsView();
	});
	const javaFileDeleted = javaFileWatcher.onDidDelete(() => {
		void refreshEndpointsView();
	});

	context.subscriptions.push(
		diagnostics,
		output,
		runStatusBarItem,
		debugStatusBarItem,
		stopStatusBarItem,
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
		runProjectCommand,
		debugProjectCommand,
		stopProjectCommand,
		openEndpointCommand,
		openDocumentDiagnostics,
		changeDocumentDiagnostics,
		closeDocumentDiagnostics,
		workspaceFoldersChanged,
		debugSessionStarted,
		debugSessionTerminated,
		taskStarted,
		taskEnded,
		javaFileWatcher,
		javaFileChanged,
		javaFileCreated,
		javaFileDeleted,
	);

	void refreshMetadataFromJavaClasspaths();
}

export function deactivate() {}
