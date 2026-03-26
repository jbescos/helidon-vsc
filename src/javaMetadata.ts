import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import JSZip = require('jszip');
import * as vscode from 'vscode';
import {
	type HelidonConfigProperty,
	mergeHelidonConfigMetadata,
	parseHelidonConfigMetadata,
} from './metadata';

const HELIDON_METADATA_ENTRY_PATH = 'META-INF/helidon/config-metadata.json';
const JAVA_EXECUTE_WORKSPACE_COMMAND = 'java.execute.workspaceCommand';
const JAVA_GET_CLASSPATHS_COMMAND = 'java.project.getClasspaths';
const HELIDON_CLASSPATH_PROBE_FILE_PATTERN =
	/^(?:application\.properties|application(?:-[^/]+)?\.yaml|microprofile-config(?:-[^/]+)?\.properties)$/u;

interface JavaClasspaths {
	classpaths: string[];
	modulepaths: string[];
}

export interface JavaExtensionApi {
	serverReady(): Promise<void>;
	getClasspaths(uri: string, options: { scope: 'runtime' | 'test' }): Promise<JavaClasspaths>;
	onDidClasspathUpdate?(listener: (uri: vscode.Uri) => void): vscode.Disposable;
}

interface JavaExtensionApiContainer {
	getApiInstance?(): unknown;
	apiManager?: {
		getApiInstance?(): unknown;
	};
}

interface JavaWorkspaceCommandDependencies {
	getExtension?: () => Pick<vscode.Extension<unknown>, 'activate'> | undefined;
	executeCommand?: <T>(command: string, ...args: unknown[]) => Thenable<T | undefined>;
}

function isJavaExtensionApi(value: unknown): value is JavaExtensionApi {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Partial<JavaExtensionApi>;
	return typeof candidate.serverReady === 'function' && typeof candidate.getClasspaths === 'function';
}

function getJavaExtensionApiFromContainer(value: unknown): JavaExtensionApi | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as JavaExtensionApiContainer;
	const directApi = candidate.getApiInstance?.();
	if (isJavaExtensionApi(directApi)) {
		return directApi;
	}

	const apiManagerApi = candidate.apiManager?.getApiInstance?.();
	if (isJavaExtensionApi(apiManagerApi)) {
		return apiManagerApi;
	}

	return undefined;
}

async function resolveActivatedJavaExtensionApi(
	getExtension: () => Pick<vscode.Extension<unknown>, 'activate'> | undefined = () =>
		vscode.extensions.getExtension('redhat.java'),
): Promise<JavaExtensionApi | undefined> {
	const extension = getExtension();
	if (!extension) {
		return undefined;
	}

	const activated = await extension.activate();
	if (isJavaExtensionApi(activated)) {
		return activated;
	}

	return getJavaExtensionApiFromContainer(activated);
}

function defaultJavaWorkspaceCommandExecutor<T>(command: string, ...args: unknown[]): Thenable<T | undefined> {
	return vscode.commands.executeCommand<T>(command, ...args);
}

function createCommandBackedJavaApi(): JavaExtensionApi {
	return {
		async serverReady() {
			return;
		},
		async getClasspaths(uri: string, options: { scope: 'runtime' | 'test' }) {
			const result = await executeJavaWorkspaceCommand<JavaClasspaths>(
				JAVA_GET_CLASSPATHS_COMMAND,
				[uri, JSON.stringify(options)],
				{
					getExtension: () => undefined,
				}
			);

			return result ?? { classpaths: [], modulepaths: [] };
		},
	};
}

function normalizeClasspathEntry(entry: string): string {
	if (entry.startsWith('file:')) {
		return vscode.Uri.parse(entry).fsPath;
	}

	return entry;
}

async function readMetadataFromDirectory(classpathEntry: string): Promise<HelidonConfigProperty[]> {
	const metadataPath = path.join(classpathEntry, HELIDON_METADATA_ENTRY_PATH);
	try {
		const jsonText = await fs.readFile(metadataPath, 'utf8');
		return parseHelidonConfigMetadata(jsonText);
	} catch {
		return [];
	}
}

