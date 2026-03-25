import * as vscode from 'vscode';
import { HelidonConfigProperty } from './metadata';

export const HELIDON_CONFIG_PROPERTIES: HelidonConfigProperty[] = [];

let helidonConfigPropertyMap = new Map<string, HelidonConfigProperty>();
let normalizedHelidonConfigKeys = new Set<string>();
let normalizedHelidonConfigPrefixes = new Set<string>();
let helidonConfigRoots = new Set<string>();
const YAML_KEY_SEGMENT_PATTERN = /[A-Za-z0-9_-]+/;

interface ConfigKeyDiagnosticTarget {
	key: string;
	range: vscode.Range;
}

interface YamlPathEntry {
	indent: number;
	path: string;
}

interface YamlDiagnosticEntry extends ConfigKeyDiagnosticTarget {
	parentPath: string;
	keySegment: string;
}

interface IndexedKeyDiagnostic {
	code: string;
	message: string;
	start: number;
	end: number;
}

interface IndexedKeyAnalysis {
	normalizedKey: string;
	diagnostic?: IndexedKeyDiagnostic;
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

function rebuildHelidonConfigIndexes(properties: readonly HelidonConfigProperty[]): void {
	helidonConfigPropertyMap = new Map(properties.map((property) => [property.key, property] as const));
	normalizedHelidonConfigKeys = new Set(properties.map((property) => normalizeConfigKey(property.key)));
	normalizedHelidonConfigPrefixes = new Set(properties.flatMap((property) => configKeyPrefixes(property.key)));
	helidonConfigRoots = new Set(properties.map((property) => normalizeConfigKey(property.key).split('.')[0]));
}

export function replaceHelidonConfigProperties(properties: readonly HelidonConfigProperty[]): void {
	HELIDON_CONFIG_PROPERTIES.splice(0, HELIDON_CONFIG_PROPERTIES.length, ...properties);
	rebuildHelidonConfigIndexes(HELIDON_CONFIG_PROPERTIES);
}

export function findHelidonConfigProperty(key: string): HelidonConfigProperty | undefined {
	return helidonConfigPropertyMap.get(key);
}

function normalizeConfigSegment(segment: string): string {
	if (/^\d+$/.test(segment)) {
		return '0';
	}

	return segment.replace(/-\d+$/u, '-0');
}

function expandIndexedConfigSegments(segment: string): string[] {
	const match = /^([A-Za-z0-9_-]+)((?:\[\d+\])*)$/u.exec(segment);
	if (!match) {
		return [segment];
	}

	const [, baseSegment, bracketGroups] = match;
	const segments = [baseSegment];
	for (const bracketMatch of bracketGroups.matchAll(/\[(\d+)\]/gu)) {
		segments.push(bracketMatch[1]);
	}

	return segments;
}

function normalizeConfigKey(key: string): string {
	return key
		.split('.')
		.flatMap(expandIndexedConfigSegments)
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
	return Boolean(root) && helidonConfigRoots.has(root);
}

function isKnownHelidonConfigKey(key: string): boolean {
	const normalizedKey = normalizeConfigKey(key);
	return (
		normalizedHelidonConfigKeys.has(normalizedKey) ||
		normalizedHelidonConfigPrefixes.has(normalizedKey)
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

function indexedKeyDiagnostic(
	lineIndex: number,
	lineOffset: number,
	diagnostic: IndexedKeyDiagnostic,
): vscode.Diagnostic {
	const issue = new vscode.Diagnostic(
		new vscode.Range(lineIndex, lineOffset + diagnostic.start, lineIndex, lineOffset + diagnostic.end),
		diagnostic.message,
		vscode.DiagnosticSeverity.Warning
	);
	issue.source = 'helidon-vsc';
	issue.code = diagnostic.code;
	return issue;
}

function duplicateYamlKeyDiagnostic(target: ConfigKeyDiagnosticTarget): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(
		target.range,
		`Duplicate YAML key '${target.key}'.`,
		vscode.DiagnosticSeverity.Warning
	);
	diagnostic.source = 'helidon-vsc';
	diagnostic.code = 'duplicate-yaml-key';
	return diagnostic;
}

function analyzeIndexedConfigKey(key: string): IndexedKeyAnalysis {
	const normalizedSegments: string[] = [];
	let currentSegment = '';
	let index = 0;

	while (index < key.length) {
		const character = key[index];
		if (character === '.') {
			if (currentSegment.length > 0) {
				normalizedSegments.push(currentSegment);
				currentSegment = '';
			}
			index += 1;
			continue;
		}

		if (character === '[') {
			const closingIndex = key.indexOf(']', index + 1);
			if (closingIndex === -1) {
				return {
					normalizedKey: normalizedSegments.join('.'),
					diagnostic: {
						code: 'indexed-key-missing-closing-bracket',
						message: "Indexed Helidon configuration key is missing a closing ']'.",
						start: index,
						end: key.length,
					},
				};
			}

			const bracketValue = key.slice(index + 1, closingIndex);
			if (bracketValue.length === 0) {
				return {
					normalizedKey: normalizedSegments.join('.'),
					diagnostic: {
						code: 'indexed-key-missing-value',
						message: 'Indexed Helidon configuration key is missing an index value.',
						start: index,
						end: closingIndex + 1,
					},
				};
			}

			if (!/^\d+$/u.test(bracketValue)) {
				return {
					normalizedKey: normalizedSegments.join('.'),
					diagnostic: {
						code: 'indexed-key-non-integer',
						message: 'Indexed Helidon configuration key index must be an integer.',
						start: index,
						end: closingIndex + 1,
					},
				};
			}

			if (currentSegment.length > 0) {
				normalizedSegments.push(currentSegment);
				currentSegment = '';
			}
			normalizedSegments.push(bracketValue);
			index = closingIndex + 1;
			continue;
		}

		currentSegment += character;
		index += 1;
	}

	if (currentSegment.length > 0) {
		normalizedSegments.push(currentSegment);
	}

	return {
		normalizedKey: normalizedSegments.join('.'),
	};
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
	return (
		fileName.endsWith('application.yaml') ||
		fileName.endsWith('application.yml')
	);
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

function yamlKeyEntries(document: vscode.TextDocument): YamlDiagnosticEntry[] {
	const entries: YamlDiagnosticEntry[] = [];
	const stack: YamlPathEntry[] = [];
	const sequenceItemIndexes = new Map<string, number>();

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

		const parentPath = stack[stack.length - 1]?.path ?? '';

		if (trimmed.startsWith('- ')) {
			const sequenceKey = `${parentPath}@@${indent}`;
			const sequenceIndex = sequenceItemIndexes.get(sequenceKey) ?? 0;
			sequenceItemIndexes.set(sequenceKey, sequenceIndex + 1);
			const itemPath = parentPath ? `${parentPath}.${sequenceIndex}` : `${sequenceIndex}`;
			stack.push({ indent, path: itemPath });
			const parsedListKey = parseYamlKey(trimmed.slice(2).trimStart());
			if (!parsedListKey) {
				continue;
			}

			const { key, remainder } = parsedListKey;
			const path = `${itemPath}.${key}`;
			entries.push({
				key: path,
				range: yamlKeyRange(document, lineIndex, key),
				parentPath: itemPath,
				keySegment: key,
			});
			if (remainder.length === 0 || remainder.startsWith('#')) {
				stack.push({ indent, path });
			}
			continue;
		}

		const parsedKey = parseYamlKey(trimmed);
		if (!parsedKey) {
			continue;
		}

		const { key, remainder } = parsedKey;
		const path = parentPath ? `${parentPath}.${key}` : key;
		entries.push({
			key: path,
			range: yamlKeyRange(document, lineIndex, key),
			parentPath,
			keySegment: key,
		});
		if (remainder.length === 0 || remainder.startsWith('#')) {
			stack.push({ indent, path });
		}
	}

	return entries;
}

function collectDuplicateYamlKeyDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	const diagnostics: vscode.Diagnostic[] = [];
	const seenKeys = new Set<string>();

	for (const entry of yamlKeyEntries(document)) {
		const duplicateKey = `${entry.parentPath}\u0000${entry.keySegment}`;
		if (seenKeys.has(duplicateKey)) {
			diagnostics.push(duplicateYamlKeyDiagnostic({ key: entry.keySegment, range: entry.range }));
			continue;
		}

		seenKeys.add(duplicateKey);
	}

	return diagnostics;
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
	const fileName = document.fileName.toLowerCase();
	return (
		fileName.endsWith('application.properties') ||
		fileName.endsWith('microprofile-config.properties')
	);
}

export function collectHelidonPropertiesDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	if (!isHelidonPropertiesDocument(document)) {
		return [];
	}

	const diagnostics: vscode.Diagnostic[] = [];

	for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
		const line = document.lineAt(lineIndex).text;
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) {
			continue;
		}

		const keyMatch = /^\s*([A-Za-z0-9._\-[\]]+)\s*[:=]/u.exec(line);
		if (!keyMatch) {
			continue;
		}

		const key = keyMatch[1];
		const analyzedKey = analyzeIndexedConfigKey(key);
		if (analyzedKey.diagnostic) {
			if (!shouldValidateHelidonConfigKey(analyzedKey.normalizedKey || key)) {
				continue;
			}

			const keyStart = line.indexOf(key);
			diagnostics.push(indexedKeyDiagnostic(lineIndex, keyStart, analyzedKey.diagnostic));
			continue;
		}

		if (!shouldValidateHelidonConfigKey(analyzedKey.normalizedKey) || isKnownHelidonConfigKey(analyzedKey.normalizedKey)) {
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

	return [
		...collectDuplicateYamlKeyDiagnostics(document),
		...yamlKeyEntries(document)
		.filter((entry) => shouldValidateHelidonConfigKey(entry.key) && !isKnownHelidonConfigKey(entry.key))
		.map(unknownHelidonConfigDiagnostic),
	];
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
