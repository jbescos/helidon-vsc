import * as vscode from 'vscode';
import { HelidonConfigProperty } from './metadata';

export const HELIDON_CONFIG_PROPERTIES: HelidonConfigProperty[] = [];

let helidonConfigPropertyMap = new Map<string, HelidonConfigProperty>();
let normalizedHelidonConfigKeys = new Set<string>();
let normalizedHelidonConfigPrefixes = new Set<string>();
let helidonConfigRoots = new Set<string>();
let normalizedHelidonConfigKeyMap = new Map<string, string[]>();
let normalizedHelidonConfigPropertyByKey = new Map<string, HelidonConfigProperty>();
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
	value?: string;
	valueRange?: vscode.Range;
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

interface PathValidationIssue {
	code: string;
	message: string;
}

interface ValueValidationIssue {
	code: string;
	message: string;
}

interface ParsedPropertiesAssignment {
	key: string;
	keyRange: vscode.Range;
	value: string;
	valueRange?: vscode.Range;
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
	normalizedHelidonConfigKeyMap = new Map<string, string[]>();
	normalizedHelidonConfigPropertyByKey = new Map<string, HelidonConfigProperty>();
	for (const property of properties) {
		const normalizedKey = normalizeConfigKey(property.key);
		const keys = normalizedHelidonConfigKeyMap.get(normalizedKey) ?? [];
		keys.push(property.key);
		normalizedHelidonConfigKeyMap.set(normalizedKey, keys);
		if (!normalizedHelidonConfigPropertyByKey.has(normalizedKey)) {
			normalizedHelidonConfigPropertyByKey.set(normalizedKey, property);
		}
	}
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

function pathValidationDiagnostic(target: ConfigKeyDiagnosticTarget, issue: PathValidationIssue): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(target.range, issue.message, vscode.DiagnosticSeverity.Warning);
	diagnostic.source = 'helidon-vsc';
	diagnostic.code = issue.code;
	return diagnostic;
}

function valueValidationDiagnostic(
	range: vscode.Range,
	issue: ValueValidationIssue,
): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Warning);
	diagnostic.source = 'helidon-vsc';
	diagnostic.code = issue.code;
	return diagnostic;
}

function levenshteinDistance(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	if (left.length === 0) {
		return right.length;
	}

	if (right.length === 0) {
		return left.length;
	}

	const previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
	const currentRow = new Array<number>(right.length + 1);

	for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
		currentRow[0] = leftIndex + 1;
		for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
			const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1;
			currentRow[rightIndex + 1] = Math.min(
				currentRow[rightIndex] + 1,
				previousRow[rightIndex + 1] + 1,
				previousRow[rightIndex] + substitutionCost
			);
		}

		for (let index = 0; index < currentRow.length; index++) {
			previousRow[index] = currentRow[index];
		}
	}

	return previousRow[right.length];
}

function similarityThreshold(key: string): number {
	if (key.length <= 4) {
		return 1;
	}

	if (key.length <= 12) {
		return 2;
	}

	return 3;
}

function preferredKeyForNormalizedKey(normalizedKey: string): string | undefined {
	const keys = normalizedHelidonConfigKeyMap.get(normalizedKey);
	if (!keys || keys.length === 0) {
		return undefined;
	}

	return keys[0];
}

function propertyForNormalizedKey(key: string): HelidonConfigProperty | undefined {
	return normalizedHelidonConfigPropertyByKey.get(normalizeConfigKey(key));
}

function isListProperty(property: HelidonConfigProperty): boolean {
	return property.kind === 'LIST' || property.type.startsWith('list<');
}

function isMapProperty(property: HelidonConfigProperty): boolean {
	return property.kind === 'MAP';
}

function isScalarProperty(property: HelidonConfigProperty): boolean {
	return !isListProperty(property) && !isMapProperty(property);
}

