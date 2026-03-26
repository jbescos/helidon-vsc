import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const HELIDON_BUILD_TASK_LABEL = 'helidon: build';
const HELIDON_RUN_TASK_LABEL = 'helidon: run';
export const HELIDON_LAUNCH_CONFIGURATION_NAME = 'Launch Helidon Application';
const HELIDON_LAUNCH_CONFIGURATION_MARKER = 'helidon-vsc';
const HELIDON_MICROPROFILE_MAIN_CLASS = 'io.helidon.Main';
const HELIDON_CLI_COMMAND = 'helidon';
const HELIDON_CLI_INIT_COMMAND = 'helidon init';
const HELIDON_CLI_WIZARD_TERMINAL_NAME = 'Helidon CLI Wizard';
const HELIDON_CLI_DOCS_URI = vscode.Uri.parse('https://helidon.io/docs/latest/about/cli');
const JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug';

interface GenerateProjectOptions {
	targetDirectory: string;
	groupId: string;
	artifactId: string;
	packageName: string;
	archetypeArtifactId: string;
	version: string;
}

interface LaunchJson {
	version: string;
	configurations: vscode.DebugConfiguration[];
}

interface TasksJson {
	version: string;
	tasks: Array<Record<string, unknown>>;
}

type HelidonBuildTool = 'maven' | 'gradle';
type WorkspaceTarget = unknown;

interface ProjectGenerationModePick extends vscode.QuickPickItem {
	mode?: 'cli-wizard' | 'maven-archetype';
}

interface HelidonRunSupport {
	workspaceFolder: vscode.WorkspaceFolder;
	workspacePath: string;
	buildTool: HelidonBuildTool;
	mainClass: string;
	buildTask: Record<string, unknown>;
	runTask: Record<string, unknown>;
	launchConfiguration: vscode.DebugConfiguration;
}

export const LEGACY_ARCHETYPES = [
	{ label: 'Helidon Quickstart SE', value: 'helidon-quickstart-se' },
	{ label: 'Helidon Quickstart MP', value: 'helidon-quickstart-mp' },
	{ label: 'Helidon Bare SE', value: 'helidon-bare-se' },
	{ label: 'Helidon Bare MP', value: 'helidon-bare-mp' },
	{ label: 'Helidon Database SE', value: 'helidon-database-se' },
	{ label: 'Helidon Database MP', value: 'helidon-database-mp' },
] as const;

function stripJsonComments(jsonText: string): string {
	let result = '';
	let inString = false;
	let inSingleLineComment = false;
	let inMultiLineComment = false;
	let escaped = false;

	for (let index = 0; index < jsonText.length; index += 1) {
		const character = jsonText[index];
		const nextCharacter = jsonText[index + 1];
		if (inSingleLineComment) {
			if (character === '\n' || character === '\r') {
				inSingleLineComment = false;
				result += character;
			}
			continue;
		}

		if (inMultiLineComment) {
			if (character === '*' && nextCharacter === '/') {
				inMultiLineComment = false;
				index += 1;
				continue;
			}
			if (character === '\n' || character === '\r') {
				result += character;
			}
			continue;
		}

		if (inString) {
			result += character;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\') {
				escaped = true;
				continue;
			}
			if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			result += character;
			continue;
		}

		if (character === '/' && nextCharacter === '/') {
			inSingleLineComment = true;
			index += 1;
			continue;
		}

		if (character === '/' && nextCharacter === '*') {
			inMultiLineComment = true;
			index += 1;
			continue;
		}

		result += character;
	}

	return result;
}

function stripTrailingCommas(jsonText: string): string {
	let result = '';
	let inString = false;
	let escaped = false;

	for (let index = 0; index < jsonText.length; index += 1) {
		const character = jsonText[index];
		if (inString) {
			result += character;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\') {
				escaped = true;
				continue;
			}
			if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			result += character;
			continue;
		}

		if (character === ',') {
			let lookahead = index + 1;
			while (lookahead < jsonText.length && /\s/u.test(jsonText[lookahead])) {
				lookahead += 1;
			}
			if (jsonText[lookahead] === '}' || jsonText[lookahead] === ']') {
				continue;
			}
		}

		result += character;
	}

	return result;
}

