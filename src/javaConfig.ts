import * as vscode from 'vscode';
import {
	HELIDON_CONFIG_PROPERTIES,
	findHelidonConfigKeyRanges,
	findHelidonConfigProperty,
	isHelidonPropertiesDocument,
	isHelidonYamlDocument,
	resolveHelidonConfigPropertyKey,
	shouldValidateKnownHelidonConfigRoot,
	type HelidonConfigKeyResolution,
} from './helidonConfig';
import type { HelidonConfigProperty } from './metadata';
import { findJavaConfigReferences } from './javaSource';

const JAVA_CONFIG_KEY_PATTERN = /\.get\s*\(\s*"([^"]*)"/gu;
const CONFIG_FILE_GLOB =
	'**/{application.properties,microprofile-config.properties,microprofile-config-*.properties,application.yaml,application-*.yaml}';
const CONFIG_FILE_EXCLUDE_GLOB = '**/{.git,.gradle,.idea,node_modules,target}/**';

export interface JavaConfigReference {
	key: string;
	start: number;
	end: number;
}

interface CachedJavaConfigReferences {
	references: JavaConfigReference[];
	version: number;
}

const javaConfigReferenceCache = new Map<string, CachedJavaConfigReferences>();

function propertyMarkdown(property: HelidonConfigProperty): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.appendMarkdown(`**${property.key}**\n\n`);
	markdown.appendMarkdown(`${property.description}\n\n`);
	markdown.appendMarkdown(`- Type: \`${property.type}\`\n`);
	if (property.defaultValue) {
		markdown.appendMarkdown(`- Default: \`${property.defaultValue}\`\n`);
	}
	if (property.example) {
		markdown.appendMarkdown(`- Example: \`${property.example}\`\n`);
	}
	markdown.isTrusted = false;
	return markdown;
}

function looksLikeHelidonConfigUsage(source: string): boolean {
	return /\bio\.helidon\.config\.Config\b/u.test(source) || /\bConfig\b/u.test(source);
}

function parseJavaConfigReferencesWithPattern(source: string): JavaConfigReference[] {
	const references: JavaConfigReference[] = [];
	for (const match of source.matchAll(JAVA_CONFIG_KEY_PATTERN)) {
		const key = match[1];
		const matchIndex = match.index ?? -1;
		if (!key || matchIndex === -1) {
			continue;
		}

		const keyOffset = match[0].indexOf(key);
		if (keyOffset === -1) {
			continue;
		}

		references.push({
			key,
			start: matchIndex + keyOffset,
			end: matchIndex + keyOffset + key.length,
		});
	}

	return references;
}

export function parseJavaConfigReferences(source: string): JavaConfigReference[] {
	if (!looksLikeHelidonConfigUsage(source)) {
		return [];
	}

	const astReferences = findJavaConfigReferences(source);
	if (astReferences) {
		return astReferences.map((reference) => ({
			key: reference.value,
			start: reference.start,
			end: reference.end,
		}));
	}

	return parseJavaConfigReferencesWithPattern(source);
}

function referencesForDocument(document: vscode.TextDocument): JavaConfigReference[] {
	const cacheKey = document.uri.toString();
	const cached = javaConfigReferenceCache.get(cacheKey);
	if (cached && cached.version === document.version) {
		return cached.references;
	}

	const references = parseJavaConfigReferences(document.getText());
	javaConfigReferenceCache.set(cacheKey, { references, version: document.version });
	return references;
}

function referenceAtPosition(document: vscode.TextDocument, position: vscode.Position): JavaConfigReference | undefined {
	const offset = document.offsetAt(position);
	return referencesForDocument(document).find((reference) => reference.start <= offset && offset <= reference.end);
}

function completionContext(
	document: vscode.TextDocument,
	position: vscode.Position,
): { prefix: string; range: vscode.Range } | undefined {
	const reference = referenceAtPosition(document, position);
	if (reference) {
		const range = new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end));
		return {
			prefix: document.getText(new vscode.Range(range.start, position)),
			range,
		};
	}

	if (!looksLikeHelidonConfigUsage(document.getText())) {
		return undefined;
	}

	const line = document.lineAt(position.line).text;
	const beforeCursor = line.slice(0, position.character);
	const match = /\.get\s*\(\s*"([^"]*)$/u.exec(beforeCursor);
	if (!match) {
		return undefined;
	}

	const quoteStart = beforeCursor.lastIndexOf('"');
	if (quoteStart === -1) {
		return undefined;
	}

	const afterCursor = line.slice(position.character);
	const quoteEndOffset = afterCursor.indexOf('"');
	const rangeEnd = quoteEndOffset === -1 ? position.character : position.character + quoteEndOffset;
	return {
		prefix: match[1] ?? '',
		range: new vscode.Range(position.line, quoteStart + 1, position.line, rangeEnd),
	};
}

