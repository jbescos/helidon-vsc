import * as vscode from 'vscode';
import { loadHelidonConfigMetadata } from './metadata';

export interface HelidonConfigProperty {
	key: string;
	type: string;
	defaultValue?: string;
	description: string;
	example?: string;
}

export const HELIDON_CONFIG_PROPERTIES: HelidonConfigProperty[] = loadHelidonConfigMetadata();

const HELIDON_CONFIG_PROPERTY_MAP = new Map(
	HELIDON_CONFIG_PROPERTIES.map((property) => [property.key, property] as const)
);
const NORMALIZED_HELIDON_CONFIG_KEYS = new Set(
	HELIDON_CONFIG_PROPERTIES.map((property) => normalizeConfigKey(property.key))
);
const NORMALIZED_HELIDON_CONFIG_PREFIXES = new Set(
	HELIDON_CONFIG_PROPERTIES.flatMap((property) => configKeyPrefixes(property.key))
);
const HELIDON_CONFIG_ROOTS = new Set(
	HELIDON_CONFIG_PROPERTIES.map((property) => normalizeConfigKey(property.key).split('.')[0])
);
const YAML_KEY_SEGMENT_PATTERN = /[A-Za-z0-9_-]+/;

interface ConfigKeyDiagnosticTarget {
	key: string;
	range: vscode.Range;
}

interface YamlPathEntry {
	indent: number;
	key: string;
}

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

export function findHelidonConfigProperty(key: string): HelidonConfigProperty | undefined {
	return HELIDON_CONFIG_PROPERTY_MAP.get(key);
}

function normalizeConfigSegment(segment: string): string {
	if (/^\d+$/.test(segment)) {
		return '0';
	}

	return segment.replace(/-\d+$/u, '-0');
}

function normalizeConfigKey(key: string): string {
	return key
		.split('.')
		.filter((segment) => segment.length > 0)
		.map(normalizeConfigSegment)
		.join('.');
}

function configKeyPrefixes(key: string): string[] {
	const segments = normalizeConfigKey(key).split('.');
	return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('.'));
}

function shouldValidateHelidonConfigKey(key: string): boolean {
	const [root] = normalizeConfigKey(key).split('.');
	return Boolean(root) && HELIDON_CONFIG_ROOTS.has(root);
}

function isKnownHelidonConfigKey(key: string): boolean {
	const normalizedKey = normalizeConfigKey(key);
	return (
		NORMALIZED_HELIDON_CONFIG_KEYS.has(normalizedKey) ||
		NORMALIZED_HELIDON_CONFIG_PREFIXES.has(normalizedKey)
	);
}

function unknownHelidonConfigDiagnostic(target: ConfigKeyDiagnosticTarget): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(
		target.range,
		`Unknown Helidon configuration key '${target.key}'.`,
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = 'helidon-vsc';
	diagnostic.code = 'unknown-config-key';
	return diagnostic;
}

function toYamlPathSegments(key: string): string[] {
	return key.split('.');
}

function isYamlLanguage(languageId: string): boolean {
	return languageId === 'yaml';
}

export function isHelidonYamlDocument(document: vscode.TextDocument): boolean {
	if (!isYamlLanguage(document.languageId)) {
		return false;
	}

	const fileName = document.fileName.toLowerCase();
	return fileName.endsWith('application.yaml') || fileName.endsWith('application.yml');
}

function yamlIndent(text: string): number {
	const match = text.match(/^(\s*)/);
	return match ? match[1].length : 0;
}

function yamlKeyRange(document: vscode.TextDocument, lineIndex: number, key: string): vscode.Range {
	const line = document.lineAt(lineIndex).text;
	const keyStart = line.indexOf(key);
	return new vscode.Range(lineIndex, keyStart, lineIndex, keyStart + key.length);
}

function parseYamlKey(trimmedLine: string): { key: string; remainder: string } | undefined {
	const keyMatch =
		/^"([^"]+)":\s*(.*)$/.exec(trimmedLine) ||
		/^'([^']+)':\s*(.*)$/.exec(trimmedLine) ||
		/^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmedLine);

	if (!keyMatch) {
		return undefined;
	}

	return { key: keyMatch[1], remainder: keyMatch[2] ?? '' };
}