export function parseJsonWithComments<T>(jsonText: string, fallback: T): T {
	const normalizedText = jsonText.replace(/^\uFEFF/u, '');
	try {
		return JSON.parse(normalizedText) as T;
	} catch {
		try {
			return JSON.parse(stripTrailingCommas(stripJsonComments(normalizedText))) as T;
		} catch {
			return fallback;
		}
	}
}

async function promptForTargetDirectory(openLabel: string): Promise<string | undefined> {
	const folderPick = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel,
	});
	if (!folderPick || folderPick.length === 0) {
		return undefined;
	}

	return folderPick[0].fsPath;
}

async function promptForLegacyGeneratorOptions(): Promise<GenerateProjectOptions | undefined> {
	const targetDirectory = await promptForTargetDirectory('Select target directory for the new Helidon project');
	if (!targetDirectory) {
		return undefined;
	}

	const groupId = await vscode.window.showInputBox({
		prompt: 'Maven groupId',
		value: 'com.example',
		ignoreFocusOut: true,
		validateInput: (value) => value.trim().length === 0 ? 'groupId is required' : undefined,
	});
	if (!groupId) {
		return undefined;
	}

	const artifactId = await vscode.window.showInputBox({
		prompt: 'Maven artifactId',
		value: 'demo-helidon',
		ignoreFocusOut: true,
		validateInput: (value) => value.trim().length === 0 ? 'artifactId is required' : undefined,
	});
	if (!artifactId) {
		return undefined;
	}

	const packageName = await vscode.window.showInputBox({
		prompt: 'Base package name',
		value: `${groupId}.${artifactId.replace(/[^a-zA-Z0-9]+/g, '')}`,
		ignoreFocusOut: true,
		validateInput: (value) => value.trim().length === 0 ? 'package name is required' : undefined,
	});
	if (!packageName) {
		return undefined;
	}

	const archetype = await vscode.window.showQuickPick(LEGACY_ARCHETYPES, {
		placeHolder: 'Choose a Helidon archetype',
		ignoreFocusOut: true,
	});
	if (!archetype) {
		return undefined;
	}

	const version = await vscode.window.showInputBox({
		prompt: 'Helidon archetype version',
		value: '4.4.0',
		ignoreFocusOut: true,
		validateInput: (value) => value.trim().length === 0 ? 'version is required' : undefined,
	});
	if (!version) {
		return undefined;
	}

	return {
		targetDirectory,
		groupId,
		artifactId,
		packageName,
		archetypeArtifactId: archetype.value,
		version,
	};
}

async function isHelidonCliAvailable(): Promise<boolean> {
	try {
		await execFileAsync(HELIDON_CLI_COMMAND, ['version']);
		return true;
	} catch {
		return false;
	}
}

export function buildProjectGenerationModePicks(cliAvailable: boolean): ProjectGenerationModePick[] {
	if (!cliAvailable) {
		return [
			{
				label: 'Helidon CLI Wizard (disabled: helidon not found on PATH)',
				kind: vscode.QuickPickItemKind.Separator,
			},
			{
				label: 'Maven Archetype Generator',
				detail:
					'Uses the built-in fallback generator with the legacy Helidon archetypes available from Maven Central.',
				mode: 'maven-archetype',
			},
		];
	}

	return [
		{
			label: 'Helidon CLI Wizard',
			description: 'Recommended',
			detail:
				'Uses `helidon init` for richer QuickStart/Database/Custom/OCI generation and Helidon-managed feature selection.',
			mode: 'cli-wizard',
		},
		{
			label: 'Maven Archetype Generator',
			detail:
				'Uses the built-in fallback generator with the legacy Helidon archetypes available from Maven Central.',
			mode: 'maven-archetype',
		},
	];
}

async function promptForProjectGenerationMode(cliAvailable: boolean): Promise<ProjectGenerationModePick | undefined> {
	return vscode.window.showQuickPick<ProjectGenerationModePick>(
		buildProjectGenerationModePicks(cliAvailable),
		{
			placeHolder: cliAvailable
				? 'Choose how to generate the Helidon project'
				: 'Helidon CLI Wizard is unavailable because `helidon` was not found on PATH. Choose the Maven fallback or install the CLI.',
			ignoreFocusOut: true,
		}
	);
}