function suggestHelidonConfigKey(key: string): string | undefined {
	const normalizedKey = normalizeConfigKey(key);
	const root = normalizedKey.split('.')[0];
	if (!root || !helidonConfigRoots.has(root)) {
		return undefined;
	}

	let bestMatch: { key: string; score: number } | undefined;
	for (const [candidateNormalizedKey, candidateKeys] of normalizedHelidonConfigKeyMap.entries()) {
		if (candidateNormalizedKey.split('.')[0] !== root) {
			continue;
		}

		const distance = levenshteinDistance(normalizedKey, candidateNormalizedKey);
		const segmentDelta = Math.abs(normalizedKey.split('.').length - candidateNormalizedKey.split('.').length);
		const score = distance + segmentDelta;
		if (
			bestMatch &&
			(score > bestMatch.score || (score === bestMatch.score && candidateNormalizedKey.length >= bestMatch.key.length))
		) {
			continue;
		}

		bestMatch = { key: candidateKeys[0], score };
	}

	if (!bestMatch || bestMatch.score > similarityThreshold(normalizedKey)) {
		return undefined;
	}

	return bestMatch.key;
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

function pathValidationIssueForKey(key: string): PathValidationIssue | undefined {
	const normalizedKey = normalizeConfigKey(key);
	const segments = normalizedKey.split('.').filter((segment) => segment.length > 0);
	if (segments.length < 2) {
		return undefined;
	}

	for (let index = 1; index < segments.length; index++) {
		const prefix = segments.slice(0, index).join('.');
		const property = propertyForNormalizedKey(prefix);
		if (!property) {
			continue;
		}

		const preferredKey = preferredKeyForNormalizedKey(prefix) ?? prefix;
		const nextSegment = segments[index];
		if (isListProperty(property) && nextSegment !== '0') {
			return {
				code: 'list-property-missing-index',
				message: `Helidon configuration list '${preferredKey}' requires an index before nested keys.`,
			};
		}

		if (!isMapProperty(property) && !isListProperty(property) && !normalizedHelidonConfigPrefixes.has(prefix)) {
			return {
				code: 'nested-key-under-scalar-property',
				message: `Helidon configuration key '${preferredKey}' does not support nested keys.`,
			};
		}
	}

	return undefined;
}

function unknownKeyFromDiagnostic(diagnostic: vscode.Diagnostic): string | undefined {
	if (typeof diagnostic.code !== 'string' || diagnostic.code !== 'unknown-config-key') {
		return undefined;
	}

	const match = /^Unknown Helidon configuration key '(.+)'\.$/u.exec(diagnostic.message);
	return match?.[1];
}

function normalizedScalarValue(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}

	return trimmed;
}