async function readMetadataFromArchive(classpathEntry: string): Promise<HelidonConfigProperty[]> {
	try {
		const archiveBuffer = await fs.readFile(classpathEntry);
		const archive = await JSZip.loadAsync(archiveBuffer);
		const metadataEntry = archive.file(HELIDON_METADATA_ENTRY_PATH);
		if (!metadataEntry) {
			return [];
		}

		return parseHelidonConfigMetadata(await metadataEntry.async('string'));
	} catch {
		return [];
	}
}

async function readMetadataFromClasspathEntry(classpathEntry: string): Promise<HelidonConfigProperty[]> {
	try {
		const stats = await fs.stat(classpathEntry);
		if (stats.isDirectory()) {
			return readMetadataFromDirectory(classpathEntry);
		}

		if (stats.isFile() && classpathEntry.toLowerCase().endsWith('.jar')) {
			return readMetadataFromArchive(classpathEntry);
		}
	} catch {
		return [];
	}

	return [];
}

export async function getJavaExtensionApi(): Promise<JavaExtensionApi | undefined> {
	if (!hasJavaExtensionInstalled()) {
		return undefined;
	}

	const activatedApi = await resolveActivatedJavaExtensionApi();
	if (activatedApi) {
		return activatedApi;
	}

	return createCommandBackedJavaApi();
}

export function hasJavaExtensionInstalled(): boolean {
	return vscode.extensions.getExtension('redhat.java') !== undefined;
}

export async function executeJavaWorkspaceCommand<T>(
	workspaceCommand: string,
	argumentsList: readonly unknown[] = [],
	dependencies: JavaWorkspaceCommandDependencies = {},
): Promise<T | undefined> {
	const javaApi = await resolveActivatedJavaExtensionApi(dependencies.getExtension);
	if (javaApi) {
		await javaApi.serverReady();
	}

	const executeCommand = dependencies.executeCommand ?? defaultJavaWorkspaceCommandExecutor;
	return executeCommand<T>(JAVA_EXECUTE_WORKSPACE_COMMAND, workspaceCommand, ...argumentsList);
}

async function findClasspathProbeUris(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
	const probeUris: vscode.Uri[] = [];
	const queue: string[] = [folder.uri.fsPath];
	const skippedDirectories = new Set(['.git', '.gradle', '.idea', '.mvn', '.settings', 'node_modules', 'target']);

	while (queue.length > 0 && probeUris.length < 4) {
		const currentPath = queue.shift();
		if (!currentPath) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await fs.readdir(currentPath, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = path.join(currentPath, entry.name);
			if (entry.isDirectory()) {
				if (!skippedDirectories.has(entry.name)) {
					queue.push(entryPath);
				}
				continue;
			}

			if (entry.isFile()) {
				if (entry.name.endsWith('.java') || HELIDON_CLASSPATH_PROBE_FILE_PATTERN.test(entry.name)) {
					probeUris.push(vscode.Uri.file(entryPath));
					if (probeUris.length >= 4) {
						break;
					}
				}
			}
		}
	}

	return probeUris;
}

export async function loadHelidonConfigMetadataFromJavaClasspaths(
	api: JavaExtensionApi,
	workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<HelidonConfigProperty[]> {
	if (workspaceFolders.length === 0) {
		return [];
	}

	await api.serverReady();

	const classpathEntries = new Set<string>();
	for (const folder of workspaceFolders) {
		let resolvedAnyClasspath = false;
		const probeUris = [folder.uri, ...(await findClasspathProbeUris(folder))];
		let lastError: unknown;
		for (const probeUri of probeUris) {
			try {
				const { classpaths, modulepaths } = await api.getClasspaths(probeUri.toString(), { scope: 'runtime' });
				for (const entry of [...classpaths, ...modulepaths]) {
					classpathEntries.add(normalizeClasspathEntry(entry));
				}
				if (classpaths.length > 0 || modulepaths.length > 0) {
					resolvedAnyClasspath = true;
				}
			} catch (error) {
				lastError = error;
			}
		}
		if (!resolvedAnyClasspath && lastError) {
			console.warn(`Failed to resolve Java classpaths for ${folder.uri.toString()}.`, lastError);
		}
	}

	let metadata: HelidonConfigProperty[] = [];
	for (const entry of classpathEntries) {
		metadata = mergeHelidonConfigMetadata(metadata, await readMetadataFromClasspathEntry(entry));
	}

	return metadata;
}