async function openHelidonCliDocs(): Promise<void> {
	await vscode.env.openExternal(HELIDON_CLI_DOCS_URI);
}

function createHelidonCliWizardTerminal(targetDirectory: string): vscode.Terminal {
	return vscode.window.createTerminal({
		name: HELIDON_CLI_WIZARD_TERMINAL_NAME,
		cwd: targetDirectory,
	});
}

async function showHelidonCliUnavailableMessage(): Promise<'fallback' | 'docs' | undefined> {
	const action = await vscode.window.showWarningMessage(
		'Helidon CLI was not found on PATH. Install it to use the richer project wizard, or use the built-in Maven archetype generator instead.',
		'Use Maven Archetype Generator',
		'Open Helidon CLI Docs'
	);

	if (action === 'Use Maven Archetype Generator') {
		return 'fallback';
	}

	if (action === 'Open Helidon CLI Docs') {
		await openHelidonCliDocs();
		return 'docs';
	}

	return undefined;
}

export function buildLegacyMavenGenerateArgs(options: GenerateProjectOptions): string[] {
	return [
		'archetype:generate',
		'-B',
		`-DarchetypeGroupId=io.helidon.archetypes`,
		`-DarchetypeArtifactId=${options.archetypeArtifactId}`,
		`-DarchetypeVersion=${options.version}`,
		`-DgroupId=${options.groupId}`,
		`-DartifactId=${options.artifactId}`,
		`-Dpackage=${options.packageName}`,
		'-DinteractiveMode=false',
	];
}

async function generateHelidonProjectWithMavenArchetype(): Promise<void> {
	const options = await promptForLegacyGeneratorOptions();
	if (!options) {
		return;
	}

	const projectDir = path.join(options.targetDirectory, options.artifactId);
	try {
		await fs.access(projectDir);
		vscode.window.showErrorMessage(`Target directory already exists: ${projectDir}`);
		return;
	} catch {
		// directory does not exist yet
	}

	vscode.window.showInformationMessage(`Generating Helidon project ${options.artifactId}...`);

	try {
		await execFileAsync('mvn', buildLegacyMavenGenerateArgs(options), { cwd: options.targetDirectory });
		const uri = vscode.Uri.file(projectDir);
		await vscode.commands.executeCommand('vscode.openFolder', uri, true);
		vscode.window.showInformationMessage(`Helidon project created at ${projectDir}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to generate Helidon project: ${message}`);
	}
}

export async function generateHelidonProjectWithCliWizard(): Promise<void> {
	if (!(await isHelidonCliAvailable())) {
		const action = await showHelidonCliUnavailableMessage();
		if (action === 'fallback') {
			await generateHelidonProjectWithMavenArchetype();
		}
		return;
	}

	const targetDirectory = await promptForTargetDirectory(
		'Select the directory where the Helidon CLI wizard should create the new project'
	);
	if (!targetDirectory) {
		return;
	}

	const terminal = createHelidonCliWizardTerminal(targetDirectory);
	terminal.show(true);
	terminal.sendText(HELIDON_CLI_INIT_COMMAND);

	vscode.window.showInformationMessage(
		'Started `helidon init` in an integrated terminal. Use the Helidon CLI prompts to choose archetype and features, then open the generated project folder in VS Code.'
	);
}

async function pickWorkspaceFolder(actionDescription: string): Promise<vscode.WorkspaceFolder | undefined> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length === 0) {
		vscode.window.showWarningMessage(`Open a Helidon workspace folder before ${actionDescription}.`);
		return undefined;
	}

	if (workspaceFolders.length === 1) {
		return workspaceFolders[0];
	}

	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri) {
		const activeWorkspaceFolder = vscode.workspace.getWorkspaceFolder(activeUri);
		if (activeWorkspaceFolder) {
			return activeWorkspaceFolder;
		}
	}

	const selected = await vscode.window.showWorkspaceFolderPick({
		placeHolder: `Select the Helidon workspace folder to ${actionDescription}`,
	});
	return selected ?? undefined;
}

