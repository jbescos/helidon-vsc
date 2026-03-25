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

interface JavaClasspaths {
	classpaths: string[];
	modulepaths: string[];
}

export interface JavaExtensionApi {
	serverReady(): Promise<void>;
	getClasspaths(uri: string, options: { scope: 'runtime' | 'test' }): Promise<JavaClasspaths>;
	onDidClasspathUpdate?(listener: (uri: vscode.Uri) => void): vscode.Disposable;
}

function isJavaExtensionApi(value: unknown): value is JavaExtensionApi {
	if (!value || typeof value !== 'object') {
		return false;
	}

	const candidate = value as Partial<JavaExtensionApi>;
	return typeof candidate.serverReady === 'function' && typeof candidate.getClasspaths === 'function';
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
	const extension = vscode.extensions.getExtension('redhat.java');
	if (!extension) {
		return undefined;
	}

	const api = await extension.activate();
	if (!isJavaExtensionApi(api)) {
		return undefined;
	}

	return api;
}

export function hasJavaExtensionInstalled(): boolean {
	return vscode.extensions.getExtension('redhat.java') !== undefined;
}

async function findClasspathProbeUris(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
	const probeUris: vscode.Uri[] = [];
	const queue: string[] = [folder.uri.fsPath];
	const skippedDirectories = new Set(['.git', '.gradle', '.idea', '.mvn', '.settings', 'node_modules', 'target']);
	const wantedFiles = new Set([
		'microprofile-config.properties',
		'application.properties',
		'application.yaml',
		'application.yml',
	]);

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
				if (entry.name.endsWith('.java') || wantedFiles.has(entry.name)) {
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
