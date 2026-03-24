import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface GenerateProjectOptions {
	targetDirectory: string;
	groupId: string;
	artifactId: string;
	packageName: string;
	archetypeArtifactId: string;
	version: string;
}

const ARCHETYPES = [
	{ label: 'Helidon Quickstart SE', value: 'helidon-quickstart-se' },
	{ label: 'Helidon Quickstart MP', value: 'helidon-quickstart-mp' },
	{ label: 'Helidon Bare SE', value: 'helidon-bare-se' },
];

async function promptForOptions(): Promise<GenerateProjectOptions | undefined> {
	const folderPick = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: 'Select target directory for the new Helidon project',
	});
	if (!folderPick || folderPick.length === 0) {
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

	const archetype = await vscode.window.showQuickPick(ARCHETYPES, {
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
		targetDirectory: folderPick[0].fsPath,
		groupId,
		artifactId,
		packageName,
		archetypeArtifactId: archetype.value,
		version,
	};
}

export async function generateHelidonProject(): Promise<void> {
	const options = await promptForOptions();
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

	const commandArgs = [
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

	vscode.window.showInformationMessage(`Generating Helidon project ${options.artifactId}...`);

	try {
		await execFileAsync('mvn', commandArgs, { cwd: options.targetDirectory });
		const uri = vscode.Uri.file(projectDir);
		await vscode.commands.executeCommand('vscode.openFolder', uri, true);
		vscode.window.showInformationMessage(`Helidon project created at ${projectDir}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Failed to generate Helidon project: ${message}`);
	}
}