function isWorkspaceFolderTarget(target: WorkspaceTarget): target is vscode.WorkspaceFolder {
	return (
		typeof target === 'object' &&
		target !== null &&
		'uri' in target &&
		target.uri instanceof vscode.Uri &&
		'name' in target &&
		typeof target.name === 'string' &&
		'index' in target &&
		typeof target.index === 'number'
	);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function extractWorkspaceUriFromTarget(target: WorkspaceTarget): vscode.Uri | undefined {
	if (target instanceof vscode.Uri) {
		return target;
	}

	if (!isObjectRecord(target)) {
		return undefined;
	}

	const directCandidates = [target.resourceUri, target.uri];
	for (const candidate of directCandidates) {
		if (candidate instanceof vscode.Uri) {
			return candidate;
		}
	}

	const nestedCandidates = [target.endpoint, target.group];
	for (const candidate of nestedCandidates) {
		if (!isObjectRecord(candidate)) {
			continue;
		}

		const uri = candidate.uri;
		if (uri instanceof vscode.Uri) {
			return uri;
		}
	}

	return undefined;
}

async function resolveWorkspaceFolder(
	target: WorkspaceTarget | undefined,
	actionDescription: string
): Promise<vscode.WorkspaceFolder | undefined> {
	if (target !== undefined) {
		if (isWorkspaceFolderTarget(target)) {
			return target;
		}

		const uriTarget = extractWorkspaceUriFromTarget(target);
		if (uriTarget) {
			const workspaceFolder = vscode.workspace.getWorkspaceFolder(uriTarget);
			if (workspaceFolder) {
				return workspaceFolder;
			}

			vscode.window.showWarningMessage(
				'The selected folder is not an open VS Code workspace folder. Open it as a workspace folder to use Helidon run/debug actions from Explorer.'
			);
			return undefined;
		}
	}

	return pickWorkspaceFolder(actionDescription);
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function detectBuildTool(workspacePath: string): Promise<HelidonBuildTool | undefined> {
	if (await pathExists(path.join(workspacePath, 'pom.xml'))) {
		return 'maven';
	}

	if (
		(await pathExists(path.join(workspacePath, 'build.gradle'))) ||
		(await pathExists(path.join(workspacePath, 'build.gradle.kts')))
	) {
		return 'gradle';
	}

	return undefined;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch {
		return undefined;
	}
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return parseJsonWithComments(await fs.readFile(filePath, 'utf8'), fallback);
	} catch {
		return fallback;
	}
}

export async function resolveGradleCommand(
	workspacePath: string,
	platform: NodeJS.Platform = process.platform
): Promise<string> {
	const wrapperFileName = platform === 'win32' ? 'gradlew.bat' : 'gradlew';
	if (await pathExists(path.join(workspacePath, wrapperFileName))) {
		return platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
	}

	return 'gradle';
}

function upsertNamedEntry<T extends Record<string, unknown>>(
	entries: T[],
	entryKey: 'label' | 'name',
	entry: T,
): T[] {
	const existingIndex = entries.findIndex((candidate) => candidate[entryKey] === entry[entryKey]);
	if (existingIndex === -1) {
		return [...entries, entry];
	}

	const nextEntries = [...entries];
	nextEntries[existingIndex] = {
		...nextEntries[existingIndex],
		...entry,
	};
	return nextEntries;
}

async function findMainClass(workspacePath: string): Promise<string | undefined> {
	const files = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspacePath, '**/*.java'),
		'**/{.git,.gradle,.idea,node_modules,target}/**',
		50
	);

	for (const file of files) {
		try {
			const source = await fs.readFile(file.fsPath, 'utf8');
			if (!/\bstatic\s+void\s+main\s*\(/u.test(source)) {
				continue;
			}

			const packageName = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/mu.exec(source)?.[1];
			const className = /\bclass\s+([A-Za-z_]\w*)\b/u.exec(source)?.[1];
			if (!className) {
				continue;
			}

			return packageName ? `${packageName}.${className}` : className;
		} catch {
			// ignore unreadable source files
		}
	}

	return undefined;
}

export async function isLikelyHelidonMicroProfileProject(workspacePath: string): Promise<boolean> {
	if (await pathExists(path.join(workspacePath, 'src', 'main', 'resources', 'META-INF', 'microprofile-config.properties'))) {
		return true;
	}

	const microProfilePattern =
		/helidon-microprofile|<artifactId>\s*helidon-mp\s*<\/artifactId>|io\.helidon\.microprofile/u;
	for (const buildFileName of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
		const contents = await readFileIfExists(path.join(workspacePath, buildFileName));
		if (contents && microProfilePattern.test(contents)) {
			return true;
		}
	}

	return false;
}