function yamlKeyEntries(document: vscode.TextDocument): ConfigKeyDiagnosticTarget[] {
	const entries: ConfigKeyDiagnosticTarget[] = [];
	const stack: YamlPathEntry[] = [];

	for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
		const line = document.lineAt(lineIndex).text;
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}

		const indent = yamlIndent(line);
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}

		if (trimmed.startsWith('- ')) {
			stack.push({ indent, key: '0' });
			const parsedListKey = parseYamlKey(trimmed.slice(2).trimStart());
			if (!parsedListKey) {
				continue;
			}

			const { key, remainder } = parsedListKey;
			const path = [...stack.map((entry) => entry.key), key].join('.');
			entries.push({ key: path, range: yamlKeyRange(document, lineIndex, key) });
			if (remainder.length === 0 || remainder.startsWith('#')) {
				stack.push({ indent, key });
			}
			continue;
		}

		const parsedKey = parseYamlKey(trimmed);
		if (!parsedKey) {
			continue;
		}

		const { key, remainder } = parsedKey;
		const path = [...stack.map((entry) => entry.key), key].join('.');
		entries.push({ key: path, range: yamlKeyRange(document, lineIndex, key) });
		if (remainder.length === 0 || remainder.startsWith('#')) {
			stack.push({ indent, key });
		}
	}

	return entries;
}

function currentYamlPath(document: vscode.TextDocument, position: vscode.Position): string[] {
	const segments: string[] = [];
	const stack: Array<{ indent: number; key: string }> = [];

	for (let lineIndex = 0; lineIndex <= position.line; lineIndex++) {
		const line = document.lineAt(lineIndex).text;
		const trimmed = line.trim();

		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}

		const parsedKey = parseYamlKey(trimmed);
		if (!parsedKey) {
			continue;
		}

		const indent = yamlIndent(line);
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop();
		}

		stack.push({ indent, key: parsedKey.key });
	}

	for (const item of stack) {
		segments.push(item.key);
	}

	const currentLine = document.lineAt(position.line).text;
	const beforeCursor = currentLine.slice(0, position.character);
	const partialKeyMatch = /([A-Za-z0-9_-]*)$/.exec(beforeCursor);
	const partialKey = partialKeyMatch?.[1] ?? '';

	if (currentLine.trim().startsWith(partialKey) && segments.length > 0) {
		segments.pop();
	}

	if (partialKey.length > 0) {
		segments.push(partialKey);
	}

	return segments;
}

function nextYamlSegmentSuggestions(pathSegments: string[]): HelidonConfigProperty[] {
	const prefix = pathSegments.join('.');
	const normalizedPrefix = prefix.length > 0 ? `${prefix}.` : '';

	return HELIDON_CONFIG_PROPERTIES.filter((property) => {
		if (prefix.length === 0) {
			return true;
		}

		return property.key === prefix || property.key.startsWith(normalizedPrefix);
		});
}

function yamlCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
	const pathSegments = currentYamlPath(document, position);
	const parentSegments = pathSegments.slice(0, -1);
	const partialSegment = pathSegments[pathSegments.length - 1] ?? '';
	const parentPrefix = parentSegments.join('.');

	const suggestions = new Map<string, HelidonConfigProperty>();
	for (const property of nextYamlSegmentSuggestions(parentSegments)) {
		const segments = toYamlPathSegments(property.key);
		const nextSegment = segments[parentSegments.length];
		if (!nextSegment || !nextSegment.startsWith(partialSegment)) {
			continue;
		}

		if (!suggestions.has(nextSegment)) {
			suggestions.set(nextSegment, property);
		}
	}

	const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_-]+/);

	return [...suggestions.entries()].map(([segment, property]) => {
		const item = new vscode.CompletionItem(segment, vscode.CompletionItemKind.Property);
		const fullKey = parentPrefix ? `${parentPrefix}.${segment}` : segment;
		item.detail = `Helidon YAML key (${fullKey})`;
		item.documentation = propertyMarkdown(property);
		item.insertText = segment;
		item.sortText = fullKey;
		if (keyRange) {
			item.range = keyRange;
		}
		return item;
	});
}