function diagnosticForReference(range: vscode.Range, resolution: HelidonConfigKeyResolution, key: string): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(
		range,
		resolution.pathIssue?.message ?? `Unknown Helidon configuration key '${key}'.`,
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = 'helidon-vsc';
	diagnostic.code = resolution.pathIssue?.code ?? 'unknown-config-key';
	return diagnostic;
}

export function collectHelidonJavaDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	if (document.languageId !== 'java') {
		return [];
	}

	const diagnostics: vscode.Diagnostic[] = [];
	for (const reference of referencesForDocument(document)) {
		if (!shouldValidateKnownHelidonConfigRoot(reference.key)) {
			continue;
		}

		const resolution = resolveHelidonConfigPropertyKey(reference.key);
		if (resolution.isKnown || resolution.isPrefix) {
			continue;
		}

		diagnostics.push(
			diagnosticForReference(
				new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end)),
				resolution,
				reference.key
			)
		);
	}

	return diagnostics;
}

async function workspaceConfigDocuments(): Promise<vscode.TextDocument[]> {
	const documents = new Map<string, vscode.TextDocument>();
	for (const document of vscode.workspace.textDocuments) {
		if (isHelidonPropertiesDocument(document) || isHelidonYamlDocument(document)) {
			documents.set(document.uri.toString(), document);
		}
	}

	for (const uri of await vscode.workspace.findFiles(CONFIG_FILE_GLOB, CONFIG_FILE_EXCLUDE_GLOB)) {
		if (documents.has(uri.toString())) {
			continue;
		}

		try {
			const document = await vscode.workspace.openTextDocument(uri);
			if (isHelidonPropertiesDocument(document) || isHelidonYamlDocument(document)) {
				documents.set(uri.toString(), document);
			}
		} catch {
			// ignore unreadable workspace config files
		}
	}

	return [...documents.values()];
}

async function findWorkspaceConfigLocations(key: string): Promise<vscode.Location[]> {
	const locations: vscode.Location[] = [];
	for (const document of await workspaceConfigDocuments()) {
		for (const range of findHelidonConfigKeyRanges(document, key)) {
			locations.push(new vscode.Location(document.uri, range));
		}
	}
	return locations;
}

function placeholderAtPosition(document: vscode.TextDocument, position: vscode.Position): { key: string; range: vscode.Range } | undefined {
	const line = document.lineAt(position.line).text;
	const lineRange = new vscode.Range(position.line, 0, position.line, line.length);
	const lineText = document.getText(lineRange);
	const pattern = /\$\{([^}:]+?)(?::([^}]*))?\}/gu;
	for (const match of lineText.matchAll(pattern)) {
		const key = match[1]?.trim();
		const matchIndex = match.index ?? -1;
		if (!key || matchIndex === -1) {
			continue;
		}

		const keyOffset = match[0].indexOf(key);
		const range = new vscode.Range(
			position.line,
			matchIndex + keyOffset,
			position.line,
			matchIndex + keyOffset + key.length
		);
		if (range.contains(position)) {
			return { key, range };
		}
	}

	return undefined;
}

export class HelidonJavaConfigCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		if (document.languageId !== 'java') {
			return undefined;
		}

		const context = completionContext(document, position);
		if (!context) {
			return undefined;
		}

		return HELIDON_CONFIG_PROPERTIES
			.filter((property) => !property.key.includes('.*'))
			.filter((property) => context.prefix.length === 0 || property.key.startsWith(context.prefix))
			.map((property) => {
				const item = new vscode.CompletionItem(property.key, vscode.CompletionItemKind.Property);
				item.detail = `Helidon configuration (${property.type})`;
				item.documentation = propertyMarkdown(property);
				item.insertText = property.key;
				item.sortText = property.key;
				item.range = context.range;
				return item;
			});
	}
}

export class HelidonJavaConfigHoverProvider implements vscode.HoverProvider {
	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
		const reference = referenceAtPosition(document, position);
		if (!reference) {
			return undefined;
		}

		const property = findHelidonConfigProperty(reference.key);
		if (!property) {
			return undefined;
		}

		return new vscode.Hover(
			propertyMarkdown(property),
			new vscode.Range(document.positionAt(reference.start), document.positionAt(reference.end))
		);
	}
}

export class HelidonJavaConfigDefinitionProvider implements vscode.DefinitionProvider {
	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Definition | undefined> {
		const reference = referenceAtPosition(document, position);
		if (!reference) {
			return undefined;
		}

		const locations = await findWorkspaceConfigLocations(reference.key);
		return locations.length > 0 ? locations : undefined;
	}
}

export class HelidonConfigPlaceholderDefinitionProvider implements vscode.DefinitionProvider {
	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
	): Promise<vscode.Definition | undefined> {
		if (!isHelidonPropertiesDocument(document) && !isHelidonYamlDocument(document)) {
			return undefined;
		}

		const reference = placeholderAtPosition(document, position);
		if (!reference) {
			return undefined;
		}

		const locations = await findWorkspaceConfigLocations(reference.key);
		return locations.length > 0 ? locations : undefined;
	}
}