export function resolveHelidonLaunchMainClass(
	discoveredMainClass: string | undefined,
	isMicroProfileProject: boolean
): string | undefined {
	if (discoveredMainClass) {
		return discoveredMainClass;
	}

	return isMicroProfileProject ? HELIDON_MICROPROFILE_MAIN_CLASS : undefined;
}

async function detectHelidonLaunchMainClass(workspacePath: string): Promise<string | undefined> {
	const discoveredMainClass = await findMainClass(workspacePath);
	const isMicroProfileProject = await isLikelyHelidonMicroProfileProject(workspacePath);
	return resolveHelidonLaunchMainClass(discoveredMainClass, isMicroProfileProject);
}

export function buildHelidonBuildTask(
	buildTool: HelidonBuildTool,
	gradleCommand = 'gradle'
): Record<string, unknown> {
	return buildTool === 'maven'
		? {
				label: HELIDON_BUILD_TASK_LABEL,
				type: 'shell',
				command: 'mvn',
				args: ['package'],
				group: 'build',
				problemMatcher: [],
			}
			: {
					label: HELIDON_BUILD_TASK_LABEL,
					type: 'shell',
					command: gradleCommand,
					args: ['build'],
					group: 'build',
					problemMatcher: [],
				};
}

export function buildHelidonRunTask(
	buildTool: HelidonBuildTool,
	mainClass: string,
	gradleCommand = 'gradle'
): Record<string, unknown> {
	return buildTool === 'maven'
		? {
				label: HELIDON_RUN_TASK_LABEL,
				type: 'shell',
				command: 'mvn',
				args: ['compile', 'org.codehaus.mojo:exec-maven-plugin:3.6.2:java', `-Dexec.mainClass=${mainClass}`],
				problemMatcher: [],
			}
			: {
					label: HELIDON_RUN_TASK_LABEL,
					type: 'shell',
					command: gradleCommand,
					args: ['run'],
					problemMatcher: [],
				};
}

export function buildHelidonLaunchConfiguration(mainClass: string): vscode.DebugConfiguration {
	return {
		type: 'java',
		name: HELIDON_LAUNCH_CONFIGURATION_NAME,
		request: 'launch',
		mainClass,
		helidonVscManaged: HELIDON_LAUNCH_CONFIGURATION_MARKER,
		cwd: '${workspaceFolder}',
		console: 'integratedTerminal',
		preLaunchTask: HELIDON_BUILD_TASK_LABEL,
	};
}

export function isHelidonDebugSession(
	session: Pick<vscode.DebugSession, 'type' | 'name' | 'configuration'>
): boolean {
	return (
		session.type === 'java' &&
		(session.configuration.helidonVscManaged === HELIDON_LAUNCH_CONFIGURATION_MARKER ||
			session.name === HELIDON_LAUNCH_CONFIGURATION_NAME ||
			session.configuration.name === HELIDON_LAUNCH_CONFIGURATION_NAME)
	);
}

export function isHelidonTaskExecution(execution: Pick<vscode.TaskExecution, 'task'>): boolean {
	return execution.task.name === HELIDON_RUN_TASK_LABEL || execution.task.name === HELIDON_BUILD_TASK_LABEL;
}

function hasJavaDebugExtensionInstalled(): boolean {
	return vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID) !== undefined;
}

async function showMissingJavaDebugExtensionWarning(): Promise<void> {
	const action = await vscode.window.showWarningMessage(
		'Helidon run/debug commands require Java Debugger support from Extension Pack for Java.',
		'Install Extension Pack for Java'
	);
	if (action === 'Install Extension Pack for Java') {
		await vscode.commands.executeCommand('workbench.extensions.search', 'vscjava.vscode-java-pack');
	}
}