function hoverForYaml(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
	const keyRange = document.getWordRangeAtPosition(position, YAML_KEY_SEGMENT_PATTERN);
	if (!keyRange) {
		return undefined;
	}

	const yamlEntry = yamlKeyEntries(document).find(
		(entry) => entry.range.start.line === position.line && entry.range.contains(position)
	);
	if (!yamlEntry || yamlEntry.range.start.character !== keyRange.start.character) {
		return undefined;
	}

	const property = findHelidonConfigProperty(normalizeConfigKey(yamlEntry.key));
	if (!property) {
		return undefined;
	}

	return new vscode.Hover(propertyMarkdown(property), keyRange);
}

export function isHelidonPropertiesDocument(document: vscode.TextDocument): boolean {
	if (document.languageId !== 'properties') {
		return false;
	}

	const fileName = document.fileName.toLowerCase();
	return fileName.endsWith('application.properties');
}

export function collectHelidonPropertiesDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	if (document.languageId !== 'properties') {
		return [];
	}

	const diagnostics: vscode.Diagnostic[] = [];

	for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
		const line = document.lineAt(lineIndex).text;
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) {
			continue;
		}

		const keyMatch = /^\s*([A-Za-z0-9._-]+)\s*[:=]/.exec(line);
		if (!keyMatch) {
			continue;
		}

		const key = keyMatch[1];
		if (!shouldValidateHelidonConfigKey(key) || isKnownHelidonConfigKey(key)) {
			continue;
		}

		const keyStart = line.indexOf(key);
		const range = new vscode.Range(lineIndex, keyStart, lineIndex, keyStart + key.length);
		diagnostics.push(unknownHelidonConfigDiagnostic({ key, range }));
	}

	return diagnostics;
}

export function collectHelidonYamlDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	if (!isYamlLanguage(document.languageId)) {
		return [];
	}

	return yamlKeyEntries(document)
		.filter((entry) => shouldValidateHelidonConfigKey(entry.key) && !isKnownHelidonConfigKey(entry.key))
		.map(unknownHelidonConfigDiagnostic);
}

export function collectHelidonDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	if (isHelidonPropertiesDocument(document)) {
		return collectHelidonPropertiesDiagnostics(document);
	}

	if (isHelidonYamlDocument(document)) {
		return collectHelidonYamlDiagnostics(document);
	}

	return [];
}

export class HelidonPropertiesCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		if (!isHelidonPropertiesDocument(document)) {
			return undefined;
		}

		const line = document.lineAt(position).text;
		const beforeCursor = line.slice(0, position.character);

		if (beforeCursor.trimStart().startsWith('#') || beforeCursor.includes('=')) {
			return undefined;
		}

		const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9._-]+/);
		const currentPrefix = keyRange ? document.getText(keyRange) : beforeCursor.trim();

		return HELIDON_CONFIG_PROPERTIES
			.filter((property) => currentPrefix.length === 0 || property.key.startsWith(currentPrefix))
			.map((property) => {
				const item = new vscode.CompletionItem(property.key, vscode.CompletionItemKind.Property);
				item.detail = `Helidon configuration (${property.type})`;
				item.documentation = propertyMarkdown(property);
				item.insertText = property.key;
				item.sortText = property.key;
				if (keyRange) {
					item.range = keyRange;
				}
				return item;
			});
	}
}

export class HelidonYamlCompletionProvider implements vscode.CompletionItemProvider {
	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		if (!isHelidonYamlDocument(document)) {
			return undefined;
		}

		return yamlCompletionItems(document, position);
	}
}

export class HelidonPropertiesHoverProvider implements vscode.HoverProvider {
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.Hover> {
		if (isHelidonYamlDocument(document)) {
			return hoverForYaml(document, position);
		}

		if (!isHelidonPropertiesDocument(document)) {
			return undefined;
		}

		const keyRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9._-]+/);
		if (!keyRange) {
			return undefined;
		}

		const key = document.getText(keyRange);
		const property = findHelidonConfigProperty(key);
		if (!property) {
			return undefined;
		}

		return new vscode.Hover(propertyMarkdown(property), keyRange);
	}
}
