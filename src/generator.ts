import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const HELIDON_BUILD_TASK_LABEL = 'helidon: build';
const HELIDON_RUN_TASK_LABEL = 'helidon: run';
const HELIDON_LAUNCH_CONFIGURATION_NAME = 'Launch Helidon Application';
const HELIDON_CLI_COMMAND = 'helidon';
const HELIDON_CLI_INIT_COMMAND = 'helidon init';
const HELIDON_CLI_WIZARD_TERMINAL_NAME = 'Helidon CLI Wizard';
const HELIDON_CLI_DOCS_URI = vscode.Uri.parse('https://helidon.io/docs/latest/about/cli');

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
	configurations: Array<Record<string, unknown>>;
}

interface TasksJson {
	version: string;
	tasks: Array<Record<string, unknown>>;
}

interface ProjectGenerationModePick extends vscode.QuickPickItem {
	mode?: 'cli-wizard' | 'maven-archetype';
}

export const LEGACY_ARCHETYPES = [
	{ label: 'Helidon Quickstart SE', value: 'helidon-quickstart-se' },
	{ label: 'Helidon Quickstart MP', value: 'helidon-quickstart-mp' },
	{ label: 'Helidon Bare SE', value: 'helidon-bare-se' },
	{ label: 'Helidon Bare MP', value: 'helidon-bare-mp' },
	{ label: 'Helidon Database SE', value: 'helidon-database-se' },
	{ label: 'Helidon Database MP', value: 'helidon-database-mp' },
] as const;

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

async function pickWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
	if (workspaceFolders.length === 0) {
		vscode.window.showWarningMessage('Open a Helidon workspace folder before generating VS Code run files.');
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
		placeHolder: 'Select the Helidon workspace folder for VS Code run files',
	});
	return selected ?? undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function detectBuildTool(workspacePath: string): Promise<'maven' | 'gradle' | undefined> {
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

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch {
		return fallback;
	}
}

function upsertNamedEntry(
	entries: Array<Record<string, unknown>>,
	entryKey: 'label' | 'name',
	entry: Record<string, unknown>,
): Array<Record<string, unknown>> {
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

export async function generateHelidonRunFiles(): Promise<void> {
	const workspaceFolder = await pickWorkspaceFolder();
	if (!workspaceFolder) {
		return;
	}

	const workspacePath = workspaceFolder.uri.fsPath;
	const buildTool = await detectBuildTool(workspacePath);
	if (!buildTool) {
		vscode.window.showWarningMessage(
			'Could not detect Maven or Gradle build files in the selected workspace folder.'
		);
		return;
	}

	const vscodeDir = path.join(workspacePath, '.vscode');
	await fs.mkdir(vscodeDir, { recursive: true });

	const launchJsonPath = path.join(vscodeDir, 'launch.json');
	const tasksJsonPath = path.join(vscodeDir, 'tasks.json');
	const mainClass = (await findMainClass(workspacePath)) ?? 'io.helidon.microprofile.cdi.Main';

	const buildTask =
		buildTool === 'maven'
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
					command: './gradlew',
					args: ['build'],
					group: 'build',
					problemMatcher: [],
				};

	const runTask =
		buildTool === 'maven'
			? {
					label: HELIDON_RUN_TASK_LABEL,
					type: 'shell',
					command: 'mvn',
					args: ['compile', 'exec:java'],
					problemMatcher: [],
				}
			: {
					label: HELIDON_RUN_TASK_LABEL,
					type: 'shell',
					command: './gradlew',
					args: ['run'],
					problemMatcher: [],
				};

	const launchConfiguration: Record<string, unknown> = {
		type: 'java',
		name: HELIDON_LAUNCH_CONFIGURATION_NAME,
		request: 'launch',
		mainClass,
		cwd: '${workspaceFolder}',
		preLaunchTask: HELIDON_BUILD_TASK_LABEL,
	};

	const launchJson = await readJsonFile<LaunchJson>(launchJsonPath, {
		version: '0.2.0',
		configurations: [],
	});
	launchJson.configurations = upsertNamedEntry(launchJson.configurations, 'name', launchConfiguration);
	await fs.writeFile(launchJsonPath, `${JSON.stringify(launchJson, null, 2)}\n`, 'utf8');

	const tasksJson = await readJsonFile<TasksJson>(tasksJsonPath, {
		version: '2.0.0',
		tasks: [],
	});
	tasksJson.tasks = upsertNamedEntry(tasksJson.tasks, 'label', buildTask);
	tasksJson.tasks = upsertNamedEntry(tasksJson.tasks, 'label', runTask);
	await fs.writeFile(tasksJsonPath, `${JSON.stringify(tasksJson, null, 2)}\n`, 'utf8');

	vscode.window.showInformationMessage(`Generated VS Code run files in ${path.join(workspacePath, '.vscode')}`);
}