async function prepareHelidonRunSupport(workspaceFolder: vscode.WorkspaceFolder): Promise<HelidonRunSupport | undefined> {
	const workspacePath = workspaceFolder.uri.fsPath;
	const buildTool = await detectBuildTool(workspacePath);
	if (!buildTool) {
		vscode.window.showWarningMessage(
			'Could not detect Maven or Gradle build files in the selected workspace folder.'
		);
		return undefined;
	}

	const mainClass = await detectHelidonLaunchMainClass(workspacePath);
	if (!mainClass) {
		vscode.window.showWarningMessage(
			'Could not resolve a Helidon launch main class in the selected workspace folder.'
		);
		return undefined;
	}

	const gradleCommand = buildTool === 'gradle' ? await resolveGradleCommand(workspacePath) : undefined;

	return {
		workspaceFolder,
		workspacePath,
		buildTool,
		mainClass,
		buildTask: buildHelidonBuildTask(buildTool, gradleCommand),
		runTask: buildHelidonRunTask(buildTool, mainClass, gradleCommand),
		launchConfiguration: buildHelidonLaunchConfiguration(mainClass),
	};
}

async function writeHelidonRunFiles(runSupport: HelidonRunSupport): Promise<string> {
	const vscodeDir = path.join(runSupport.workspacePath, '.vscode');
	await fs.mkdir(vscodeDir, { recursive: true });

	const launchJsonPath = path.join(vscodeDir, 'launch.json');
	const tasksJsonPath = path.join(vscodeDir, 'tasks.json');

	const launchJson = await readJsonFile<LaunchJson>(launchJsonPath, {
		version: '0.2.0',
		configurations: [],
	});
	launchJson.configurations = upsertNamedEntry(
		launchJson.configurations,
		'name',
		runSupport.launchConfiguration
	);
	await fs.writeFile(launchJsonPath, `${JSON.stringify(launchJson, null, 2)}\n`, 'utf8');

	const tasksJson = await readJsonFile<TasksJson>(tasksJsonPath, {
		version: '2.0.0',
		tasks: [],
	});
	tasksJson.tasks = upsertNamedEntry(tasksJson.tasks, 'label', runSupport.buildTask);
	tasksJson.tasks = upsertNamedEntry(tasksJson.tasks, 'label', runSupport.runTask);
	await fs.writeFile(tasksJsonPath, `${JSON.stringify(tasksJson, null, 2)}\n`, 'utf8');

	return vscodeDir;
}

async function ensureHelidonRunFiles(
	workspaceFolder: vscode.WorkspaceFolder
): Promise<HelidonRunSupport | undefined> {
	const runSupport = await prepareHelidonRunSupport(workspaceFolder);
	if (!runSupport) {
		return undefined;
	}

	await writeHelidonRunFiles(runSupport);
	return runSupport;
}

async function startHelidonProjectDebugSession(
	noDebug: boolean,
	target?: WorkspaceTarget
): Promise<void> {
	if (!hasJavaDebugExtensionInstalled()) {
		await showMissingJavaDebugExtensionWarning();
		return;
	}

	const workspaceFolder = await resolveWorkspaceFolder(
		target,
		noDebug ? 'running the Helidon project' : 'debugging the Helidon project'
	);
	if (!workspaceFolder) {
		return;
	}

	const runSupport = await ensureHelidonRunFiles(workspaceFolder);
	if (!runSupport) {
		return;
	}

	try {
		const started = await vscode.debug.startDebugging(workspaceFolder, runSupport.launchConfiguration, {
			noDebug,
		});
		if (!started) {
			vscode.window.showErrorMessage(`Failed to ${noDebug ? 'run' : 'debug'} the Helidon project.`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to ${noDebug ? 'run' : 'debug'} the Helidon project: ${message}`);
	}
}

export async function generateHelidonProject(): Promise<void> {
	const cliAvailable = await isHelidonCliAvailable();
	const mode = await promptForProjectGenerationMode(cliAvailable);
	if (!mode) {
		return;
	}

	if (mode.mode === 'cli-wizard') {
		await generateHelidonProjectWithCliWizard();
		return;
	}

	await generateHelidonProjectWithMavenArchetype();
}

export async function runHelidonProject(target?: WorkspaceTarget): Promise<void> {
	await startHelidonProjectDebugSession(true, target);
}

export async function debugHelidonProject(target?: WorkspaceTarget): Promise<void> {
	await startHelidonProjectDebugSession(false, target);
}