function valueValidationIssueForProperty(
	property: HelidonConfigProperty,
	value: string,
): ValueValidationIssue | undefined {
	const normalizedValue = normalizedScalarValue(value);
	if (normalizedValue.length === 0 || !isScalarProperty(property)) {
		return undefined;
	}

	switch (property.type) {
		case 'java.lang.Boolean':
			if (/^(true|false)$/iu.test(normalizedValue)) {
				return undefined;
			}

			return {
				code: 'invalid-boolean-value',
				message: `Helidon configuration value for '${property.key}' must be 'true' or 'false'.`,
			};
		case 'java.lang.Integer':
		case 'java.lang.Long':
			if (/^[+-]?\d+$/u.test(normalizedValue)) {
				return undefined;
			}

			return {
				code: 'invalid-integer-value',
				message: `Helidon configuration value for '${property.key}' must be an integer.`,
			};
		default:
			return undefined;
	}
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

function yamlScalarValue(
	document: vscode.TextDocument,
	lineIndex: number,
	keyRange: vscode.Range,
): { value: string; range: vscode.Range } | undefined {
	const line = document.lineAt(lineIndex).text;
	const colonIndex = line.indexOf(':', keyRange.end.character);
	if (colonIndex === -1) {
		return undefined;
	}

	let valueStart = colonIndex + 1;
	while (valueStart < line.length && /\s/u.test(line[valueStart])) {
		valueStart += 1;
	}

	if (valueStart >= line.length) {
		return undefined;
	}

	const valueText = line.slice(valueStart).trimEnd();
	if (
		valueText.length === 0 ||
		valueText.startsWith('#') ||
		valueText === '|' ||
		valueText === '>' ||
		valueText.startsWith('{') ||
		valueText.startsWith('[')
	) {
		return undefined;
	}

	return {
		value: valueText,
		range: new vscode.Range(lineIndex, valueStart, lineIndex, valueStart + valueText.length),
	};
}

function parsePropertiesAssignment(
	document: vscode.TextDocument,
	lineIndex: number,
): ParsedPropertiesAssignment | undefined {
	const line = document.lineAt(lineIndex).text;
	const match = /^\s*([A-Za-z0-9._\-[\]]+)\s*[:=](.*)$/u.exec(line);
	if (!match) {
		return undefined;
	}

	const key = match[1];
	const keyStart = line.indexOf(key);
	const keyRange = new vscode.Range(lineIndex, keyStart, lineIndex, keyStart + key.length);
	const rawValue = match[2];
	const valueStartOffset = rawValue.search(/\S/u);
	if (valueStartOffset === -1) {
		return {
			key,
			keyRange,
			value: '',
		};
	}

	const value = rawValue.slice(valueStartOffset).trimEnd();
	const valueStart = line.length - rawValue.length + valueStartOffset;

	return {
		key,
		keyRange,
		value,
		valueRange: new vscode.Range(lineIndex, valueStart, lineIndex, valueStart + value.length),
	};
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
			const range = yamlKeyRange(document, lineIndex, key);
			const scalarValue = yamlScalarValue(document, lineIndex, range);
			entries.push({
				key: path,
				range,
				parentPath: itemPath,
				keySegment: key,
				value: scalarValue?.value,
				valueRange: scalarValue?.range,
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
		const range = yamlKeyRange(document, lineIndex, key);
		const scalarValue = yamlScalarValue(document, lineIndex, range);
		entries.push({
			key: path,
			range,
			parentPath,
			keySegment: key,
			value: scalarValue?.value,
			valueRange: scalarValue?.range,
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

function yamlBlockRemovalRange(document: vscode.TextDocument, lineIndex: number): vscode.Range {
	const start = new vscode.Position(lineIndex, 0);
	const currentIndent = yamlIndent(document.lineAt(lineIndex).text);
	let endLineIndex = lineIndex + 1;

	while (endLineIndex < document.lineCount) {
		const line = document.lineAt(endLineIndex).text;
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			endLineIndex += 1;
			continue;
		}

		if (yamlIndent(line) > currentIndent) {
			endLineIndex += 1;
			continue;
		}

		break;
	}

	if (endLineIndex < document.lineCount) {
		return new vscode.Range(start, new vscode.Position(endLineIndex, 0));
	}

	return new vscode.Range(start, document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end);
}

function createCodeAction(
	title: string,
	kind: vscode.CodeActionKind,
	document: vscode.TextDocument,
	edits: ReadonlyArray<{ range: vscode.Range; newText: string }>,
	diagnostic: vscode.Diagnostic,
): vscode.CodeAction {
	const action = new vscode.CodeAction(title, kind);
	action.diagnostics = [diagnostic];
	action.isPreferred = true;
	action.edit = new vscode.WorkspaceEdit();
	for (const edit of edits) {
		action.edit.replace(document.uri, edit.range, edit.newText);
	}
	return action;
}

function codeActionsForIndexedDiagnostic(
	document: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
): vscode.CodeAction[] {
	if (typeof diagnostic.code !== 'string') {
		return [];
	}

	switch (diagnostic.code) {
		case 'indexed-key-missing-closing-bracket':
			return [
				createCodeAction(
					"Insert closing ']'",
					vscode.CodeActionKind.QuickFix,
					document,
					[{ range: new vscode.Range(diagnostic.range.end, diagnostic.range.end), newText: ']' }],
					diagnostic
				),
			];
		case 'indexed-key-missing-value':
		case 'indexed-key-non-integer':
			return [
				createCodeAction(
					"Replace with '[0]'",
					vscode.CodeActionKind.QuickFix,
					document,
					[{ range: diagnostic.range, newText: '[0]' }],
					diagnostic
				),
			];
		default:
			return [];
	}
}

function codeActionsForDuplicateYamlKey(
	document: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
): vscode.CodeAction[] {
	if (typeof diagnostic.code !== 'string' || diagnostic.code !== 'duplicate-yaml-key') {
		return [];
	}

	return [
		createCodeAction(
			'Remove duplicate YAML key',
			vscode.CodeActionKind.QuickFix,
			document,
			[{ range: yamlBlockRemovalRange(document, diagnostic.range.start.line), newText: '' }],
			diagnostic
		),
	];
}

function codeActionsForUnknownKey(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction[] {
	const unknownKey = unknownKeyFromDiagnostic(diagnostic);
	if (!unknownKey) {
		return [];
	}

	const suggestion = suggestHelidonConfigKey(unknownKey);
	if (!suggestion || suggestion === unknownKey) {
		return [];
	}

	const replacement =
		isHelidonYamlDocument(document) && suggestion.includes('.')
			? suggestion.split('.').at(-1) ?? suggestion
			: suggestion;

	return [
		createCodeAction(
			`Change to '${replacement}'`,
			vscode.CodeActionKind.QuickFix,
			document,
			[{ range: diagnostic.range, newText: replacement }],
			diagnostic
		),
	];
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

		const assignment = parsePropertiesAssignment(document, lineIndex);
		if (!assignment) {
			continue;
		}

		const { key, keyRange, value, valueRange } = assignment;
		const analyzedKey = analyzeIndexedConfigKey(key);
		if (analyzedKey.diagnostic) {
			if (!shouldValidateHelidonConfigKey(analyzedKey.normalizedKey || key)) {
				continue;
			}

			diagnostics.push(
				indexedKeyDiagnostic(lineIndex, keyRange.start.character, analyzedKey.diagnostic)
			);
			continue;
		}

		if (!shouldValidateHelidonConfigKey(analyzedKey.normalizedKey)) {
			continue;
		}

		if (!isKnownHelidonConfigKey(analyzedKey.normalizedKey)) {
			const pathIssue = pathValidationIssueForKey(analyzedKey.normalizedKey);
			if (pathIssue) {
				diagnostics.push(pathValidationDiagnostic({ key, range: keyRange }, pathIssue));
				continue;
			}

			diagnostics.push(unknownHelidonConfigDiagnostic({ key, range: keyRange }));
			continue;
		}

		const property = propertyForNormalizedKey(analyzedKey.normalizedKey);
		if (!property || !valueRange) {
			continue;
		}

		const valueIssue = valueValidationIssueForProperty(property, value);
		if (valueIssue) {
			diagnostics.push(valueValidationDiagnostic(valueRange, valueIssue));
		}
	}

	return diagnostics;
}

export function collectHelidonYamlDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
	if (!isYamlLanguage(document.languageId)) {
		return [];
	}

	const diagnostics = [...collectDuplicateYamlKeyDiagnostics(document)];
	for (const entry of yamlKeyEntries(document)) {
		if (!shouldValidateHelidonConfigKey(entry.key)) {
			continue;
		}

		if (!isKnownHelidonConfigKey(entry.key)) {
			const pathIssue = pathValidationIssueForKey(entry.key);
			diagnostics.push(
				pathIssue ? pathValidationDiagnostic(entry, pathIssue) : unknownHelidonConfigDiagnostic(entry)
			);
			continue;
		}

		const property = propertyForNormalizedKey(entry.key);
		if (!property || !entry.valueRange || entry.value === undefined) {
			continue;
		}

		const valueIssue = valueValidationIssueForProperty(property, entry.value);
		if (valueIssue) {
			diagnostics.push(valueValidationDiagnostic(entry.valueRange, valueIssue));
		}
	}

	return diagnostics;
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

export class HelidonConfigCodeActionProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(
		document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
	): vscode.ProviderResult<vscode.CodeAction[]> {
		if (!isHelidonPropertiesDocument(document) && !isHelidonYamlDocument(document)) {
			return undefined;
		}

		return context.diagnostics.flatMap((diagnostic) => [
			...codeActionsForIndexedDiagnostic(document, diagnostic),
			...codeActionsForDuplicateYamlKey(document, diagnostic),
			...codeActionsForUnknownKey(document, diagnostic),
		]);
	}
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
